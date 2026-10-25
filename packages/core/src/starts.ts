/**
 * The process starts of each owner (H29). The AMD display driver leaks kernel memory for each new process, so the fleet
 * must see who starts the most processes.
 *
 * - The total of the computer is exact on Windows. Windows gives each new process the next sequence number. The change
 *   of the number of the newest process between two reads is the count of starts.
 * - The starts of an owner outside its jobs are a lower bound: the new processes that a read finds. A read every 10
 *   seconds misses most short processes.
 * - The starts of a leased job are exact. The job object of `headroom run` counts each process of the job, and the client
 *   reports the count with its heartbeat and its release.
 * - The holder of a lease decides the owner of the starts of its job, not the name of the job or the process tree. A
 *   shell between a session and its job can stop and break the tree. The tree decides only outside the leases.
 */

import type { Lease } from "./broker.ts";
import type { Owners } from "./resources.ts";
import type { OwnerKind, ProcessInfo } from "./types.ts";

/** The starts of one owner in one minute, as an average over the last 10 minutes. */
export interface OwnerStarts {
  /** The owner: `session:graph`, `mcp:vex`, `system` or `other`. */
  readonly owner: string;
  readonly kind: OwnerKind;
  /** All the starts of the owner in one minute: its jobs and its own commands. */
  readonly perMinute: number;
  /** The starts in one minute in the jobs of the owner. A job with a job object gives an exact count. */
  readonly jobsPerMinute: number;
  /** The new processes in one minute that the reads found outside the leases: the own commands of the owner, a lower bound. */
  readonly ownPerMinute: number;
}

/** The starts of one leased job, from the job object of `headroom run`. */
export interface JobStarts {
  /** The id of the lease. */
  readonly id: string;
  readonly job: string;
  readonly holder: string;
  /** The owner of the job, from its holder (`holderOwner`). */
  readonly owner: string;
  /** The processes that the job started so far. */
  readonly processes: number;
  /** The starts in one minute, as an average over the last 10 minutes. */
  readonly perMinute: number;
}

/** The process starts of the computer, of each owner and of each leased job. `Status.starts` gives them. */
export interface ProcessStarts {
  /** The starts of the computer in one minute, as an average over the reads of the last 10 minutes. */
  readonly perMinute: number;
  /** True: `perMinute` comes from the sequence numbers of Windows, and it is exact. False: it is a lower bound. */
  readonly exact: boolean;
  /** The time that the reads cover, at most 10 minutes. The churn alert needs the full window. */
  readonly spanMs: number;
  /** The owners, the most starts first. */
  readonly owners: readonly OwnerStarts[];
  /** The leased jobs with a count in the window, the most starts first. */
  readonly jobs: readonly JobStarts[];
}

/** The process starts before the first two reads: no rate and no owner. */
export const NO_STARTS: ProcessStarts = { perMinute: 0, exact: false, spanMs: 0, owners: [], jobs: [] };

const MINUTE_MS = 60_000;
/** The window of the rates. */
export const STARTS_WINDOW_MS: number = 10 * MINUTE_MS;
/** The window of the rate of the condition `starts<N` (H31): a short window, so a waiting lease starts soon after a burst ends. */
export const RECENT_STARTS_MS: number = 2 * MINUTE_MS;
/** A process that the previous read did not have, and that started this long before it, is not new. The previous read missed it. */
const MISSED_MS = 5000;
/** The count of owners in `ProcessStarts.owners`. */
const OWNERS_KEPT = 10;

/** This function rounds to one decimal. */
const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * This function tells if a process is new since the previous read. `before` is the start of the process with the same ID
 * in the previous read, or `undefined` when that read did not have the ID. A different start shows a new process with
 * the ID of an ended process. The idle process (ID 0) is not new at any time.
 */
export function isNewProcess(info: ProcessInfo, before: { readonly startedAt: number | undefined } | undefined, previousAt: number): boolean {
  if (info.pid === 0) return false;
  if (before === undefined) return info.startedAt === undefined || info.startedAt >= previousAt - MISSED_MS;
  return before.startedAt !== undefined && info.startedAt !== undefined && info.startedAt !== before.startedAt;
}

