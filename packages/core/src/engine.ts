/**
 * The engine joins the sampler, the owners, the broker and the store. It has no timer: its caller
 * calls `tick()` every few seconds, and after each request and each release.
 */

import { DEFAULT_ALERT_RULES, detect, type Alert, type AlertRules, type DiskInput } from "./alerts.ts";
import { Broker, isActive, type Capacity, type Lease, type LeaseRequest } from "./broker.ts";
import { largeFileDirs, largeFiles, type LargeFile } from "./disks.ts";
import { availableParallelism } from "node:os";
import { attribute, readSessions, sessionsDir, treeMb } from "./owners.ts";
import {
  leasesOf,
  measure,
  resourceOf,
  rooms,
  withKinds,
  type JobUsage,
  type Measurement,
  type Owners,
  type Readings,
  type ResourceId,
  type ResourceStatus,
} from "./resources.ts";
import type { Sampler } from "./sampler.ts";
import type { Config, MemoryRow, OwnerRow, Store } from "./store.ts";
import { checkJobTemp, sweepJobTemp } from "./temp.ts";
import { diskSize } from "./units.ts";
import { MEMORY, type DiskSpace, type McpServerSpec, type OwnerUsage, type ProcessInfo, type SessionInfo, type SessionLoad, type SystemMemory } from "./types.ts";

/** The options of an engine. */
export interface EngineOptions {
  readonly sampler: Sampler;
  readonly store: Store;
  readonly now?: (() => number) | undefined;
  /** The memory that the broker keeps free, in MB. The default is 1024. */
  readonly reserveMb?: number | undefined;
  /** The count of logical processors: the capacity of `cpu`. The default is `os.availableParallelism()`. */
  readonly processors?: number | undefined;
  /** The limits of the alerts. The default is `DEFAULT_ALERT_RULES`. */
  readonly alertRules?: AlertRules | undefined;
  /** The time between two reads of the process list. The default is 10 seconds. */
  readonly processEveryMs?: number | undefined;
  /** The time between two samples in the store. The default is 1 minute. */
  readonly recordEveryMs?: number | undefined;
  /** The time that the store keeps the samples and the ended leases. The default is 7 days. */
  readonly retentionMs?: number | undefined;
  /** The folder of the Claude Code session files. */
  readonly sessionsDir?: string | undefined;
  /** This function gives the process of each server of the MCP gateway, with the name of the server. */
  readonly servers?: (() => ReadonlyMap<number, string>) | undefined;
  /**
   * This function gives the new large files for the drives of the disk alerts. The default reads the home folder, the
   * downloads, the temporary folders and the root of each drive. It gives the 3 largest files above 1 GB of the last 2 hours.
   */
  readonly largeFiles?: ((mounts: readonly string[]) => readonly LargeFile[]) | undefined;
}

/** One fixed drive, with the speed at which its free space decreases. */
export interface DiskStatus extends DiskSpace {
  /** The free space that the drive loses in one hour, in MB, over the last hour. It is 0 when the free space grew. */
  readonly dropMbPerHour: number;
}

/** The state of the engine at one time. */
export interface Status {
  readonly at: number;
  readonly memory: SystemMemory;
  readonly reserveMb: number;
  /** The amounts that a new lease can get at this time. */
  readonly free: Record<string, number>;
  readonly pools: Record<string, number>;
  readonly leases: readonly Lease[];
  readonly owners: readonly OwnerUsage[];
  readonly sessions: readonly SessionInfo[];
  /** The active alerts, the oldest first. */
  readonly alerts: readonly Alert[];
  /** The process of the daemon: its ID, its private memory in MB from the last read of the processes, and its start. */
  readonly self: { readonly pid: number; readonly privateMb: number; readonly startedAt: number };
  /** The processes and the USER and GDI objects of the session, from the last read of the processes. */
  readonly session: SessionLoad;
  /** The fixed drives, from the last read of the processes. */
  readonly disks: readonly DiskStatus[];
  /** The level of each resource instance: the memory, the commit charge, the kernel pools, the desktop, the drives, the processors and the slots. */
  readonly resources: readonly ResourceStatus[];
}

/** An alert that ended. */
export interface EndedAlert extends Alert {
  readonly endedAt: number;
}

