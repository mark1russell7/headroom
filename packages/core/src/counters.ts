/**
 * The use of each owner from the totals of its processes (H20): the bytes that it wrote and its processor time.
 *
 * Each total of a process only grows from its start. The use of an owner is the change of the totals of its processes
 * between two reads. One tracker gives this change for each total, so the disk and the processors use one mechanism.
 *
 * - A process that the previous read did not have starts at its first read. Only a process that started after the
 *   previous read counts with its full total, because all of it is new.
 * - A process that exits between two reads loses its last change.
 * - The I/O totals count each read and write, also to a pipe or a device. They do not name the drive.
 */

import { MB } from "./sampler.ts";
import type { OwnerKind, ProcessInfo } from "./types.ts";

/** A total of a process since its start: the processor time in milliseconds, or the bytes that it read or wrote. */
export type Counter = "cpuMs" | "readBytes" | "writeBytes";

/** The writes of one owner over the last hour. `Status.writes` gives the owners that wrote most. */
export interface OwnerWrites {
  /** The owner: `session:graph`, `mcp:vex`, `docker` or `system`. */
  readonly owner: string;
  readonly kind: OwnerKind;
  /** The MB that the owner writes in one minute, as an average over the last 10 minutes. */
  readonly mbPerMin: number;
  /** The MB that the owner wrote in the last hour. */
  readonly mbLastHour: number;
}

/** The processor use of one owner: the cores that it used, as an average over the last minute. */
export interface OwnerCores {
  readonly owner: string;
  readonly kind: OwnerKind;
  readonly cores: number;
}

/** One stored minute of one total of one owner, in the unit of the total. */
export interface CounterRow {
  readonly at: number;
  readonly owner: string;
  readonly kind: OwnerKind;
  readonly amount: number;
}

/**
 * This function gives the change of one total of a process since the previous read. It gives `undefined` when the read has
 * no total, or when the process is new and started before the previous read.
 */
export function counterDelta(counter: Counter, info: ProcessInfo, before: ProcessInfo | undefined, previousAt: number | null): number | undefined {
  const now = info[counter];
  if (now === undefined || previousAt === null) return undefined;
  // A different start shows a new process with the ID of an ended process.
  const same = before !== undefined && (before.startedAt === undefined || info.startedAt === undefined || before.startedAt === info.startedAt);
  const then = same ? before[counter] : undefined;
  if (then !== undefined) return Math.max(0, now - then);
  if (info.startedAt !== undefined && info.startedAt >= previousAt) return now;
  return undefined;
}

/** The change of each total for each owner. */
type Sums = Map<Counter, Map<string, number>>;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** The window of the speed of the writes. */
const WRITES_RATE_MS = 10 * MINUTE_MS;
/** The window of the processor use. */
const CORES_MS = MINUTE_MS;
/** The tracker keeps each read for the longest rate window. */
const READS_KEEP_MS = WRITES_RATE_MS;

/** This function rounds to one decimal. */
const round = (value: number): number => Math.round(value * 10) / 10;

function add(sums: Sums, counter: Counter, owner: string, amount: number): void {
  let byOwner = sums.get(counter);
  if (byOwner === undefined) {
    byOwner = new Map();
    sums.set(counter, byOwner);
  }
  byOwner.set(owner, (byOwner.get(owner) ?? 0) + amount);
}

function addAll(into: Map<string, number>, from: ReadonlyMap<string, number> | undefined): void {
  for (const [owner, amount] of from ?? []) into.set(owner, (into.get(owner) ?? 0) + amount);
}

/**
 * The tracker of the totals of the processes. The engine gives it each read of the processes, and closes one minute at each
 * sample of the store. It keeps the last totals of the live processes, the reads of the last 10 minutes and the minutes
 * of the last hour. Each read and each minute has only the owners whose totals changed.
 */
export class CounterTracker {
  readonly #counters: readonly Counter[];
  /** The last read of each live process. */
  #last = new Map<number, ProcessInfo>();
  #lastAt: number | null = null;
  /** The totals that the last read had for at least one process. */
  #seen = new Set<Counter>();
  /** The reads of the last 10 minutes, with the time that each one covers. */
  #reads: { readonly at: number; readonly spanMs: number; readonly sums: Sums }[] = [];
  /** The closed minutes of the last hour, the oldest first. */
  #minutes: { readonly at: number; readonly sums: Sums }[] = [];
  /** The changes since the last closed minute. */
  #open: Sums = new Map();
  readonly #kinds = new Map<string, OwnerKind>();

  constructor(counters: readonly Counter[] = ["cpuMs", "writeBytes"]) {
    this.#counters = counters;
  }