/** One read of the processes: its time, the time that it covers and the new processes that it found. */
interface StartRead {
  readonly at: number;
  readonly spanMs: number;
  /** The exact starts of the computer since the previous read, from the sequence numbers, or `undefined`. */
  readonly starts: number | undefined;
  /** The new processes outside the leases, by owner. */
  readonly own: ReadonlyMap<string, number>;
  /** The new processes in each lease, by lease and owner. */
  readonly leased: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** The reports of one leased job: `[at, processes]`, the oldest first. */
interface JobReports {
  readonly job: string;
  readonly holder: string;
  owner: string;
  kind: OwnerKind;
  points: (readonly [at: number, processes: number])[];
}

/**
 * This function gives the owner of the starts of a leased job from the holder of the lease. A session with the name of
 * the holder gives `session:<holder>`. Without that session, the holder is its own owner. The process tree does not
 * decide, because a shell between the session and the job can stop.
 */
export function holderOwner(holder: string, kindOf: ReadonlyMap<string, OwnerKind>): { readonly owner: string; readonly kind: OwnerKind } {
  const session = `session:${holder}`;
  if (kindOf.get(session) === "session") return { owner: session, kind: "session" };
  return { owner: holder, kind: kindOf.get(holder) ?? "other" };
}

function add(into: Map<string, number>, key: string, amount: number): void {
  into.set(key, (into.get(key) ?? 0) + amount);
}

/**
 * The tracker of the process starts. The engine gives it each read of the processes with the sequence number of
 * Windows, and each count of a job object from a client. It keeps the starts of the last live processes, the reads
 * of the last 10 minutes and the reports of the jobs of the last 10 minutes.
 */
export class StartTracker {
  readonly #windowMs: number;
  /** The start of each live process at the last read. */
  #last = new Map<number, number | undefined>();
  #lastAt: number | null = null;
  #lastSequence: number | undefined;
  #reads: StartRead[] = [];
  readonly #kinds = new Map<string, OwnerKind>();
  readonly #jobs = new Map<string, JobReports>();

  constructor(windowMs: number = STARTS_WINDOW_MS) {
    this.#windowMs = windowMs;
  }

  /**
   * This function adds one read of the processes. `sequence` is the sequence number of the newest process, when the
   * platform gives it. The first read only keeps the processes. The holder of a lease in `leases` decides the owner of
   * the new processes of that lease.
   */
  read(at: number, processes: readonly ProcessInfo[], owners: Owners, sequence?: number, leases: readonly Lease[] = []): void {
    const previousAt = this.#lastAt;
    if (previousAt !== null && at > previousAt) {
      const own = new Map<string, number>();
      const leased = new Map<string, Map<string, number>>();
      const holders = new Map(leases.map((each) => [each.id, each.holder]));
      for (const info of processes) {
        const before = this.#last.has(info.pid) ? { startedAt: this.#last.get(info.pid) } : undefined;
        if (!isNewProcess(info, before, previousAt)) continue;
        const lease = owners.leaseOf.get(info.pid);
        const holder = lease === undefined ? undefined : holders.get(lease);
        const tree = owners.ownerOf.get(info.pid) ?? "other";
        const { owner, kind } = holder === undefined ? { owner: tree, kind: owners.kindOf.get(tree) } : holderOwner(holder, owners.kindOf);
        this.#kinds.set(owner, kind ?? this.#kinds.get(owner) ?? "other");
        if (lease === undefined) {
          add(own, owner, 1);
          continue;
        }
        let byOwner = leased.get(lease);
        if (byOwner === undefined) {
          byOwner = new Map();
          leased.set(lease, byOwner);
        }
        add(byOwner, owner, 1);
      }
      // The newest live process can be older than the newest process of the previous read, so the number keeps its highest value.
      const starts = sequence === undefined || this.#lastSequence === undefined ? undefined : Math.max(0, sequence - this.#lastSequence);
      this.#reads = [...this.#reads.filter((each) => at - each.at < this.#windowMs), { at, spanMs: at - previousAt, starts, own, leased }];
    }
    // Only the live processes stay, so the map does not grow.
    this.#last = new Map(processes.map((info) => [info.pid, info.startedAt]));
    this.#lastAt = at;
    this.#lastSequence = sequence === undefined ? undefined : Math.max(sequence, this.#lastSequence ?? sequence);
    this.#prune(at);
  }