/** A memory amount for a job, from the peaks of its last runs. */
export interface Suggestion {
  /** The amount in MB, or `null` when no run of the job has a peak. */
  readonly memoryMb: number | null;
  /** The number of runs that the amount uses. */
  readonly runs: number;
  /** The highest peak of those runs in MB. */
  readonly peakMb: number | null;
}

/** One pool tag: its non-paged size and its change over the window, in MB. */
export interface PoolTagRow {
  readonly tag: string;
  readonly nonPagedMb: number;
  readonly growthMb: number;
}

/** The non-paged pool by tag over the last hour. */
export interface PoolTags {
  /** The time of the last snapshot. It is `null` before the first snapshot, and on a platform with no tags. */
  readonly at: number | null;
  /** The time of the first snapshot of the window. */
  readonly sinceAt: number | null;
  readonly largest: readonly PoolTagRow[];
  readonly growing: readonly PoolTagRow[];
  /** The tags whose paged pool grew most over the window. */
  readonly pagedGrowing: readonly { readonly tag: string; readonly pagedMb: number; readonly growthMb: number }[];
}

/** The time that an event alert stays active. */
const EVENT_MS = 15 * 60_000;
/** The window in which two cut clients of `headroom run` start a stop alert. */
const STOP_WINDOW_MS = 2 * 60_000;
const POOL_TAGS_EVERY_MS = 5 * 60_000;
const POOL_TAGS_KEEP_MS = 60 * 60_000;
/** The window of the readings of the free space of the drives. */
const DISK_KEEP_MS = 60 * 60_000;
/** A window shorter than this counts as this long, so one short write does not give a large speed. */
const DISK_MIN_SPAN_MS = 10 * 60_000;
/** The time between two searches for large files while a disk alert is active. */
const FILES_EVERY_MS = 5 * 60_000;
const FILES_SINCE_MS = 2 * 3_600_000;
const round = (mb: number): number => Math.round(mb * 10) / 10;

/** The active alerts and the alerts that ended last. */
export interface Alerts {
  readonly active: readonly Alert[];
  readonly ended: readonly EndedAlert[];
}

/** One point of the history of a resource instance: the time, the used part and the free part, in the unit of its kind. */
export type ResourcePoint = readonly [at: number, used: number | null, free: number | null];

/** The history since a time. */
export interface History {
  readonly memory: readonly MemoryRow[];
  readonly owners: readonly OwnerRow[];
  readonly leases: readonly Lease[];
  /** The points of each resource instance, by id, the oldest first. A step longer than one minute averages each step. */
  readonly resources: Readonly<Record<ResourceId, readonly ResourcePoint[]>>;
}

/** This function rounds an amount of a resource to 2 decimals, so a long history stays small. */
const point = (value: number | null): number | null => (value === null ? null : Math.round(value * 100) / 100);

/** The engine. */
export class Engine {
  readonly #sampler: Sampler;
  readonly #store: Store;
  readonly #broker: Broker;
  readonly #now: () => number;
  readonly #reserveMb: number;
  readonly #processEveryMs: number;
  /** The snapshots of the non-paged pool by tag, in MB, of the last hour. */
  #tags: { readonly at: number; readonly tags: ReadonlyMap<string, number>; readonly paged: ReadonlyMap<string, number> }[] = [];
  #tagsAt = 0;
  readonly #recordEveryMs: number;
  readonly #retentionMs: number;
  readonly #sessionsDir: string;
  readonly #servers: () => ReadonlyMap<number, string>;
  readonly #listeners = new Set<(changed: readonly Lease[]) => void>();
  #memory: SystemMemory;
  #processes: readonly ProcessInfo[] = [];
  /** The processes of the read before the last read. */
  #previous: readonly ProcessInfo[] = [];
  readonly #processors: number;
  /** The reads of the last call of `capacity()`. The admit parts read them. */
  #readings: Readings | null = null;
  /** The measurements of the last call of `capacity()`. */
  #measurements: readonly Measurement[] = [];
  /** The owner of each process, from the last read of the processes. */
  #ownership: Owners = { ownerOf: new Map(), kindOf: new Map(), leaseOf: new Map() };
  #owners: readonly OwnerUsage[] = [];
  #load: SessionLoad = { processes: 0, userObjects: null, gdiObjects: null };
  #disks: readonly DiskSpace[] = [];
  /** The free space of each drive, in MB, over the last hour. */
  readonly #diskReadings = new Map<string, { readonly at: number; readonly freeMb: number }[]>();
  readonly #largeFiles: (mounts: readonly string[]) => readonly LargeFile[];
  /** The last search for large files: its time, the drives of its alerts, and the files. */
  #files: { readonly at: number; readonly mounts: string; readonly list: readonly LargeFile[] } | null = null;
  readonly #alertRules: AlertRules;
  readonly #alerts = new Map<string, Alert>();
  #ended: EndedAlert[] = [];
  /** The event alerts, with the time when each one ends. */
  readonly #events = new Map<string, { readonly alert: Omit<Alert, "since">; readonly until: number }>();
  /** The leases of the last minutes that ended because their process exited. */
  #cut: { readonly at: number; readonly lease: Lease }[] = [];
  #sessions: readonly SessionInfo[] = [];
  #processesAt = 0;
  #recordedAt = 0;
  #prunedAt = 0;
  readonly #startedAt: number;

