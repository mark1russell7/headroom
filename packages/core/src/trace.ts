/**
 * The trace of the process starts (H188): a name and a parent for each start. The sequence numbers of Windows give the
 * exact count of all the starts (H29), but no names. A read of the processes every 10 seconds misses most short processes.
 *
 * - On Windows, the daemon puts each process of the traced owners in a job object of its own, with a completion port. The
 *   children of a process go into its job, so Windows sends a message for each start and each exit in the tree.
 * - A reader thread takes the messages, reads the name and the parent of each new process, and keeps a handle until its
 *   exit. Thus it gets the exit code, also of a process that lives for 10 ms.
 * - This file has the part with no platform: the book that names and counts the starts. `trace-windows.ts` has the jobs.
 * - The jobs have no limit and do not stop their processes. A child can still break away, so `headroom run --detach` works.
 * - Windows refuses a job for a protected process and for a process of another user. The book counts the refusals.
 *
 * Each restart of the daemon puts one more job around a live process, because a job keeps the completion port of its first
 * daemon. Windows nests jobs, so the processes go on. The cost is one more job for Windows to update at each start in that
 * tree. The end of this limit: a later step gives the port to the next daemon at the restart.
 *
 * A job with no open handle sends no messages. Thus a daemon that stops with no clean stop leaves no packets in the kernel
 * memory. The measure of 2026-11-16: a job had a closed handle and an open port that nobody read. It got 1 packet for
 * 1,500 starts, and the pool tag "Icp " of the packets did not grow.
 */

import type { Lease } from "./broker.ts";
import type { Owners } from "./resources.ts";
import { holderOwner, type OwnerStarts, type ProcessStarts } from "./starts.ts";
import type { OwnerKind, ProcessInfo } from "./types.ts";

/** The exit code of a process that did not start: `STATUS_DLL_INIT_FAILED`. Windows gives it when the desktop heap is full. */
export const DLL_INIT_FAILED = 0xc000_0142;

/** One message of the trace. The reader gives them in batches, the oldest first. */
export type TraceEvent =
  /** A process started in the job `key`. The parent and the name are `null` when the process ended before the read. */
  | { readonly type: "start"; readonly key: number; readonly pid: number; readonly ppid: number | null; readonly name: string | null; readonly at: number }
  /** A process of the job `key` ended. The exit code is `null` when the reader did not hold a handle to the process. */
  | { readonly type: "exit"; readonly key: number; readonly pid: number; readonly exitCode: number | null; readonly at: number }
  /** The last process of the job `key` ended. The job gets no more processes. */
  | { readonly type: "empty"; readonly key: number; readonly at: number };

/** One batch of the reader thread of Windows (`trace-reader.ts`). The last batch has `stopped`. */
export interface TraceBatch {
  readonly events: readonly TraceEvent[];
  /** The processor time of the reader thread since its start, in ms. */
  readonly cpuMs: number;
  readonly stopped?: boolean | undefined;
}

/** The completion key of the packet that stops the reader thread. No job of the trace has it. */
export const TRACE_STOP_KEY = 0;

/** The platform part of the trace. On Windows it is a set of job objects with one completion port. A test gives a fake. */
export interface StartTrace {
  /**
   * This function puts a live process in a new job of the trace. Its next children go into the same job. It gives the
   * key of the job, or `null` when Windows refuses the process.
   */
  cover(pid: number): number | null;
  /** This function gives the messages that came since its last call, the oldest first. */
  drain(): readonly TraceEvent[];
  /** This function gives the processor time of the reader thread since its start, in ms: the cost of the trace. */
  cpuMs(): number;
  /** This function gives the count of the open jobs of the trace. */
  jobs(): number;
  /** This function gives the reason when the reader stopped with an error, or `null` while it runs. */
  failure(): string | null;
  /** This function stops the reader and closes the handles. The processes go on, and they stay in their jobs. */
  close(): void;
}

