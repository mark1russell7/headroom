/**
 * The lease simulator. It operates the real lease broker of `@headroom/core` on a simulated clock. The broker gives the
 * room of each resource, the queue, the aging of the priority and the reserves. It also has the rules for spawn-heavy
 * jobs and browser tests (H47).
 *
 * The simulator replaces only the computer: the memory of each job, its process starts and its end. The broker decides
 * which lease starts and which lease waits, and it writes each reason.
 */

import { Broker, type Capacity, type Lease } from "@headroom/core/src/broker.ts";
import { CPU_RESERVE_DEFAULT } from "@headroom/core/src/cpu.ts";
import { rooms, type Measurement } from "@headroom/core/src/resources.ts";
import { BROWSER_SLOT, learnSpawn, leaseRate, promote, settle, SPAWN_HEAVY_DEFAULT, spawnConflict, startsSumConflict, windowRate } from "@headroom/core/src/spawn.ts";
import { MEMORY } from "@headroom/core/src/types.ts";
import { gb } from "@headroom/core/src/units.ts";
import { KINDS, kindOf, type JobKind, type Machine } from "./catalog.ts";

/** The memory that the broker keeps free for the system, in MB: the default of the daemon. */
export const RESERVE_MB = 1024;

/** The client of `headroom run` reports the process count of its job at this interval, in seconds. */
const REPORT_SECONDS = 5;

/** How a job ended. */
export type Outcome = "done" | "stopped" | "cancelled";

/** One job of the simulator and its lease. */
interface Job {
  readonly kind: JobKind;
  readonly leaseId: string;
  /** The memory of the job at this time, in MB. */
  memoryMb: number;
  /** The highest memory of the job, in MB. */
  peakMb: number;
  /** The processes that the job started so far. */
  processes: number;
  /** The process counts of the reports: `[at, processes]`, the oldest first. */
  readonly points: [number, number][];
  outcome: Outcome | null;
}

/** One line of the event log. */
export interface SimEvent {
  /** The simulated time, in seconds. */
  readonly at: number;
  readonly leaseId: string;
  readonly job: string;
  readonly tone: "grant" | "wait" | "done" | "stop" | "cancel";
  readonly text: string;
}

/** One lease as the page shows it. */
export interface Row {
  readonly id: string;
  readonly kind: string;
  readonly color: number;
  readonly job: string;
  readonly holder: string;
  readonly state: Lease["state"];
  readonly reason: string | null;
  readonly leaseMb: number;
  readonly cpu: number;
  readonly browser: boolean;
  /** True: the broker classes the job as spawn-heavy. */
  readonly heavy: boolean;
  readonly usedMb: number;
  readonly peakMb: number;
  /** The part of the run time that passed, from 0 to 1. */
  readonly progress: number;
  readonly requestedAt: number;
  readonly grantedAt: number | null;
  readonly endedAt: number | null;
  readonly outcome: Outcome | null;
}

/** The state of the simulator at one time. */
export interface View {
  /** The simulated time, in seconds. */
  readonly now: number;
  readonly machine: Machine;
  readonly enforce: boolean;
  readonly memory: {
    readonly totalMb: number;
    readonly otherMb: number;
    readonly reserveMb: number;
    readonly availableMb: number;
  };
  readonly cpu: { readonly cores: number; readonly reserve: number };
  /** The amounts that a new lease can get at this time, from `Broker.free()`. */
  readonly free: Readonly<Record<string, number>>;
  readonly waiting: readonly Row[];
  readonly running: readonly Row[];
  /** The ended leases, the newest first. */
  readonly ended: readonly Row[];
  /** All the leases, in the order of their requests. */
  readonly all: readonly Row[];
  /** The newest events first. */
  readonly events: readonly SimEvent[];
}

