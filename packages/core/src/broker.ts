/**
 * The lease broker: it grants leases on the resources, in the order of their priority. Each id has a room with an
 * admit mode. A measured id, for example the memory, uses its measured free part. A counted id, for example `cpu` or a slot, uses its capacity.
 *
 * The broker has no clock, no timer and no input or output of its own. The caller gives the time,
 * the measured capacity and the liveness of the processes, and calls `tick()` after each change.
 */

import { randomUUID } from "node:crypto";
import type { JobUsage, ResourceId, Room } from "./resources.ts";
import type { SpawnClass } from "./spawn.ts";
import { MEMORY, type Amounts } from "./types.ts";

/** The state of a lease. Only `waiting` and `granted` are active. */
export type LeaseState = "waiting" | "granted" | "released" | "expired" | "cancelled";

/** A request for a lease. */
export interface LeaseRequest {
  /** The holder: a session or a role, for example `graph`. */
  readonly holder: string;
  /** The name of the job, for example `pnpm test`. */
  readonly job: string;
  /** The amounts: `memory` in MB, `cpu` in processors, or a slot of a named pool. */
  readonly amounts: Amounts;
  /** A higher priority goes first. The default is 0. */
  readonly priority?: number | undefined;
  /** The process that holds the lease. The lease ends when this process exits. */
  readonly pid?: number | undefined;
  /** A lease without a process ends when no heartbeat comes for this time. The default is 5 minutes. */
  readonly ttlMs?: number | undefined;
  /** The absolute path of the log file of the job (`headroom run --log`). */
  readonly log?: string | undefined;
  /**
   * The spawn option of the run (H47). True (`--spawn-heavy`): the job starts many processes. False (`--no-spawn-heavy`):
   * the job is normal, also with a high peak in its past runs. Without it, the past runs decide.
   */
  readonly spawnHeavy?: boolean | undefined;
}

/** The exit of a job, from its holder at the release (H26). */
export interface JobExit {
  /** The exit code of the job. It is `null` when a signal stopped the job. */
  readonly code: number | null;
  /** The signal that stopped the job, for example `SIGTERM`, or `null`. */
  readonly signal: string | null;
}

/** A lease and its history. */
export interface Lease {
  readonly id: string;
  readonly holder: string;
  readonly job: string;
  readonly amounts: Amounts;
  readonly priority: number;
  readonly pid: number | null;
  readonly ttlMs: number;
  readonly state: LeaseState;
  readonly requestedAt: number;
  readonly grantedAt: number | null;
  readonly endedAt: number | null;
  readonly heartbeatAt: number;
  /** Why the lease ended, or why it waits. */
  readonly reason: string | null;
  /** The peak memory of the job in MB, from its holder at the release. It is `null` before the job ends and without a job object. */
  readonly peakMb: number | null;
  /** The use of the job at its release, from its holder, for example the size of its temp folder (H19). */
  readonly usage?: JobUsage | undefined;
  /** The exit code of the job, from its holder at the release (H26). A lease that ended without a job exit has none. */
  readonly exitCode?: number | undefined;
  /** The signal that stopped the job, from its holder at the release (H26). */
  readonly signal?: string | undefined;
  /** The absolute path of the log file of the job (`headroom run --log`). */
  readonly log?: string | undefined;
  /**
   * The processes that the job started so far, from its job object (H29). The client reports the count with its heartbeat
   * and its release. A job with no job object has none.
   */
  readonly processes?: number | undefined;
  /**
   * The highest count of process starts of the job in one minute, over a window of 30 seconds (H47). The engine measures
   * it from the counts of the heartbeats and of the release.
   */
  readonly peakStartsPerMin?: number | undefined;
  /** The spawn class of the job (H47): a spawn-heavy job and a browser test do not run at the same time. */
  readonly spawn?: SpawnClass | undefined;
}

/** The fields of a lease that the engine measures while its job runs (H47). */
export interface LeaseMeasures {
  readonly peakStartsPerMin?: number | undefined;
  readonly spawn?: SpawnClass | undefined;
}

/** The capacity at one time. */
export interface Capacity {
  /** The total physical memory, in MB. */
  readonly totalMb: number;
  /** The available memory at the time of the sample, in MB. */
  readonly availableMb: number;
  /** The capacity of each configured pool. A pool with no entry has a capacity of 1: a lock. */
  readonly pools: Amounts;
  /**
   * The room of each id, from the measurements and the admit part of its kind. Without a room, the memory
   * fields above give the room of `memory`, and each other id is a slot.
   */
  readonly rooms?: Readonly<Record<ResourceId, Room>> | undefined;
}