  constructor(options: EngineOptions) {
    this.#sampler = options.sampler;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#reserveMb = options.reserveMb ?? 1024;
    this.#processors = options.processors ?? availableParallelism();
    this.#processEveryMs = options.processEveryMs ?? 10_000;
    this.#recordEveryMs = options.recordEveryMs ?? 60_000;
    this.#retentionMs = options.retentionMs ?? 7 * 24 * 3_600_000;
    this.#sessionsDir = options.sessionsDir ?? sessionsDir();
    this.#servers = options.servers ?? (() => new Map());
    this.#alertRules = options.alertRules ?? DEFAULT_ALERT_RULES;
    this.#largeFiles = options.largeFiles ?? ((mounts) => largeFiles(largeFileDirs(mounts), this.#now() - FILES_SINCE_MS));
    this.#startedAt = this.#now();
    this.#broker = new Broker({
      now: this.#now,
      reserveMb: this.#reserveMb,
      // The admit part of the kind of each id tells the part of a granted lease that its job uses.
      used: (lease, id) => {
        const readings = this.#readings;
        return readings === null ? 0 : (resourceOf(id).admit?.used?.(lease, id, readings, this.#ownership) ?? 0);
      },
    });
    this.#broker.restore(this.#store.activeLeases());
    // The snapshots of the last hour continue after a restart, so the change of each tag has its full window.
    this.#tags = this.#store.poolTagsSince(this.#startedAt - POOL_TAGS_KEEP_MS);
    this.#tagsAt = this.#tags.at(-1)?.at ?? 0;
    this.#memory = this.#sampler.memory();
  }