/** One source of starts: an owner, a parent program and the program that it starts. */
export interface StartSource {
  readonly owner: string;
  readonly kind: OwnerKind;
  /** The name of the parent program, for example `bash.exe`, or `?` when no read had the parent. */
  readonly parent: string;
  /** The name of the program that starts, for example `git.exe`, or `?` when the process ended before the read. */
  readonly name: string;
  /** The starts of the source in one minute, over the window. */
  readonly perMinute: number;
  /** The starts of the source that failed with 0xC0000142, in one minute. */
  readonly failedPerMinute: number;
}

/** The traced starts over the last 10 minutes. `ProcessStarts.traced` gives them. */
export interface TracedStarts {
  /** The traced starts in one minute. */
  readonly perMinute: number;
  /** The traced part of all the starts of the computer, from 0 to 1. It is `null` when the count of all the starts is not exact. */
  readonly coverage: number | null;
  /** The traced starts in one minute that failed with 0xC0000142 (`STATUS_DLL_INIT_FAILED`). */
  readonly failedPerMinute: number;
  /**
   * The sources with the most starts first. The list stops when its sources hold 90 % of the traced starts, at most at
   * `SOURCES_KEPT` sources.
   */
  readonly sources: readonly StartSource[];
  /** The part of the traced starts that `sources` holds, from 0 to 1. */
  readonly named: number;
  /** The time that the rates cover, at most 10 minutes. */
  readonly spanMs: number;
  /** The live processes in the trace. */
  readonly processes: number;
  /** The open jobs of the trace. */
  readonly jobs: number;
  /** The processes that Windows did not put in a job, for example a protected process. */
  readonly refused: number;
  /** The processor time of the reader in one minute, in ms: the cost of the trace itself. */
  readonly cpuMsPerMinute: number;
  /** The reason when the reader stopped with an error, or `null` while it runs. */
  readonly failure: string | null;
}

/** The owner kinds that the trace follows by default. The programs of Mark (browsers, editors) stay out of it. */
export const TRACED_KINDS: readonly OwnerKind[] = ["session", "mcp", "service", "docker"];
/** The owner kinds that the setting `startTrace` can name. The kernel has no processes to trace. */
export const TRACEABLE_KINDS: readonly OwnerKind[] = ["session", "mcp", "service", "docker", "browser", "editor", "system", "other"];

/**
 * This function reads the setting `startTrace`: `off`, or the owner kinds with commas, for example `session,mcp`. No
 * setting, or a value with a kind that is not traceable, gives the default `TRACED_KINDS`.
 */
export function traceKindsOf(value: string | undefined): readonly OwnerKind[] {
  if (value === undefined || value === "") return TRACED_KINDS;
  if (value === "off") return [];
  const kinds = value.split(",").map((each) => each.trim());
  if (!kinds.every((kind) => (TRACEABLE_KINDS as readonly string[]).includes(kind))) return TRACED_KINDS;
  return TRACEABLE_KINDS.filter((kind) => kinds.includes(kind));
}

/**
 * This function gives the stored value of the setting `startTrace`: `off` for no kinds, or the kinds with commas. It
 * refuses a kind that is not traceable.
 */
export function traceKindsText(kinds: readonly string[]): string {
  const bad = kinds.filter((kind) => !(TRACEABLE_KINDS as readonly string[]).includes(kind));
  if (bad.length > 0) throw new RangeError(`The start trace cannot follow the kind ${bad.join(", ")}. The kinds are ${TRACEABLE_KINDS.join(", ")}.`);
  return kinds.length === 0 ? "off" : TRACEABLE_KINDS.filter((kind) => kinds.includes(kind)).join(",");
}
/** The part of the traced starts that the sources of the alert must hold. */
export const NAMED_PART = 0.9;
/** The most sources in `TracedStarts.sources`. */
export const SOURCES_KEPT = 12;
/** The window of the rates. */
export const TRACE_WINDOW_MS: number = 10 * 60_000;
/** A process that started less than this time before a read can still have a start message that did not come. */
export const COVER_AFTER_MS = 5000;
/** The most processes that one read puts in new jobs, so the first read of a busy computer does not take long. */
export const COVERS_PER_READ = 200;