  /**
   * This function adds a count of the job object of a lease: the processes that the job started so far. The holder of the
   * lease decides the owner of the job, also when the processes of the job ended before a read.
   */
  report(lease: Lease, at: number, processes: number, owners: Owners): void {
    const { owner, kind } = holderOwner(lease.holder, owners.kindOf);
    let entry = this.#jobs.get(lease.id);
    if (entry === undefined) {
      entry = { job: lease.job, holder: lease.holder, owner, kind, points: [] };
      // A job has no process at its grant.
      if (lease.grantedAt !== null && lease.grantedAt < at) entry.points.push([lease.grantedAt, 0]);
      this.#jobs.set(lease.id, entry);
    }
    entry.owner = owner;
    entry.kind = kind;
    const total = Math.max(processes, entry.points.at(-1)?.[1] ?? 0);
    const from = at - this.#windowMs;
    // The points of the window stay, with the newest point before the window as the base of the rate.
    const base = entry.points.findLastIndex((point) => point[0] <= from);
    entry.points = [...entry.points.slice(Math.max(0, base)), [at, total]];
  }

  /** This function gives the counts of a leased job in the window: `[at, processes]`, the oldest first (H47). The first point can be its grant. */
  points(id: string): readonly (readonly [at: number, processes: number])[] {
    return this.#jobs.get(id)?.points ?? [];
  }

  /**
   * This function marks a gap after a sleep of the computer (H30). The next read only keeps the processes and the sequence
   * number, so no rate spans the sleep. The count of each job starts again at the wake, because no process starts in a sleep.
   */
  gap(at: number): void {
    this.#lastAt = null;
    this.#lastSequence = undefined;
    for (const entry of this.#jobs.values()) {
      const last = entry.points.at(-1);
      entry.points = last === undefined ? [] : [[at, last[1]]];
    }
  }