/** This function gives the memory of a job after a run time in seconds, in MB. */
export function memoryAt(kind: JobKind, seconds: number): number {
  if (kind.leakMbPerSecond > 0) return Math.round(300 + kind.leakMbPerSecond * seconds);
  const ramp = Math.min(1, seconds / Math.max(1, kind.seconds * 0.25));
  const wave = 0.94 + 0.06 * Math.sin(seconds / 2.5);
  return Math.round(kind.peakMb * ramp * wave);
}

/** The lease simulator. */
export class Simulation {
  readonly #machine: Machine;
  readonly #broker: Broker;
  readonly #jobs = new Map<string, Job>();
  /** The peak starts in one minute of the past runs of each job name. */
  readonly #peaks = new Map<string, number[]>();
  readonly #events: SimEvent[] = [];
  /** The state and the reason of each lease at the last event. */
  readonly #seen = new Map<string, string>();
  #now = 0;
  #count = 0;
  #enforce: boolean;

  constructor(machine: Machine, enforce = true) {
    this.#machine = machine;
    this.#enforce = enforce;
    for (const kind of KINDS) this.#peaks.set(kind.job, [...kind.pastPeaks]);
    this.#broker = new Broker({
      now: () => this.#now,
      newId: () => `L${++this.#count}`,
      reserveMb: RESERVE_MB,
      used: (lease, id) => (id === MEMORY ? (this.#jobs.get(lease.id)?.memoryMb ?? 0) : 0),
      conflict: spawnConflict,
      groupConflict: (lease, granted, before) => startsSumConflict(lease, granted, before, (each) => this.#rate(each), SPAWN_HEAVY_DEFAULT),
    });
  }

  /** The simulated time, in seconds. */
  get now(): number {
    return this.#now / 1000;
  }

  get machine(): Machine {
    return this.#machine;
  }

  get enforce(): boolean {
    return this.#enforce;
  }

  /** This function turns the memory limit of the leases on or off. Without it, the leases are advisory. */
  setEnforce(on: boolean): void {
    this.#enforce = on;
  }

  /** This function asks for a lease for a job of a kind, as `headroom run` does. The broker examines the queue at once. */
  add(kindId: string, holder?: string): Lease {
    const kind = kindOf(kindId);
    const amounts: Record<string, number> = { [MEMORY]: kind.memoryMb, cpu: kind.cpu };
    if (kind.browser) amounts[BROWSER_SLOT] = 1;
    const spawn = learnSpawn(this.#peaks.get(kind.job) ?? [], SPAWN_HEAVY_DEFAULT);
    const lease = this.#broker.request({ holder: holder ?? kind.holder, job: kind.job, amounts }, spawn);
    this.#jobs.set(lease.id, { kind, leaseId: lease.id, memoryMb: 0, peakMb: 0, processes: 0, points: [], outcome: null });
    this.#tick();
    return this.#broker.get(lease.id) ?? lease;
  }

  /** This function takes a waiting lease off the queue, as `headroom cancel` does. */
  cancel(id: string): void {
    const lease = this.#broker.cancel(id, "you");
    const job = this.#jobs.get(id);
    if (lease?.state === "cancelled" && job !== undefined) {
      job.outcome = "cancelled";
      this.#log(lease, "cancel", "cancelled: it left the queue");
    }
    this.#tick();
  }

  /** This function stops a running job. Its lease ends, and the broker examines the queue. */
  stop(id: string): void {
    const job = this.#jobs.get(id);
    const lease = this.#broker.get(id);
    if (job === undefined || lease?.state !== "granted") return;
    this.#end(job, "stopped", "you stopped the job", { code: null, signal: "SIGTERM" });
    this.#tick();
  }

  /** This function moves the clock forward by some seconds, one second at a time. */
  step(seconds = 1): void {
    for (let i = 0; i < seconds; i += 1) this.#second();
  }

  /** This function gives the free amounts of the broker at this time. */
  free(): Record<string, number> {
    return this.#broker.free(this.#capacity());
  }

  /** This function gives the state of the simulator for the page. */
  view(): View {
    const all = this.#broker
      .leases()
      .sort((a, b) => a.requestedAt - b.requestedAt || Number(a.id.slice(1)) - Number(b.id.slice(1)))
      .map((lease) => this.#row(lease));
    const capacity = this.#capacity();
    return {
      now: this.now,
      machine: this.#machine,
      enforce: this.#enforce,
      memory: { totalMb: this.#machine.memoryMb, otherMb: this.#machine.otherMb, reserveMb: RESERVE_MB, availableMb: capacity.availableMb },
      cpu: { cores: this.#machine.cores, reserve: CPU_RESERVE_DEFAULT },
      free: this.#broker.free(capacity),
      waiting: all.filter((row) => row.state === "waiting"),
      running: all.filter((row) => row.state === "granted"),
      ended: all.filter((row) => row.state !== "waiting" && row.state !== "granted").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
      all,
      events: [...this.#events].reverse(),
    };
  }

  #second(): void {
    this.#now += 1000;
    for (const job of this.#jobs.values()) {
      const lease = this.#broker.get(job.leaseId);
      if (lease?.state !== "granted" || lease.grantedAt === null) continue;
      const ran = (this.#now - lease.grantedAt) / 1000;
      job.memoryMb = memoryAt(job.kind, ran);
      job.processes += job.kind.startsPerMinute / 60;
      if (ran % REPORT_SECONDS === 0) this.#report(job, lease);
      const limit = lease.amounts[MEMORY] ?? 0;
      if (this.#enforce && job.memoryMb > limit) {
        // The job object refuses an allocation above the limit, so the job fails with an error of its own.
        job.memoryMb = limit;
        job.peakMb = Math.max(job.peakMb, limit);
        this.#end(job, "stopped", `it asked for more than its lease of ${gb(limit)}, so the memory limit stopped it`, { code: 1, signal: null });
        continue;
      }
      job.peakMb = Math.max(job.peakMb, job.memoryMb);
      if (ran >= job.kind.seconds) this.#end(job, "done", "released", { code: 0, signal: null });
    }
    // Without the limit, a job can take the free memory of the computer. At 0, the system stops the largest job.
    if (this.#availableMb() <= 0) {
      const largest = [...this.#jobs.values()].filter((job) => this.#broker.get(job.leaseId)?.state === "granted").sort((a, b) => b.memoryMb - a.memoryMb)[0];
      if (largest !== undefined) this.#end(largest, "stopped", "the computer ran out of memory, so the system stopped the largest job", { code: null, signal: "SIGKILL" });
    }
    for (const lease of this.#broker.leases()) if (lease.state === "waiting" || lease.state === "granted") this.#broker.renew(lease.id, this.#jobs.get(lease.id)?.processes);
    this.#tick();
  }

  /** This function records a report of the process count, and measures the peak starts of the job (H47). */
  #report(job: Job, lease: Lease): void {
    job.points.push([this.#now, Math.round(job.processes)]);
    const rate = windowRate(job.points);
    if (rate === null) return;
    const peak = Math.max(lease.peakStartsPerMin ?? 0, Math.round(rate));
    const spawn = settle(promote(lease.spawn, rate, SPAWN_HEAVY_DEFAULT), job.points, SPAWN_HEAVY_DEFAULT);
    this.#broker.update(lease.id, { peakStartsPerMin: peak, ...(spawn === undefined ? {} : { spawn }) });
  }

  /** This function gives the rate of starts of a lease for the sum rule, as the engine of the daemon does. */
  #rate(lease: Lease): number {
    const job = this.#jobs.get(lease.id);
    return leaseRate(lease, lease.state === "granted" && job !== undefined ? windowRate(job.points) : null);
  }

  #end(job: Job, outcome: Outcome, reason: string, exit: { code: number | null; signal: string | null }): void {
    job.outcome = outcome;
    const lease = this.#broker.release(job.leaseId, reason, job.peakMb, undefined, exit, Math.round(job.processes));
    if (lease === undefined) return;
    const peaks = this.#peaks.get(job.kind.job) ?? [];
    if (lease.peakStartsPerMin !== undefined) peaks.push(lease.peakStartsPerMin);
    this.#peaks.set(job.kind.job, peaks.slice(-20));
    this.#log(lease, outcome === "done" ? "done" : "stop", outcome === "done" ? `ended after ${job.kind.seconds} s, peak ${gb(job.peakMb)}` : `stopped: ${reason}`);
    job.memoryMb = 0;
  }

  #availableMb(): number {
    let used = 0;
    for (const job of this.#jobs.values()) if (this.#broker.get(job.leaseId)?.state === "granted") used += job.memoryMb;
    return this.#machine.memoryMb - this.#machine.otherMb - used;
  }

  /** This function gives the capacity of this time, with the rooms of the resource model, as the engine does. */
  #capacity(): Capacity {
    const { memoryMb, cores, browsers } = this.#machine;
    const availableMb = Math.max(0, this.#availableMb());
    const cpuUsed = this.#broker.leases().reduce((sum, lease) => sum + (lease.state === "granted" ? (lease.amounts["cpu"] ?? 0) : 0), 0);
    const measurements: Measurement[] = [
      { id: MEMORY, capacity: memoryMb, used: memoryMb - availableMb, free: availableMb },
      { id: "cpu", capacity: cores, used: cpuUsed, free: cores - cpuUsed },
    ];
    const pools = { [BROWSER_SLOT]: browsers };
    const result = rooms([MEMORY, "cpu", BROWSER_SLOT], measurements, pools, { [MEMORY]: RESERVE_MB, cpu: CPU_RESERVE_DEFAULT });
    return { totalMb: memoryMb, availableMb, pools, rooms: result };
  }

  #tick(): void {
    for (const lease of this.#broker.tick(this.#capacity())) {
      // A wait for memory gives a new free amount at each tick. The log keeps one line until the kind of wait changes.
      const key = `${lease.state}|${(lease.reason ?? "").replace(/[\d,.]+/g, "#")}`;
      if (this.#seen.get(lease.id) === key) continue;
      this.#seen.set(lease.id, key);
      const job = this.#jobs.get(lease.id);
      if (lease.state === "granted") this.#log(lease, "grant", "got its lease and started");
      else if (lease.state === "waiting" && lease.reason !== null) this.#log(lease, "wait", lease.reason);
      else if (lease.state === "cancelled" && job !== undefined) {
        job.outcome = "cancelled";
        this.#log(lease, "cancel", `cancelled: ${lease.reason ?? "it can never fit"}`);
      }
    }
  }

  #log(lease: Lease, tone: SimEvent["tone"], text: string): void {
    this.#events.push({ at: this.now, leaseId: lease.id, job: `${lease.job} (${lease.holder})`, tone, text });
    if (this.#events.length > 60) this.#events.shift();
  }

  #row(lease: Lease): Row {
    const job = this.#jobs.get(lease.id);
    const kind = job?.kind ?? kindOf("test");
    const ran = lease.grantedAt === null ? 0 : ((lease.endedAt ?? this.#now) - lease.grantedAt) / 1000;
    return {
      id: lease.id,
      kind: kind.id,
      color: kind.color,
      job: lease.job,
      holder: lease.holder,
      state: lease.state,
      reason: lease.reason,
      leaseMb: lease.amounts[MEMORY] ?? 0,
      cpu: lease.amounts["cpu"] ?? 0,
      browser: (lease.amounts[BROWSER_SLOT] ?? 0) > 0,
      heavy: lease.spawn?.heavy === true,
      usedMb: lease.state === "granted" ? (job?.memoryMb ?? 0) : 0,
      peakMb: job?.peakMb ?? 0,
      progress: Math.min(1, ran / kind.seconds),
      requestedAt: lease.requestedAt / 1000,
      grantedAt: lease.grantedAt === null ? null : lease.grantedAt / 1000,
      endedAt: lease.endedAt === null ? null : lease.endedAt / 1000,
      outcome: job?.outcome ?? null,
    };
  }
}