const MINUTE_MS = 60_000;
/** The length of one bucket of counts. */
const BUCKET_MS = 10_000;
/** The separator of the parts of the key of a source. No name of a program or an owner has it. */
const SEPARATOR = "\u0000";

/** This function rounds to one decimal. */
const round = (value: number): number => Math.round(value * 10) / 10;

/** A live process in the trace. */
interface Traced {
  readonly owner: string;
  readonly kind: OwnerKind;
  /** The id of the lease of the process, when the process is in a leased job. */
  readonly lease: string | null;
  readonly name: string;
  /** The key of the source of the start, or `null` for a process that the daemon put in a job. Its start is not traced. */
  readonly source: string | null;
  /** The time that the book got the process. */
  readonly at: number;
}

/** The counts of one source in one bucket. */
interface Counts {
  starts: number;
  failed: number;
}

/** The facts of the engine that decide the owner of a start. */
export interface TraceContext {
  /** The leases. The holder of a granted lease decides the owner of each start in its job (`holderOwner`). */
  readonly leases: readonly Lease[];
  /** The kind of each owner. */
  readonly kindOf: ReadonlyMap<string, OwnerKind>;
  /** The processes of the last read. They give the name of a parent that is not in the trace. */
  readonly processes: readonly ProcessInfo[];
}

/** One root: a live process that the daemon put in a job. */
export interface TraceRoot {
  readonly pid: number;
  readonly name: string;
  readonly owner: string;
  readonly kind: OwnerKind;
  /** The id of the lease of the process, or `null`. */
  readonly lease: string | null;
}

/** One process to put in a new job: its root, and its start for a refusal. */
export interface TraceCover {
  readonly root: TraceRoot;
  readonly startedAt: number | undefined;
}

/** The facts of one read for `traceCovers`. */
export interface CoverInput {
  readonly processes: readonly ProcessInfo[];
  readonly owners: Owners;
  readonly leases: readonly Lease[];
  /** The owner kinds of the setting `startTrace`. */
  readonly kinds: readonly OwnerKind[];
  /** The ID of the daemon. The daemon does not trace itself. */
  readonly self: number;
  readonly now: number;
}

/**
 * This function gives the processes that a read puts in new jobs. Each is a live process of a traced kind or under a
 * granted lease. It is not in the trace, and Windows did not refuse it. A process must be older than `COVER_AFTER_MS`, because
 * the message of its start in the job of its parent can still come. The leased processes come first, then the oldest, at
 * most `COVERS_PER_READ`.
 */