  /** This function adds one read of the processes. The first read only keeps the totals. */
  read(at: number, processes: readonly ProcessInfo[], ownerOf: ReadonlyMap<number, string>, kindOf: ReadonlyMap<string, OwnerKind>): void {
    const previousAt = this.#lastAt;
    this.#seen = new Set(this.#counters.filter((counter) => processes.some((info) => info[counter] !== undefined)));
    if (previousAt !== null && at > previousAt) {
      const sums: Sums = new Map();
      for (const info of processes) {
        const before = this.#last.get(info.pid);
        for (const counter of this.#counters) {
          const delta = counterDelta(counter, info, before, previousAt);
          if (delta === undefined || delta <= 0) continue;
          const owner = ownerOf.get(info.pid) ?? "other";
          add(sums, counter, owner, delta);
          add(this.#open, counter, owner, delta);
          this.#kinds.set(owner, kindOf.get(owner) ?? this.#kinds.get(owner) ?? "other");
        }
      }
      this.#reads = [...this.#reads.filter((each) => at - each.at < READS_KEEP_MS), { at, spanMs: at - previousAt, sums }];
    }
    // Only the live processes stay, so the map does not grow.
    this.#last = new Map(processes.map((info) => [info.pid, info]));
    this.#lastAt = at;
  }

  /**
   * This function marks a gap after a sleep of the computer (H30). The next read only keeps the totals, so no rate spans
   * the sleep. The reads before the sleep keep their own times.
   */
  gap(): void {
    this.#lastAt = null;
  }

  /** This function closes the minute that ends at a time. It gives the change of each total for each owner in that minute, for the store. */
  close(at: number): ReadonlyMap<Counter, ReadonlyMap<string, number>> {
    const sums = this.#open;
    this.#open = new Map();
    this.#minutes = this.#minutes.filter((minute) => at - minute.at < HOUR_MS);
    if (sums.size > 0) this.#minutes.push({ at, sums });
    // The kinds of the owners that left the window go.
    const owners = new Set<string>();
    for (const each of [...this.#minutes, ...this.#reads]) for (const byOwner of each.sums.values()) for (const owner of byOwner.keys()) owners.add(owner);
    for (const owner of this.#kinds.keys()) if (!owners.has(owner)) this.#kinds.delete(owner);
    return sums;
  }

  /** This function adds the stored minutes of one total, so the hour continues after a restart. The rows are the oldest first. */
  restore(counter: Counter, rows: readonly CounterRow[]): void {
    for (const row of rows) {
      let minute = this.#minutes.find((each) => each.at === row.at);
      if (minute === undefined) {
        minute = { at: row.at, sums: new Map() };
        this.#minutes.push(minute);
      }
      add(minute.sums, counter, row.owner, row.amount);
      this.#kinds.set(row.owner, row.kind);
    }
    this.#minutes.sort((a, b) => a.at - b.at);
  }

  /** This function gives the change of one total for each owner over the reads of a window, and the time that the reads cover. */
  recent(counter: Counter, now: number, windowMs: number): { readonly sums: Map<string, number>; readonly spanMs: number } {
    const sums = new Map<string, number>();
    let spanMs = 0;
    for (const each of this.#reads) {
      if (now - each.at >= windowMs) continue;
      spanMs += each.spanMs;
      addAll(sums, each.sums.get(counter));
    }
    return { sums, spanMs };
  }

  /** This function gives the change of one total for each owner over the last hour. */
  hour(counter: Counter, now: number): Map<string, number> {
    const sums = new Map<string, number>();
    for (const minute of this.#minutes) if (now - minute.at < HOUR_MS) addAll(sums, minute.sums.get(counter));
    addAll(sums, this.#open.get(counter));
    return sums;
  }

  /** This function gives the kind of an owner. */
  kindOf(owner: string): OwnerKind {
    return this.#kinds.get(owner) ?? "other";
  }

  /** This function gives the owners that wrote most in the last hour, at most `limit`. An owner with less than 0.1 MB is absent. */
  writes(now: number, limit = 10): OwnerWrites[] {
    const { sums: recent, spanMs } = this.recent("writeBytes", now, WRITES_RATE_MS);
    const minutes = spanMs / MINUTE_MS;
    return [...this.hour("writeBytes", now)]
      .map(([owner, bytes]) => ({
        owner,
        kind: this.kindOf(owner),
        mbPerMin: minutes > 0 ? round((recent.get(owner) ?? 0) / MB / minutes) : 0,
        mbLastHour: round(bytes / MB),
      }))
      .filter((each) => each.mbLastHour > 0)
      .sort((a, b) => b.mbLastHour - a.mbLastHour || b.mbPerMin - a.mbPerMin)
      .slice(0, limit);
  }

  /**
   * This function gives the cores that each owner used, as an average over the reads of the last minute, the largest first.
   * It gives `undefined` before two reads, and when no process has a processor time.
   */
  cores(now: number): OwnerCores[] | undefined {
    if (!this.#seen.has("cpuMs")) return undefined;
    const { sums, spanMs } = this.recent("cpuMs", now, CORES_MS);
    if (spanMs <= 0) return undefined;
    return [...sums]
      .map(([owner, ms]) => ({ owner, kind: this.kindOf(owner), cores: ms / spanMs }))
      .sort((a, b) => b.cores - a.cores);
  }
}