/** The options of a broker. Each option has a default. */
export interface BrokerOptions {
  readonly now?: (() => number) | undefined;
  readonly newId?: (() => string) | undefined;
  /** This function tells if a process runs. The default asks the operating system. */
  readonly isAlive?: ((pid: number) => boolean) | undefined;
  /** This function gives the memory, in MB, that the processes of a granted lease use at this time. It is the memory case of `used`. */
  readonly usedMb?: ((lease: Lease) => number) | undefined;
  /** This function gives the part of the amount of an id that a granted lease uses at this time. The default uses `usedMb` for the memory. */
  readonly used?: ((lease: Lease, id: ResourceId) => number) | undefined;
  /** The memory that the broker keeps free, in MB. The default is 1024. */
  readonly reserveMb?: number | undefined;
  /** A waiting request gains 1 of priority for each period of this length. The default is 1 minute. */
  readonly agingMs?: number | undefined;
  /** After this wait, smaller requests no longer go before the first request. The default is 10 minutes. */
  readonly headWaitMs?: number | undefined;
  /** The heartbeat limit of a lease without a process. The default is 5 minutes. */
  readonly defaultTtlMs?: number | undefined;
  /**
   * This function tells why a lease cannot run beside another lease, or gives `null` (H47). The other lease is granted, or
   * it waits before the lease in the queue. Thus a later lease does not go before an earlier lease that it conflicts with.
   * The default gives `null`.
   */
  readonly conflict?: ((lease: Lease, other: Lease) => string | null) | undefined;
}

const ACTIVE: ReadonlySet<LeaseState> = new Set(["waiting", "granted"]);

/** This function gives the field `processes` of a report. A count only grows, so a smaller count keeps the count of the lease. */
function processesOf(lease: Lease, processes: number | undefined): { processes?: number } {
  if (processes === undefined) return {};
  return { processes: Math.max(processes, lease.processes ?? 0) };
}

/** This function gives the field `spawn` of a new lease: the class from the engine, else the class from the option of the request. */
function spawnOf(request: LeaseRequest, spawn: SpawnClass | undefined): { spawn?: SpawnClass } {
  if (spawn !== undefined) return { spawn };
  if (request.spawnHeavy === undefined) return {};
  return { spawn: { heavy: request.spawnHeavy, source: request.spawnHeavy ? "declared" : "opted-out", perMinute: null, runs: 0 } };
}

/** This function tells if a lease is active: waiting or granted. */
export function isActive(lease: Lease): boolean {
  return ACTIVE.has(lease.state);
}

/** This function asks the operating system if a process runs. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process runs, but it belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The broker of the leases. */
export class Broker {
  readonly #leases = new Map<string, Lease>();
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #isAlive: (pid: number) => boolean;
  readonly #used: (lease: Lease, id: ResourceId) => number;
  readonly #reserveMb: number;
  readonly #agingMs: number;
  readonly #headWaitMs: number;
  readonly #defaultTtlMs: number;
  readonly #conflict: (lease: Lease, other: Lease) => string | null;

  constructor(options: BrokerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
    this.#isAlive = options.isAlive ?? processIsAlive;
    const usedMb = options.usedMb ?? (() => 0);
    this.#used = options.used ?? ((lease, id) => (id === MEMORY ? usedMb(lease) : 0));
    this.#reserveMb = options.reserveMb ?? 1024;
    this.#agingMs = options.agingMs ?? 60_000;
    this.#headWaitMs = options.headWaitMs ?? 600_000;
    this.#defaultTtlMs = options.defaultTtlMs ?? 300_000;
    this.#conflict = options.conflict ?? (() => null);
  }

  /** This function adds leases that a store kept, for example after a restart of the daemon. */
  restore(leases: readonly Lease[]): void {
    for (const lease of leases) this.#leases.set(lease.id, lease);
  }