export function traceCovers(book: TraceBook, input: CoverInput): TraceCover[] {
  if (input.kinds.length === 0) return [];
  const byId = new Map(input.leases.map((lease) => [lease.id, lease]));
  const covers: (TraceCover & { readonly leased: boolean })[] = [];
  for (const info of input.processes) {
    if (info.pid <= 4 || info.pid === input.self || book.covers(info.pid) || book.refused(info.pid, info.startedAt)) continue;
    if (info.startedAt !== undefined && input.now - info.startedAt < COVER_AFTER_MS) continue;
    const leaseId = input.owners.leaseOf.get(info.pid);
    const lease = leaseId === undefined ? undefined : byId.get(leaseId);
    const tree = input.owners.ownerOf.get(info.pid) ?? "other";
    const treeKind = input.owners.kindOf.get(tree) ?? "other";
    if (lease === undefined && !input.kinds.includes(treeKind)) continue;
    const { owner, kind } = lease === undefined ? { owner: tree, kind: treeKind } : holderOwner(lease.holder, input.owners.kindOf);
    covers.push({ root: { pid: info.pid, name: info.name, owner, kind, lease: lease?.id ?? null }, startedAt: info.startedAt, leased: lease !== undefined });
  }
  return covers
    .sort((a, b) => Number(b.leased) - Number(a.leased) || (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.root.pid - b.root.pid)
    .slice(0, COVERS_PER_READ)
    .map(({ root, startedAt }) => ({ root, startedAt }));
}

/**
 * The book of the trace. The engine gives it each root that it puts in a job and each batch of messages. It keeps the
 * live processes of the trace and the counts of each source in buckets of 10 seconds over the last 10 minutes.
 */
export class TraceBook {
  readonly #windowMs: number;
  readonly #roots = new Map<number, TraceRoot>();
  readonly #live = new Map<number, Traced>();
  /** The processes that Windows refused, with their start, so a read does not try them again. */
  #refused = new Map<number, number | undefined>();
  readonly #buckets = new Map<number, Map<string, Counts>>();
  readonly #kinds = new Map<string, OwnerKind>();
  #since: number | null = null;
  #cpu: (readonly [at: number, ms: number])[] = [];

  constructor(windowMs: number = TRACE_WINDOW_MS) {
    this.#windowMs = windowMs;
  }

  /** This function tells if a process is in the trace: a root, or a child of a root. */
  covers(pid: number): boolean {
    return this.#live.has(pid);
  }

  /** This function tells if Windows refused the process with this start before. */
  refused(pid: number, startedAt: number | undefined): boolean {
    return this.#refused.has(pid) && this.#refused.get(pid) === startedAt;
  }

  /** This function keeps a process that Windows refused, so the next reads do not try it again. */
  refuse(pid: number, startedAt: number | undefined): void {
    this.#refused.set(pid, startedAt);
  }

  /** This function adds a root: a live process that the daemon put in the job `key`. Its own start is not a traced start. */
  root(key: number, root: TraceRoot, at: number): void {
    this.#roots.set(key, root);
    this.#live.set(root.pid, { owner: root.owner, kind: root.kind, lease: root.lease, name: root.name, source: null, at });
    this.#kinds.set(root.owner, root.kind);
    this.#since ??= at;
  }

  /** This function adds a batch of messages of the trace. */
  add(events: readonly TraceEvent[], context: TraceContext): void {
    if (events.length === 0) return;
    const leases = new Map<number, Lease>();
    const byId = new Map<string, Lease>();
    for (const lease of context.leases) {
      byId.set(lease.id, lease);
      if (lease.state === "granted" && lease.pid !== null) leases.set(lease.pid, lease);
    }
    let names: Map<number, string> | null = null;
    const nameOf = (pid: number | null): string => {
      if (pid === null) return "?";
      const traced = this.#live.get(pid);
      if (traced !== undefined) return traced.name;
      names ??= new Map(context.processes.map((info) => [info.pid, info.name]));
      return names.get(pid) ?? "?";
    };
    for (const event of events) {
      if (event.type === "empty") {
        this.#roots.delete(event.key);
        continue;
      }
      if (event.type === "exit") {
        const traced = this.#live.get(event.pid);
        this.#live.delete(event.pid);
        if (traced?.source != null && event.exitCode === DLL_INIT_FAILED) this.#count(traced.source, event.at, "failed");
        continue;
      }
      // A nested job sends a second message for the same start, and the job of a root sends one for the root.
      if (this.#live.has(event.pid)) continue;
      const parent = event.ppid === null ? undefined : this.#live.get(event.ppid);
      const root = this.#roots.get(event.key);
      // The process of `headroom run` is the parent of the job, so a start with that parent is in the lease.
      const leased = event.ppid === null ? undefined : leases.get(event.ppid);
      const lease = leased?.id ?? parent?.lease ?? root?.lease ?? null;
      const holder = leased ?? (lease === null ? undefined : byId.get(lease));
      const { owner, kind } =
        holder !== undefined
          ? holderOwner(holder.holder, context.kindOf)
          : { owner: parent?.owner ?? root?.owner ?? "other", kind: parent?.kind ?? root?.kind ?? "other" };
      const name = event.name ?? "?";
      const source = [owner, nameOf(event.ppid), name].join(SEPARATOR);
      this.#kinds.set(owner, kind);
      this.#live.set(event.pid, { owner, kind, lease, name, source, at: event.at });
      this.#count(source, event.at, "starts");
    }
  }

  /** This function adds a read of the processor time of the reader, in ms since its start. */
  cpu(at: number, ms: number): void {
    this.#cpu = [...this.#cpu.filter((point) => point[0] > at - this.#windowMs), [at, ms]];
  }

  /**
   * This function removes the processes that a read of all the processes does not have, and that came before the
   * read. Their exit message did not come. It also forgets the refusals of the ended processes.
   */
  prune(processes: readonly ProcessInfo[], readAt: number): void {
    const alive = new Map(processes.map((info) => [info.pid, info.startedAt]));
    for (const [pid, traced] of this.#live) if (!alive.has(pid) && traced.at < readAt - COVER_AFTER_MS) this.#live.delete(pid);
    this.#refused = new Map([...this.#refused].filter(([pid, startedAt]) => alive.has(pid) && alive.get(pid) === startedAt));
    for (const at of this.#buckets.keys()) if (at + BUCKET_MS <= readAt - this.#windowMs) this.#buckets.delete(at);
  }

  /** This function marks a gap after a sleep of the computer (H30). The rates start again at the wake. */
  gap(at: number): void {
    this.#buckets.clear();
    this.#cpu = [];
    if (this.#since !== null) this.#since = at;
  }

  /**
   * This function gives the traced starts over the window. `allPerMinute` is the rate of all the starts of the computer
   * over the same span, or `null` when it is not exact. It gives `null` before the first root, unless the trace failed.
   */
  summary(now: number, trace: { readonly jobs: number; readonly failure: string | null }, allPerMinute: (spanMs: number) => number | null): TracedStarts | null {
    if (this.#since === null) {
      if (trace.failure === null) return null;
      return { perMinute: 0, coverage: null, failedPerMinute: 0, sources: [], named: 1, spanMs: 0, processes: 0, jobs: trace.jobs, refused: this.#refused.size, cpuMsPerMinute: 0, failure: trace.failure };
    }
    const spanMs = Math.min(this.#windowMs, now - this.#since);
    const rate = (count: number): number => (spanMs > 0 ? (count * MINUTE_MS) / spanMs : 0);
    const sums = new Map<string, Counts>();
    for (const [at, counts] of this.#buckets) {
      if (at + BUCKET_MS <= now - spanMs) continue;
      for (const [source, each] of counts) {
        const sum = sums.get(source) ?? { starts: 0, failed: 0 };
        sum.starts += each.starts;
        sum.failed += each.failed;
        sums.set(source, sum);
      }
    }
    let starts = 0;
    let failed = 0;
    for (const each of sums.values()) {
      starts += each.starts;
      failed += each.failed;
    }
    const ranked = [...sums]
      .map(([source, each]) => {
        const [owner = "other", parent = "?", name = "?"] = source.split(SEPARATOR);
        return { owner, kind: this.#kinds.get(owner) ?? "other", parent, name, starts: each.starts, failed: each.failed };
      })
      .sort((a, b) => b.starts - a.starts || b.failed - a.failed || a.name.localeCompare(b.name));
    const sources: StartSource[] = [];
    let held = 0;
    for (const each of ranked) {
      if (sources.length >= SOURCES_KEPT || (starts > 0 && held >= NAMED_PART * starts)) break;
      if (each.starts === 0 && each.failed === 0) continue;
      held += each.starts;
      sources.push({ owner: each.owner, kind: each.kind, parent: each.parent, name: each.name, perMinute: round(rate(each.starts)), failedPerMinute: round(rate(each.failed)) });
    }
    const all = spanMs > 0 ? allPerMinute(spanMs) : null;
    const perMinute = rate(starts);
    const first = this.#cpu.find((point) => point[0] >= now - spanMs) ?? this.#cpu[0];
    const last = this.#cpu.at(-1);
    const cpuMsPerMinute = first !== undefined && last !== undefined && last[0] > first[0] ? ((last[1] - first[1]) * MINUTE_MS) / (last[0] - first[0]) : 0;
    return {
      perMinute: round(perMinute),
      coverage: all === null || all <= 0 ? null : Math.min(1, Math.round((perMinute / all) * 1000) / 1000),
      failedPerMinute: round(rate(failed)),
      sources,
      named: starts > 0 ? Math.round((held / starts) * 1000) / 1000 : 1,
      spanMs,
      processes: this.#live.size,
      jobs: trace.jobs,
      refused: this.#refused.size,
      cpuMsPerMinute: round(cpuMsPerMinute),
      failure: trace.failure,
    };
  }

  #count(source: string, at: number, field: keyof Counts): void {
    const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    let counts = this.#buckets.get(bucket);
    if (counts === undefined) {
      counts = new Map();
      this.#buckets.set(bucket, counts);
    }
    const each = counts.get(source) ?? { starts: 0, failed: 0 };
    each[field] += 1;
    counts.set(source, each);
  }
}

/**
 * This function adds the traced starts to the starts of the tracker. A traced owner gets the higher of its two rates.
 * The reason: the trace counts each start of its tree, and the reads find only some of them. An owner that only the trace has
 * joins the list.
 */
export function withTrace(starts: ProcessStarts, traced: TracedStarts | null): ProcessStarts {
  if (traced === null) return starts;
  const tracedOf = new Map<string, { perMinute: number; kind: OwnerKind }>();
  for (const source of traced.sources) {
    const each = tracedOf.get(source.owner) ?? { perMinute: 0, kind: source.kind };
    each.perMinute += source.perMinute;
    tracedOf.set(source.owner, each);
  }
  const owners: OwnerStarts[] = starts.owners.map((owner) => {
    const each = tracedOf.get(owner.owner);
    return each === undefined || each.perMinute <= owner.perMinute ? owner : { ...owner, perMinute: round(each.perMinute) };
  });
  for (const [owner, each] of tracedOf) {
    if (!owners.some((known) => known.owner === owner)) owners.push({ owner, kind: each.kind, perMinute: round(each.perMinute), jobsPerMinute: 0, ownPerMinute: 0 });
  }
  return { ...starts, owners: owners.sort((a, b) => b.perMinute - a.perMinute), traced };
}

/** This function gives the text of one source, for example "session:shop bash.exe > git.exe 410". */
export function sourceText(source: StartSource): string {
  const failed = source.failedPerMinute > 0 ? `, ${Math.round(source.failedPerMinute).toLocaleString("en-US")} failed` : "";
  return `${source.owner} ${source.parent} > ${source.name} ${Math.round(source.perMinute).toLocaleString("en-US")}${failed}`;
}

/** This function gives a part from 0 to 1 as a whole percent, for example 0.934 gives "93 %". */
export function percentText(part: number): string {
  return `${Math.round(part * 100)} %`;
}

/**
 * This function gives the lines of the trace for `headroom status`: the coverage, the failures and the cost, then the
 * sources. It gives `[]` without a trace.
 */
export function traceLines(traced: TracedStarts | null | undefined, limit = 5): string[] {
  if (traced === null || traced === undefined) return [];
  if (traced.spanMs <= 0) return traced.failure === null ? [] : [`Traced starts: none. The trace stopped: ${traced.failure}.`];
  const coverage = traced.coverage === null ? "" : `, ${percentText(traced.coverage)} of all the starts`;
  const failed = traced.failedPerMinute > 0 ? ` ${Math.round(traced.failedPerMinute).toLocaleString("en-US")} a minute failed with 0xC0000142.` : "";
  const cost = `The trace used ${traced.cpuMsPerMinute.toLocaleString("en-US")} ms of processor time a minute, with ${traced.jobs} jobs and ${traced.processes} live processes.`;
  const stopped = traced.failure === null ? "" : ` The trace stopped: ${traced.failure}.`;
  const lines = [`Traced starts: ${Math.round(traced.perMinute).toLocaleString("en-US")} a minute${coverage}.${failed} ${cost}${stopped}`];
  const shown = traced.sources.slice(0, limit);
  if (shown.length > 0) lines.push(`  Most: ${shown.map(sourceText).join(", ")}.`);
  return lines;
}