  /** This function gives the starts of the computer, of each owner and of each leased job over the last 10 minutes. */
  summary(now: number): ProcessStarts {
    const reads = this.#reads.filter((each) => now - each.at < this.#windowMs);
    const spanMs = reads.reduce((sum, each) => sum + each.spanMs, 0);
    const rate = (count: number): number => (spanMs > 0 ? (count * MINUTE_MS) / spanMs : 0);
    const own = new Map<string, number>();
    const leased = new Map<string, Map<string, number>>();
    let exactStarts = 0;
    for (const each of reads) {
      exactStarts += each.starts ?? 0;
      for (const [owner, count] of each.own) add(own, owner, count);
      for (const [lease, byOwner] of each.leased) {
        let sums = leased.get(lease);
        if (sums === undefined) {
          sums = new Map();
          leased.set(lease, sums);
        }
        for (const [owner, count] of byOwner) add(sums, owner, count);
      }
    }
    const jobs: JobStarts[] = [];
    const jobsOf = new Map<string, number>();
    const kinds = new Map(this.#kinds);
    for (const [id, entry] of this.#jobs) {
      const last = entry.points.at(-1);
      const base = entry.points.findLast((point) => point[0] <= now - this.#windowMs) ?? entry.points[0];
      if (last === undefined || base === undefined) continue;
      const perMinute = now > base[0] ? ((last[1] - base[1]) * MINUTE_MS) / (now - base[0]) : 0;
      // The holder decides the owner of the job (`report`).
      const owner = entry.owner;
      if (!kinds.has(owner)) kinds.set(owner, entry.kind);
      jobs.push({ id, job: entry.job, holder: entry.holder, owner, processes: last[1], perMinute: round(perMinute) });
      add(jobsOf, owner, perMinute);
    }
    // A lease with no count (`--keep`, or no job object) gives the new processes of its tree, a lower bound.
    for (const [lease, byOwner] of leased) if (!this.#jobs.has(lease)) for (const [owner, count] of byOwner) add(jobsOf, owner, rate(count));
    const owners = [...new Set([...own.keys(), ...jobsOf.keys()])]
      .map((owner) => {
        const ownPerMinute = rate(own.get(owner) ?? 0);
        const jobsPerMinute = jobsOf.get(owner) ?? 0;
        return { owner, kind: kinds.get(owner) ?? "other", perMinute: round(ownPerMinute + jobsPerMinute), jobsPerMinute: round(jobsPerMinute), ownPerMinute: round(ownPerMinute) };
      })
      .filter((each) => each.perMinute > 0)
      .sort((a, b) => b.perMinute - a.perMinute)
      .slice(0, OWNERS_KEPT);
    const exact = reads.length > 0 && reads.every((each) => each.starts !== undefined);
    const lowerBound = [...own.values()].reduce((sum, count) => sum + rate(count), 0) + [...jobsOf.values()].reduce((sum, value) => sum + value, 0);
    return {
      perMinute: round(exact ? rate(exactStarts) : lowerBound),
      exact,
      spanMs,
      owners,
      jobs: jobs.sort((a, b) => b.perMinute - a.perMinute || b.processes - a.processes),
    };
  }

  /**
   * This function gives the starts of the computer in one minute over the reads of the last `windowMs`, as a whole number.
   * It gives `null` before two reads. The rate is exact when each read has a sequence number. Otherwise, it is a lower
   * bound: the new processes that the reads found.
   */
  recent(now: number, windowMs: number = RECENT_STARTS_MS): number | null {
    const reads = this.#reads.filter((each) => now - each.at < windowMs);
    const spanMs = reads.reduce((sum, each) => sum + each.spanMs, 0);
    if (spanMs <= 0) return null;
    const exact = reads.every((each) => each.starts !== undefined);
    let count = 0;
    for (const each of reads) {
      if (exact) {
        count += each.starts ?? 0;
        continue;
      }
      for (const found of each.own.values()) count += found;
      for (const byOwner of each.leased.values()) for (const found of byOwner.values()) count += found;
    }
    return Math.round((count * MINUTE_MS) / spanMs);
  }

  /** This function removes the jobs with no count in the window, and the kinds of the owners that left the window. */
  #prune(now: number): void {
    for (const [id, entry] of this.#jobs) if ((entry.points.at(-1)?.[0] ?? 0) <= now - this.#windowMs) this.#jobs.delete(id);
    const owners = new Set<string>();
    for (const each of this.#reads) {
      for (const owner of each.own.keys()) owners.add(owner);
      for (const byOwner of each.leased.values()) for (const owner of byOwner.keys()) owners.add(owner);
    }
    for (const owner of this.#kinds.keys()) if (!owners.has(owner)) this.#kinds.delete(owner);
  }
}

/** This function writes a count for a person, as a whole number with commas: 9800 gives "9,800". */
export function countText(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/**
 * This function gives the text of one owner, for example "session:client 410 (jobs 12, own commands 398, job e2e: 9,800 so
 * far)". An owner with no job gives only its name and its starts in one minute.
 */
export function ownerStartsText(owner: OwnerStarts, jobs: readonly JobStarts[]): string {
  const top = jobs.find((each) => each.owner === owner.owner);
  if (owner.jobsPerMinute <= 0 && top === undefined) return `${owner.owner} ${countText(owner.perMinute)}`;
  const job = top === undefined ? "" : `, job ${top.job}: ${countText(top.processes)} so far`;
  return `${owner.owner} ${countText(owner.perMinute)} (jobs ${countText(owner.jobsPerMinute)}, own commands ${countText(owner.ownPerMinute)}${job})`;
}

/** This function gives the owners with the most starts as text, at most `limit`, or "" when no owner starts one process in one minute. */
export function topStartsText(starts: ProcessStarts, limit: number): string {
  return starts.owners
    .filter((each) => each.perMinute >= 1)
    .slice(0, limit)
    .map((each) => ownerStartsText(each, starts.jobs))
    .join(", ");
}

/**
 * This function gives the line of `headroom status`, for example "Process starts: 820 a minute. Most (at least):
 * session:graph 410.". It gives `null` before two reads.
 */
export function startsLine(starts: ProcessStarts, limit = 3): string | null {
  if (starts.spanMs <= 0) return null;
  const most = topStartsText(starts, limit);
  const named = most === "" ? "" : ` Most${starts.exact ? " (at least)" : ""}: ${most}.`;
  return `Process starts: ${countText(starts.perMinute)} a minute${starts.exact ? "" : " (at least)"}.${named}`;
}