  /**
   * This function adds a request. The lease waits until a `tick()` grants it. `spawn` is the spawn class from the engine.
   * Without it, `spawnHeavy` of the request gives the class.
   */
  request(request: LeaseRequest, spawn?: SpawnClass): Lease {
    for (const [name, amount] of Object.entries(request.amounts)) {
      if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`The amount of ${name} must be a number of 0 or more`);
    }
    const now = this.#now();
    const lease: Lease = {
      id: this.#newId(),
      holder: request.holder,
      job: request.job,
      amounts: { ...request.amounts },
      priority: request.priority ?? 0,
      pid: request.pid ?? null,
      ttlMs: request.ttlMs ?? this.#defaultTtlMs,
      state: "waiting",
      requestedAt: now,
      grantedAt: null,
      endedAt: null,
      heartbeatAt: now,
      reason: null,
      peakMb: null,
      ...(request.log === undefined ? {} : { log: request.log }),
      ...spawnOf(request, spawn),
    };
    this.#leases.set(lease.id, lease);
    return lease;
  }

  /**
   * This function ends an active lease. It gives the lease, or `undefined` for an unknown id. The usage and the exit
   * are the use and the exit of the job, from its holder. `processes` is the count of processes that the job started.
   */
  release(id: string, reason = "released", peakMb: number | null = null, usage?: JobUsage, exit?: JobExit, processes?: number): Lease | undefined {
    const lease = this.#leases.get(id);
    if (!lease || !isActive(lease)) return lease;
    const state = lease.state === "waiting" ? "cancelled" : "released";
    return this.#set({
      ...lease,
      state,
      endedAt: this.#now(),
      reason,
      peakMb,
      ...(usage === undefined ? {} : { usage }),
      ...(exit?.code === null || exit?.code === undefined ? {} : { exitCode: exit.code }),
      ...(exit?.signal === null || exit?.signal === undefined ? {} : { signal: exit.signal }),
      ...processesOf(lease, processes),
    });
  }

  /** This function records a heartbeat of an active lease. `processes` is the count of processes that its job started so far (H29). */
  renew(id: string, processes?: number): Lease | undefined {
    const lease = this.#leases.get(id);
    if (!lease || !isActive(lease)) return lease;
    return this.#set({ ...lease, heartbeatAt: this.#now(), ...processesOf(lease, processes) });
  }

  /** This function sets the measured fields of a lease (H47): its peak rate of starts and its spawn class. It gives `undefined` for an unknown id. */
  update(id: string, measures: LeaseMeasures): Lease | undefined {
    const lease = this.#leases.get(id);
    if (!lease) return undefined;
    return this.#set({ ...lease, ...measures });
  }

  /**
   * This function moves the heartbeat of each active lease forward by the time that the computer slept (H30). Thus a lease
   * does not end for no heartbeat because of a sleep. A heartbeat does not move past the time of the call. It gives the
   * leases that changed.
   */
  resume(sleptMs: number): Lease[] {
    if (!(sleptMs > 0)) return [];
    const now = this.#now();
    const changed: Lease[] = [];
    for (const lease of this.#leases.values()) {
      if (!isActive(lease)) continue;
      const heartbeatAt = Math.min(now, lease.heartbeatAt + sleptMs);
      if (heartbeatAt !== lease.heartbeatAt) changed.push(this.#set({ ...lease, heartbeatAt }));
    }
    return changed;
  }

  /** This function gives one lease. */
  get(id: string): Lease | undefined {
    return this.#leases.get(id);
  }

  /** This function gives the leases, the active ones first. */
  leases(): Lease[] {
    return [...this.#leases.values()].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || a.requestedAt - b.requestedAt);
  }

  /** This function removes the ended leases that ended before a time. The store keeps their history. */
  forget(endedBefore: number): void {
    for (const [id, lease] of this.#leases) {
      if (!isActive(lease) && (lease.endedAt ?? 0) < endedBefore) this.#leases.delete(id);
    }
  }

  /**
   * This function gives the amounts that a new lease can get at this time. A measured id gives its free part less
   * the reserve, less the part of each granted lease that its job does not use yet. A counted id gives its capacity less the granted amounts.
   */
  free(capacity: Capacity): Record<string, number> {
    return this.#free(capacity, []);
  }

  #free(capacity: Capacity, more: Iterable<ResourceId>): Record<string, number> {
    const granted = [...this.#leases.values()].filter((lease) => lease.state === "granted");
    const base = this.#baseRooms(capacity);
    const ids = new Set([...Object.keys(capacity.pools), ...Object.keys(capacity.rooms ?? {}), ...granted.flatMap((lease) => Object.keys(lease.amounts)), ...more]);
    // The ids of the base rooms go last, as before.
    for (const id of Object.keys(base)) {
      ids.delete(id);
      ids.add(id);
    }
    const free: Record<string, number> = {};
    for (const id of ids) {
      const room = this.#room(id, capacity, base);
      let left = room.mode === "measured" ? (room.free ?? 0) - room.reserve : room.capacity;
      for (const lease of granted) {
        const amount = lease.amounts[id];
        if (amount === undefined) continue;
        left -= room.mode === "measured" ? Math.max(0, amount - this.#used(lease, id)) : amount;
      }
      free[id] = left;
    }
    return free;
  }

  /** This function gives the rooms that each capacity has: the room of the memory, from the memory fields of the capacity. */
  #baseRooms(capacity: Capacity): Record<ResourceId, Room> {
    return { [MEMORY]: { mode: "measured", capacity: capacity.totalMb, free: capacity.availableMb, reserve: this.#reserveMb } };
  }

  /** This function gives the room of an id. An id with no room is a slot, with the capacity of its pool or 1. */
  #room(id: ResourceId, capacity: Capacity, base: Record<ResourceId, Room> = this.#baseRooms(capacity)): Room {
    return capacity.rooms?.[id] ?? base[id] ?? { mode: "counted", capacity: capacity.pools[id] ?? 1, free: null, reserve: 0 };
  }

  /**
   * This function ends the leases whose process exited or whose heartbeat stopped. Then it grants
   * the waiting leases that fit, in the order of their priority. It gives the leases that changed.
   */
  tick(capacity: Capacity): Lease[] {
    const now = this.#now();
    const changed: Lease[] = [];
    for (const lease of this.#leases.values()) {
      if (!isActive(lease)) continue;
      const ended = lease.pid !== null ? !this.#isAlive(lease.pid) : now - lease.heartbeatAt > lease.ttlMs;
      if (ended) {
        const reason = lease.pid !== null ? "the process exited" : "no heartbeat";
        changed.push(this.#set({ ...lease, state: "expired", endedAt: now, reason }));
      }
    }

    const waiting = [...this.#leases.values()]
      .filter((lease) => lease.state === "waiting")
      .sort((a, b) => this.#rank(b, now) - this.#rank(a, now) || a.requestedAt - b.requestedAt);
    const free = this.#free(capacity, waiting.flatMap((lease) => Object.keys(lease.amounts)));
    // The granted leases, with the leases that this tick grants, and the leases that wait before the next lease (H47).
    const granted = [...this.#leases.values()].filter((lease) => lease.state === "granted");
    const before: Lease[] = [];
    for (const [index, lease] of waiting.entries()) {
      const never = this.#neverFits(lease, capacity);
      if (never) {
        changed.push(this.#set({ ...lease, state: "cancelled", endedAt: now, reason: never }));
        continue;
      }
      const short = this.#shortOf(lease, free) ?? this.#conflictOf(lease, granted, before);
      if (short === null) {
        for (const [name, amount] of Object.entries(lease.amounts)) free[name] = (free[name] ?? 0) - amount;
        const next = this.#set({ ...lease, state: "granted", grantedAt: now, reason: null });
        granted.push(next);
        changed.push(next);
        continue;
      }
      before.push(lease);
      if (lease.reason !== short) changed.push(this.#set({ ...lease, reason: short }));
      // The first request keeps its place: after a long wait, no smaller request goes before it.
      if (index === 0 && now - lease.requestedAt > this.#headWaitMs) break;
    }
    return changed;
  }

  #rank(lease: Lease, now: number): number {
    return lease.priority + Math.floor((now - lease.requestedAt) / this.#agingMs);
  }

  /** This function tells why a lease cannot fit at any time, or gives `null` when it can fit. */
  #neverFits(lease: Lease, capacity: Capacity): string | null {
    for (const [name, amount] of Object.entries(lease.amounts)) {
      const room = this.#room(name, capacity);
      const limit = room.capacity - room.reserve;
      if (amount > limit) return `${name}: ${amount} is more than the capacity of ${limit}`;
    }
    return null;
  }

  /**
   * This function tells why a lease cannot run beside a granted lease, or beside a lease that waits before it (H47). It
   * gives `null` when no lease conflicts. The granted leases come first.
   */
  #conflictOf(lease: Lease, granted: readonly Lease[], before: readonly Lease[]): string | null {
    for (const other of [...granted, ...before]) {
      const reason = this.#conflict(lease, other);
      if (reason !== null) return reason;
    }
    return null;
  }

  /** This function tells which amount does not fit at this time, or gives `null` when all fit. */
  #shortOf(lease: Lease, free: Record<string, number>): string | null {
    for (const [name, amount] of Object.entries(lease.amounts)) {
      const left = free[name] ?? 0;
      if (amount > left) return `waits for ${name}: needs ${amount}, ${Math.max(0, Math.floor(left))} free`;
    }
    return null;
  }

  #set(lease: Lease): Lease {
    this.#leases.set(lease.id, lease);
    return lease;
  }
}