  /**
   * This function gives the capacity at this time. It measures each kind. Each instance with an admit part,
   * each configured pool and each id of an active lease gets a room.
   */
  capacity(): Capacity {
    const readings = this.#read();
    const measurements = measure(readings);
    this.#measurements = measurements;
    const ids = new Set<ResourceId>(measurements.filter((each) => resourceOf(each.id).admit !== null).map((each) => each.id));
    for (const id of Object.keys(readings.pools)) ids.add(id);
    for (const lease of this.#broker.leases()) if (isActive(lease)) for (const id of Object.keys(lease.amounts)) ids.add(id);
    return {
      totalMb: this.#memory.totalMb,
      availableMb: this.#memory.availableMb,
      pools: readings.pools,
      // The reserve of a drive is the critical limit of the disk alert.
      rooms: rooms(ids, measurements, readings.pools, { [MEMORY]: this.#reserveMb }, this.#alertRules),
    };
  }

  /** This function gives the reads of this time from the last samples, and keeps them for the admit parts. */
  #read(): Readings {
    const granted: Record<ResourceId, number> = {};
    for (const lease of this.#broker.leases()) {
      if (lease.state !== "granted") continue;
      for (const [id, amount] of Object.entries(lease.amounts)) granted[id] = (granted[id] ?? 0) + amount;
    }
    this.#readings = {
      at: this.#now(),
      memory: this.#memory,
      processes: this.#processes,
      previous: this.#previous,
      disks: this.#disks,
      load: this.#load,
      processors: this.#processors,
      pools: this.#store.pools(),
      granted,
    };
    return this.#readings;
  }

  /**
   * This function reads the memory, and the processes when they are due. Then it ends and grants
   * leases, writes the changes to the store, and writes a sample when one is due.
   */
  tick(): Lease[] {
    const now = this.#now();
    this.#memory = this.#sampler.memory();
    if (now - this.#processesAt >= this.#processEveryMs) {
      this.#processesAt = now;
      this.#previous = this.#processes;
      this.#processes = this.#sampler.processes();
      this.#sessions = readSessions(this.#sessionsDir);
      const { owners, ownerOf } = attribute(this.#processes, this.#sessions, this.#memory, undefined, this.#servers());
      this.#owners = owners;
      this.#ownership = {
        ownerOf,
        kindOf: new Map(owners.map((owner) => [owner.owner, owner.kind])),
        leaseOf: leasesOf(this.#processes, this.#broker.leases()),
      };
      const gui = this.#sampler.gui?.();
      this.#load = { processes: this.#processes.length, userObjects: gui?.userObjects ?? null, gdiObjects: gui?.gdiObjects ?? null };
      if (this.#sampler.poolTags && now - this.#tagsAt >= POOL_TAGS_EVERY_MS) {
        this.#tagsAt = now;
        const read = this.#sampler.poolTags();
        const tags = new Map(read.map((tag) => [tag.tag, tag.nonPagedMb]));
        const paged = new Map(read.map((tag) => [tag.tag, tag.pagedMb]));
        this.#tags = [...this.#tags.filter((snapshot) => now - snapshot.at <= POOL_TAGS_KEEP_MS), { at: now, tags, paged }];
        this.#store.savePoolTags(now, read);
      }
      this.#readDisks(now);
      this.#check(now, ownerOf);
    }
    const changed = this.#broker.tick(this.capacity());
    this.#persist(changed);
    if (now - this.#recordedAt >= this.#recordEveryMs) {
      this.#recordedAt = now;
      this.#store.saveSample(now, this.#memory, this.#owners, this.#load, this.#measurements);
    }
    if (now - this.#prunedAt >= 3_600_000) {
      this.#prunedAt = now;
      this.#store.prune(now - this.#retentionMs);
      this.#broker.forget(now - 3_600_000);
    }
    return changed;
  }

  /** This function adds a request and grants it at once when it fits. */
  request(request: LeaseRequest): Lease {
    const lease = this.#broker.request(request);
    this.#persist([lease]);
    this.#persist(this.#broker.tick(this.capacity()));
    return this.#broker.get(lease.id) ?? lease;
  }

  /** This function ends a lease. Then it grants the waiting leases that fit in the amounts that the lease frees. */
  release(id: string, reason?: string, peakMb?: number | null, usage?: JobUsage): Lease | undefined {
    const lease = this.#broker.release(id, reason, peakMb ?? null, usage);
    if (lease) this.#persist([lease]);
    this.#persist(this.#broker.tick(this.capacity()));
    return lease ? (this.#broker.get(id) ?? lease) : undefined;
  }

  /**
   * This function gives a memory amount for a job from the peaks of its last runs. The amount is the 90th percentile
   * and 25% more, rounded up to 64 MB. It prefers the runs of the same holder. Without a run, it gives `null`.
   */
  suggest(job: string, holder?: string): Suggestion {
    const own = holder === undefined ? [] : this.#store.peaksOf(job, holder);
    const peaks = own.length > 0 ? own : this.#store.peaksOf(job);
    if (peaks.length === 0) return { memoryMb: null, runs: 0, peakMb: null };
    const sorted = [...peaks].sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0;
    return { memoryMb: Math.max(256, Math.ceil((p90 * 1.25) / 64) * 64), runs: peaks.length, peakMb: Math.round(sorted[sorted.length - 1] ?? 0) };
  }

  /** This function records a heartbeat of a lease. */
  renew(id: string): Lease | undefined {
    const lease = this.#broker.renew(id);
    if (lease) this.#store.saveLease(lease);
    return lease;
  }

  /** This function gives one lease. */
  get(id: string): Lease | undefined {
    return this.#broker.get(id);
  }

  /** This function sets the capacity of a pool. A capacity below 0 removes it. */
  setPool(name: string, capacity: number): void {
    this.#store.setPool(name, capacity);
    this.#persist(this.#broker.tick(this.capacity()));
  }

  /** This function gives the settings, for example the temp root of the jobs. */
  config(): Config {
    return this.#store.config();
  }

  /** This function changes one setting. `null` removes it. It refuses a temp root that is not an absolute folder. */
  setConfig(name: keyof Config, value: string | null): Config {
    this.#store.setConfig(name, value === null ? null : checkJobTemp(value));
    return this.#store.config();
  }

  /**
   * This function removes the temp folders of the ended leases under the temp root (H19). A folder whose name is not a
   * lease of the store, or whose lease is active, stays. It gives the names of the removed folders.
   */
  sweepJobTemp(): string[] {
    const root = this.#store.config().jobTemp;
    if (root === null) return [];
    return sweepJobTemp(root, (id) => {
      const lease = this.#store.lease(id);
      return lease !== null && !isActive(lease);
    });
  }

  /** This function reads the servers of the MCP gateway, by name. */
  mcpServers(): Record<string, McpServerSpec> {
    return this.#store.mcpServers();
  }

  /** This function adds or changes a server of the MCP gateway. `null` removes it. */
  setMcpServer(name: string, spec: McpServerSpec | null): void {
    this.#store.setMcpServer(name, spec);
  }

  /** This function gives the memory of one process and its descendants, in MB, from the last read of the processes. */
  treeMb(pid: number): number {
    return treeMb(pid, this.#processes);
  }

  /** This function gives the state at this time. */
  status(): Status {
    const capacity = this.capacity();
    return {
      at: this.#now(),
      memory: this.#memory,
      reserveMb: this.#reserveMb,
      free: this.#broker.free(capacity),
      pools: { ...capacity.pools },
      leases: this.#broker.leases().filter(isActive),
      owners: this.#owners,
      sessions: this.#sessions,
      alerts: [...this.#alerts.values()],
      session: this.#load,
      disks: this.#disks.map((disk) => ({ mount: disk.mount, freeMb: disk.freeMb, totalMb: disk.totalMb, dropMbPerHour: this.#diskWindow(disk.mount).dropMbPerHour })),
      resources: withKinds(this.#measurements),
      self: {
        pid: process.pid,
        privateMb: Math.round(this.#processes.find((info) => info.pid === process.pid)?.privateMb ?? 0),
        startedAt: this.#startedAt,
      },
    };
  }

  /** This function gives the history since a time. With a step longer than one minute, each row is the average of one step. */
  history(since: number, stepMs = 0): History {
    const resources: Record<ResourceId, ResourcePoint[]> = {};
    for (const row of this.#store.resourcesSince(since, stepMs)) (resources[row.id] ??= []).push([row.at, point(row.used), point(row.free)]);
    return {
      memory: this.#store.memorySince(since, stepMs),
      owners: this.#store.ownersSince(since, stepMs),
      leases: this.#store.endedLeases(since),
      resources,
    };
  }

  /** This function calls the listener with the leases that change. It gives a function that removes the listener. */
  onChange(listener: (changed: readonly Lease[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** This function waits until a lease is no longer waiting, the signal aborts, or the time ends. */
  waitFor(id: string, options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {}): Promise<Lease> {
    return new Promise((resolve, reject) => {
      const lease = this.#broker.get(id);
      if (!lease) return reject(new Error(`No lease has the id ${id}`));
      if (lease.state !== "waiting" || options.signal?.aborted) return resolve(lease);
      const done = (): void => {
        off();
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", aborted);
        resolve(this.#broker.get(id) ?? lease);
      };
      const aborted = (): void => done();
      const off = this.onChange((changed) => {
        if (changed.some((each) => each.id === id && each.state !== "waiting")) done();
      });
      const timer = setTimeout(done, options.timeoutMs ?? 600_000);
      options.signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  /**
   * This function gives the non-paged pool by tag: the largest tags, and the change of each tag over the
   * snapshots of the last hour. A driver that leaks shows as a tag that grows. Only Windows has tags.
   */
  poolTags(limit = 20): PoolTags {
    const last = this.#tags.at(-1);
    const first = this.#tags[0];
    if (!last || !first) return { at: null, sinceAt: null, largest: [], growing: [], pagedGrowing: [] };
    const rows = [...last.tags].map(([tag, mb]) => ({ tag, nonPagedMb: round(mb), growthMb: round(mb - (first.tags.get(tag) ?? 0)) }));
    return {
      at: last.at,
      sinceAt: first.at,
      largest: [...rows].sort((a, b) => b.nonPagedMb - a.nonPagedMb).slice(0, limit),
      growing: rows.filter((row) => row.growthMb > 0).sort((a, b) => b.growthMb - a.growthMb).slice(0, limit),
      pagedGrowing: [...last.paged]
        .map(([tag, mb]) => ({ tag, pagedMb: round(mb), growthMb: round(mb - (first.paged.get(tag) ?? 0)) }))
        .filter((row) => row.growthMb > 0)
        .sort((a, b) => b.growthMb - a.growthMb)
        .slice(0, limit),
    };
  }

  /** This function gives the active alerts and the alerts that ended last. */
  alerts(): Alerts {
    return { active: [...this.#alerts.values()], ended: [...this.#ended] };
  }

  /** This function checks the conditions of the alerts. A condition that continues keeps its start time. */
  #check(now: number, ownerOf: ReadonlyMap<number, string>): void {
    const kindOf = new Map(this.#owners.map((owner) => [owner.owner, owner.kind]));
    // The growth of the pool is measured over one hour. A history shorter than 50 minutes gives no growth.
    const first = this.#store.memorySince(now - 3_600_000)[0];
    const hourOld = first !== undefined && now - first.at > 50 * 60_000;
    const poolHourAgoMb = hourOld ? first.kernelNonpagedMb : undefined;
    const pagedHourAgoMb = hourOld ? first.kernelPagedMb : undefined;
    const disks: DiskInput[] = this.#disks.map((disk) => {
      const { droppedMb, windowMinutes } = this.#diskWindow(disk.mount);
      return { ...disk, droppedMb, windowMinutes };
    });
    const found = detect(
      { memory: this.#memory, processes: this.#processes, ownerOf, kindOf, leases: this.#broker.leases(), poolHourAgoMb, pagedHourAgoMb, load: this.#load, disks },
      this.#alertRules,
    );
    this.#nameLargeFiles(now, found);
    // A pool alert names the tags that grow, so the reader can find the driver.
    const growing = this.poolTags(3).growing.filter((row) => row.growthMb >= 1);
    const named = growing.length === 0 ? "" : ` The tags that grow: ${growing.map((row) => `${row.tag.trim()} +${row.growthMb} MB`).join(", ")}.`;
    const pagedGrowing = this.poolTags(3).pagedGrowing.filter((row) => row.growthMb >= 1);
    const pagedNamed = pagedGrowing.length === 0 ? "" : ` The tags that grow: ${pagedGrowing.map((row) => `${row.tag.trim()} +${row.growthMb} MB`).join(", ")}.`;
    for (const [index, alert] of found.entries()) {
      if (alert.id === "pool" && named) found[index] = { ...alert, message: `${alert.message}${named}` };
      if (alert.id === "pool:paged" && pagedNamed) found[index] = { ...alert, message: `${alert.message}${pagedNamed}` };
    }
    for (const [id, event] of this.#events) {
      if (event.until <= now) this.#events.delete(id);
      else found.push(event.alert);
    }
    const ids = new Set(found.map((alert) => alert.id));
    for (const [id, alert] of this.#alerts) {
      if (ids.has(id)) continue;
      this.#alerts.delete(id);
      this.#ended = [{ ...alert, endedAt: now }, ...this.#ended].slice(0, 50);
    }
    for (const alert of found) this.#alerts.set(alert.id, { ...alert, since: this.#alerts.get(alert.id)?.since ?? now });
  }

  /** This function reads the free space of the fixed drives, and keeps the readings of the last hour. */
  #readDisks(now: number): void {
    if (!this.#sampler.disks) return;
    try {
      this.#disks = this.#sampler.disks();
    } catch {
      this.#disks = [];
    }
    const mounts = new Set(this.#disks.map((disk) => disk.mount));
    for (const mount of [...this.#diskReadings.keys()]) if (!mounts.has(mount)) this.#diskReadings.delete(mount);
    for (const disk of this.#disks) {
      const kept = (this.#diskReadings.get(disk.mount) ?? []).filter((reading) => now - reading.at <= DISK_KEEP_MS);
      this.#diskReadings.set(disk.mount, [...kept, { at: now, freeMb: disk.freeMb }]);
    }
  }

  /**
   * This function gives the free space that a drive lost over the window, from the oldest to the newest reading.
   * It also gives the length of the window and the loss in one hour. A loss is 0 when the free space grew.
   */
  #diskWindow(mount: string): { droppedMb: number; windowMinutes: number; dropMbPerHour: number } {
    const readings = this.#diskReadings.get(mount) ?? [];
    const oldest = readings[0];
    const newest = readings.at(-1);
    if (!oldest || !newest || newest.at <= oldest.at) return { droppedMb: 0, windowMinutes: 0, dropMbPerHour: 0 };
    const spanMs = newest.at - oldest.at;
    const droppedMb = Math.max(0, oldest.freeMb - newest.freeMb);
    return { droppedMb, windowMinutes: spanMs / 60_000, dropMbPerHour: Math.round((droppedMb * 3_600_000) / Math.max(spanMs, DISK_MIN_SPAN_MS)) };
  }

  /**
   * This function adds the new large files to each disk alert, so the reader can find the file that fills the drive.
   * It searches only while a disk alert is active, and at most one time in 5 minutes for the same drives.
   */
  #nameLargeFiles(now: number, found: Omit<Alert, "since">[]): void {
    const alerting = found.filter((alert) => alert.kind === "disk").map((alert) => alert.id.slice("disk:".length));
    if (alerting.length === 0) {
      this.#files = null;
      return;
    }
    const mounts = alerting.join("|");
    if (!this.#files || this.#files.mounts !== mounts || now - this.#files.at >= FILES_EVERY_MS) {
      let list: readonly LargeFile[] = [];
      try {
        list = this.#largeFiles(alerting);
      } catch {
        // The search is extra information. The alert continues without it.
      }
      this.#files = { at: now, mounts, list };
    }
    // Each file goes to the drive with the longest mount that starts its path.
    const mountOf = (path: string): string | undefined =>
      this.#disks
        .map((disk) => disk.mount)
        .filter((mount) => path.toLowerCase().startsWith(mount.toLowerCase()))
        .sort((a, b) => b.length - a.length)[0];
    for (const [index, alert] of found.entries()) {
      if (alert.kind !== "disk") continue;
      const files = this.#files.list.filter((file) => mountOf(file.path) === alert.id.slice("disk:".length));
      if (files.length === 0) continue;
      found[index] = { ...alert, message: `${alert.message} New large files: ${files.map((file) => `${file.path} (${diskSize(file.mb)})`).join(", ")}.` };
    }
  }

  /** This function closes the store and the sampler. */
  close(): void {
    this.#listeners.clear();
    this.#store.close();
    this.#sampler.close();
  }

  #persist(changed: readonly Lease[]): void {
    if (changed.length === 0) return;
    for (const lease of changed) this.#store.saveLease(lease);
    for (const listener of this.#listeners) listener(changed);
    this.#notice(changed);
  }

  /**
   * This function notes the clients of `headroom run` that stopped without a release. A client releases
   * its lease when its job ends. Thus several leases that end because their process exited show a broad stop.
   */
  #notice(changed: readonly Lease[]): void {
    const now = this.#now();
    const cut = changed.filter((lease) => lease.state === "expired" && lease.pid !== null);
    if (cut.length === 0) return;
    this.#cut = [...this.#cut.filter((entry) => now - entry.at <= STOP_WINDOW_MS), ...cut.map((lease) => ({ at: now, lease }))];
    if (this.#cut.length < 2) return;
    const holders = [...new Set(this.#cut.map((entry) => entry.lease.holder))].join(", ");
    this.note(
      {
        id: "stop:clients",
        kind: "stop",
        subject: "headroom run",
        pid: null,
        mb: 0,
        message: `${this.#cut.length} clients of headroom run stopped without a release in ${STOP_WINDOW_MS / 60_000} minutes (holders: ${holders}). Another process can have stopped them.`,
      },
      EVENT_MS,
    );
  }

  /** This function adds an event alert. It stays active for a time, and a second note of the same event starts the time again. */
  note(alert: Omit<Alert, "since">, forMs: number = EVENT_MS): void {
    const now = this.#now();
    const since = this.#alerts.get(alert.id)?.since ?? now;
    this.#events.set(alert.id, { alert, until: now + forMs });
    this.#alerts.set(alert.id, { ...alert, since });
  }
}
