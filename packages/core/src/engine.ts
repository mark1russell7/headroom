/**
 * The engine joins the sampler, the owners, the broker and the store. It has no timer: its caller
 * calls `tick()` every few seconds, and after each request and each release.
 */

import { DEFAULT_ALERT_RULES, detect, type Alert, type AlertRules, type DiskInput } from "./alerts.ts";
import { Broker, isActive, type Capacity, type JobExit, type Lease, type LeaseRequest } from "./broker.ts";
import { CounterTracker, type OwnerCores, type OwnerWrites } from "./counters.ts";
import { NO_STARTS, StartTracker, type ProcessStarts } from "./starts.ts";
import { largeFileDirs, largeFiles, type LargeFile } from "./disks.ts";
import { findJobs, type JobQuery, type JobState } from "./job-state.ts";
import { availableParallelism } from "node:os";
import { listeningPorts, tcpSummary, type TcpPorts, type TcpSummary } from "./network.ts";
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
import { keepAwakeReason, type PowerEvent, type PowerMode, type PowerStatus } from "./power.ts";
import { MB, type Sampler } from "./sampler.ts";
import { checkHealth, type ServiceHealth } from "./services.ts";
import type { Config, MemoryRow, OwnerRow, Sleep, Store } from "./store.ts";
import { checkJobTemp, sweepJobTemp } from "./temp.ts";
import { diskSize } from "./units.ts";
import {
  MEMORY,
  type BatteryRead,
  type DiskSpace,
  type McpServerSpec,
  type NetRead,
  type OwnerKind,
  type OwnerUsage,
  type PowerMeters,
  type ProcessInfo,
  type SessionInfo,
  type SessionLoad,
  type SystemMemory,
  type TcpTable,
} from "./types.ts";

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
  /** This function gives the health of each service after the last round of checks (H27). The default gives no service. */
  readonly services?: (() => readonly ServiceHealth[]) | undefined;
  /**
   * This function gives the new large files for the drives of the disk alerts. The default reads the home folder, the
   * downloads, the temporary folders and the root of each drive. It gives the 3 largest files above 1 GB of the last 2 hours.
   */
  readonly largeFiles?: ((mounts: readonly string[]) => readonly LargeFile[]) | undefined;
  /**
   * A time between two calls of the engine that counts as a sleep of the computer, also with no resume event (H30). The
   * daemon ticks every 2 seconds and sets 60 seconds. The default is no limit: only a resume event marks a sleep.
   */
  readonly sleepGapMs?: number | undefined;
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
  /**
   * The level of each resource instance, with its 10 largest owners. The instances are the memory, the commit charge, the
   * kernel pools, the desktop and the drives. Then come the processors, the network, the TCP ports, the services, the process
   * starts and the slots.
   */
  readonly resources: readonly ResourceStatus[];
  /**
   * The 10 owners that wrote most in the last hour, from the write counters of their processes (H20). The counters count
   * each write, also to a pipe or a device, and do not name the drive.
   */
  readonly writes: readonly OwnerWrites[];
  /** The TCP connections of the last read of the processes (H24), or `null` on a platform with no TCP read. */
  readonly tcp: TcpSummary | null;
  /**
   * The process starts of the last 10 minutes (H29): the computer, each owner with its jobs and its own commands, and each
   * leased job. The computer total is exact on Windows. The own commands of an owner are a lower bound.
   */
  readonly starts: ProcessStarts;
  /**
   * The power state (H30): the power source, the power mode, the lid and the efficiency mode of the jobs. It also has the
   * power request that keeps the computer awake, and the last sleep. The battery and the power are entries of `resources`.
   */
  readonly power: PowerStatus;
}

/** A change of the settings. A field that is absent stays as it is, and `null` removes the setting. */
export interface ConfigChange {
  readonly jobTemp?: string | null | undefined;
  readonly health?: Readonly<Record<string, string>> | null | undefined;
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
/** The shortest time that the store keeps an ended lease, for `headroom job` (H26). With a shorter retention, the leases stay this long. */
const LEASE_KEEP_MS = 7 * 24 * 3_600_000;
/** A window shorter than this counts as this long, so one short write does not give a large speed. */
const DISK_MIN_SPAN_MS = 10 * 60_000;
/** The time between two searches for large files while a disk alert is active. */
const FILES_EVERY_MS = 5 * 60_000;
const FILES_SINCE_MS = 2 * 3_600_000;
/** After a resume event, a time between two calls of the engine shorter than this is not a sleep. A tick that came first marked it. */
const MIN_SLEEP_MS = 5000;
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
  /** The sleeps of the computer in the window, the oldest first (H30). A chart draws no line across a sleep. */
  readonly sleeps: readonly Sleep[];
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
  /** The start of the computer, from the sampler, or 0 when the sampler does not give it. */
  readonly #bootedAt: number;
  readonly #recordEveryMs: number;
  readonly #retentionMs: number;
  readonly #sessionsDir: string;
  readonly #servers: () => ReadonlyMap<number, string>;
  readonly #services: () => readonly ServiceHealth[];
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
  /** The change of the processor time and of the written bytes of each owner (H20). */
  readonly #counters = new CounterTracker(["cpuMs", "writeBytes"]);
  /** The owners that wrote most in the last hour, from the last read of the processes. */
  #writes: readonly OwnerWrites[] = [];
  /** The cores of each owner over the last minute, from the last read of the processes. */
  #cores: readonly OwnerCores[] | undefined;
  /** The process starts of each owner and each leased job (H29). */
  readonly #startTracker = new StartTracker();
  /** The process starts of the last 10 minutes, from the last read of the processes or the last count of a job. */
  #starts: ProcessStarts = NO_STARTS;
  #load: SessionLoad = { processes: 0, userObjects: null, gdiObjects: null };
  #disks: readonly DiskSpace[] = [];
  /** The byte counters of the network adapters at the last read and at the read before it (H24). */
  #network: NetRead | undefined;
  #previousNetwork: NetRead | undefined;
  /** The TCP connections of the last read, and its time (H24). */
  #tcp: TcpTable | undefined;
  #tcpAt = 0;
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
  /** The last read of the battery and of the Energy Meter (H30). */
  #battery: BatteryRead | undefined;
  #meters: PowerMeters | undefined;
  /** The state from the power events: the power source, the lid and the power mode. */
  readonly #powerState: { ac: boolean | null; lidOpen: boolean | null; powerMode: PowerMode | null } = { ac: null, lidOpen: null, powerMode: null };
  /** A power event asks for a read of the battery at the next tick. A change of the power source also asks for a check of the alerts. */
  #batteryDue = false;
  #checkDue = false;
  /** The time of the last call of the engine, and a resume event that the next call handles. */
  #seenAt: number | null = null;
  #resumePending = false;
  readonly #sleepGapMs: number;
  /** The last sleep, and the end of the last sleep: the windows of growth start after it. */
  #lastSleep: { readonly from: number; readonly to: number } | null = null;
  #resumedAt = 0;
  /** The reason of the power request that keeps the computer awake, or `null` without a request. */
  #awake: string | null = null;

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
    this.#services = options.services ?? (() => []);
    this.#alertRules = options.alertRules ?? DEFAULT_ALERT_RULES;
    this.#largeFiles = options.largeFiles ?? ((mounts) => largeFiles(largeFileDirs(mounts), this.#now() - FILES_SINCE_MS));
    this.#sleepGapMs = options.sleepGapMs ?? Number.POSITIVE_INFINITY;
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
    this.#bootedAt = this.#sampler.bootedAt?.() ?? 0;
    // The snapshots of the last hour continue after a restart, so the change of each tag has its full window. A start of
    // the computer empties the pools, so the snapshots before it do not continue.
    this.#tags = this.#store.poolTagsSince(Math.max(this.#startedAt - POOL_TAGS_KEEP_MS, this.#bootedAt));
    this.#tagsAt = this.#tags.at(-1)?.at ?? 0;
    // The writes of the last hour continue after a restart, so a disk alert names the owners that filled the drive.
    this.#counters.restore("writeBytes", this.#store.writesSince(this.#startedAt - 3_600_000).map((row) => ({ ...row, amount: row.amount * MB })));
    this.#writes = this.#counters.writes(this.#startedAt);
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
    const leases: Lease[] = [];
    for (const lease of this.#broker.leases()) {
      if (lease.state !== "granted") continue;
      leases.push(lease);
      for (const [id, amount] of Object.entries(lease.amounts)) granted[id] = (granted[id] ?? 0) + amount;
    }
    this.#readings = {
      at: this.#now(),
      memory: this.#memory,
      processes: this.#processes,
      previous: this.#previous,
      writes: this.#writes,
      cores: this.#cores,
      disks: this.#disks,
      load: this.#load,
      processors: this.#processors,
      pools: this.#store.pools(),
      granted,
      network: this.#network,
      previousNetwork: this.#previousNetwork,
      tcp: this.#tcp,
      services: this.#services(),
      starts: this.#starts,
      battery: this.#battery,
      meters: this.#meters,
      leases,
    };
    return this.#readings;
  }

  /**
   * This function reads the memory, and the processes when they are due. Then it ends and grants
   * leases, writes the changes to the store, and writes a sample when one is due.
   */
  tick(): Lease[] {
    const now = this.#clock();
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
      this.#counters.read(now, this.#processes, ownerOf, this.#ownership.kindOf);
      this.#writes = this.#counters.writes(now);
      this.#cores = this.#counters.cores(now);
      this.#startTracker.read(now, this.#processes, this.#ownership, this.#sampler.processSequence?.(), this.#broker.leases());
      this.#starts = this.#startTracker.summary(now);
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
      this.#readNetwork(now);
      this.#readBattery();
      this.#readMeters();
      this.#check(now, ownerOf);
    } else if (this.#batteryDue) {
      // A power event: the battery is cheap to read, so the tick reads it before the next read of the processes.
      this.#readBattery();
      if (this.#checkDue) this.#check(now, this.#ownership.ownerOf);
    }
    const changed = this.#broker.tick(this.capacity());
    this.#persist(changed);
    this.#keepAwake();
    if (now - this.#recordedAt >= this.#recordEveryMs) {
      this.#recordedAt = now;
      this.#store.saveSample(now, this.#memory, this.#owners, this.#load, this.#measurements, this.#writtenMb(now));
    }
    if (now - this.#prunedAt >= 3_600_000) {
      this.#prunedAt = now;
      this.#store.prune(now - this.#retentionMs, now - Math.max(this.#retentionMs, LEASE_KEEP_MS));
      this.#broker.forget(now - 3_600_000);
    }
    return changed;
  }

  /** This function adds a request and grants it at once when it fits. */
  request(request: LeaseRequest): Lease {
    this.#clock();
    const lease = this.#broker.request(request);
    this.#persist([lease]);
    this.#persist(this.#broker.tick(this.capacity()));
    return this.#broker.get(lease.id) ?? lease;
  }

  /**
   * This function ends a lease. Then it grants the waiting leases that fit in the amounts that the lease frees. `processes`
   * is the count of processes that the job started, from its job object (H29).
   */
  release(id: string, reason?: string, peakMb?: number | null, usage?: JobUsage, exit?: JobExit, processes?: number): Lease | undefined {
    this.#clock();
    const lease = this.#broker.release(id, reason, peakMb ?? null, usage, exit, processes);
    if (lease) {
      this.#count(lease, processes);
      this.#persist([lease]);
    }
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

  /** This function finds the jobs of a query in the store, the newest first (H26). Without `all`, it gives at most one job. */
  jobs(query: JobQuery): JobState[] {
    return findJobs(this.#store, query, this.#now());
  }

  /** This function records a heartbeat of a lease. `processes` is the count of processes that its job started so far (H29). */
  renew(id: string, processes?: number): Lease | undefined {
    this.#clock();
    const lease = this.#broker.renew(id, processes);
    if (lease) {
      this.#count(lease, processes);
      this.#store.saveLease(lease);
    }
    return lease;
  }

  /** This function gives a count of the job object of a lease to the start tracker (H29). */
  #count(lease: Lease, processes: number | undefined): void {
    if (processes === undefined || lease.processes === undefined) return;
    const now = this.#now();
    this.#startTracker.report(lease, now, lease.processes, this.#ownership);
    this.#starts = this.#startTracker.summary(now);
  }

  /** This function gives one lease. */
  get(id: string): Lease | undefined {
    return this.#broker.get(id);
  }

  /** This function sets the capacity of a pool. A capacity below 0 removes it. */
  setPool(name: string, capacity: number): void {
    this.#clock();
    this.#store.setPool(name, capacity);
    this.#persist(this.#broker.tick(this.capacity()));
  }

  /** This function gives the settings, for example the temp root of the jobs. */
  config(): Config {
    return this.#store.config();
  }

  /**
   * This function changes the settings. `null` removes a setting. It refuses a temp root that is not an absolute folder, and
   * a URL of `health` that is not http or https. With an error, it changes no setting.
   */
  setConfig(change: ConfigChange): Config {
    const jobTemp = change.jobTemp === undefined || change.jobTemp === null ? change.jobTemp : checkJobTemp(change.jobTemp);
    const health = change.health === undefined || change.health === null ? change.health : JSON.stringify(checkHealth(change.health));
    if (jobTemp !== undefined) this.#store.setConfig("jobTemp", jobTemp);
    if (health !== undefined) this.#store.setConfig("health", health);
    return this.#store.config();
  }

  /** This function gives the health of each service after the last round of checks (H27). */
  services(): ServiceHealth[] {
    return [...this.#services()];
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
      resources: withKinds(this.#measurements, this.#readings === null ? undefined : { readings: this.#readings, owners: this.#ownership }),
      writes: this.#writes,
      tcp: this.#tcp === undefined ? null : tcpSummary(this.#tcp),
      starts: this.#starts,
      power: this.powerStatus(),
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
      sleeps: this.#store.sleepsSince(since),
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
   * The window starts at the start of the computer or at the last wake, so it compares no snapshots across a start or a sleep.
   */
  poolTags(limit = 20): PoolTags {
    const window = this.#tags.filter((snapshot) => snapshot.at >= Math.max(this.#bootedAt, this.#resumedAt));
    const last = window.at(-1);
    const first = window[0];
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

  /**
   * This function gives the listening TCP ports of the last read, with the process and the owner of each port, by port.
   * A session can find a free port for a dev server, or the holder of a port.
   */
  ports(): TcpPorts {
    const tcp = this.#tcp;
    if (tcp === undefined) return { at: null, dynamic: null, listening: [] };
    return { at: this.#tcpAt, dynamic: tcp.dynamic, listening: listeningPorts(tcp, this.#processes, this.#ownership.ownerOf) };
  }

  /** This function gives the active alerts and the alerts that ended last. */
  alerts(): Alerts {
    return { active: [...this.#alerts.values()], ended: [...this.#ended] };
  }

  /** This function checks the conditions of the alerts. A condition that continues keeps its start time. */
  #check(now: number, ownerOf: ReadonlyMap<number, string>): void {
    this.#checkDue = false;
    const kindOf = new Map(this.#owners.map((owner) => [owner.owner, owner.kind]));
    // The growth of the pool is measured over one hour. A history shorter than 50 minutes gives no growth. A start of the
    // computer empties the pools, so the history starts at the start of the computer or later. A sleep stops the growth,
    // so the history also starts at the last wake (H30).
    const first = this.#store.memorySince(Math.max(now - 3_600_000, this.#bootedAt, this.#resumedAt))[0];
    const hourOld = first !== undefined && now - first.at > 50 * 60_000;
    const poolHourAgoMb = hourOld ? first.kernelNonpagedMb : undefined;
    const pagedHourAgoMb = hourOld ? first.kernelPagedMb : undefined;
    const disks: DiskInput[] = this.#disks.map((disk) => {
      const { droppedMb, windowMinutes } = this.#diskWindow(disk.mount);
      return { ...disk, droppedMb, windowMinutes };
    });
    const found = detect(
      {
        memory: this.#memory, processes: this.#processes, ownerOf, kindOf, leases: this.#broker.leases(), poolHourAgoMb, pagedHourAgoMb,
        load: this.#load, disks, writes: this.#writes, tcp: this.#tcp, services: this.#services(), starts: this.#starts,
        battery: this.#battery, meters: this.#meters, cores: this.#cores,
      },
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

  /** This function closes the minute of the counter tracker. It gives the MB that each owner wrote in the minute, for the store. */
  #writtenMb(now: number): Map<string, { readonly kind: OwnerKind; readonly mb: number }> {
    const written = new Map<string, { readonly kind: OwnerKind; readonly mb: number }>();
    for (const [owner, bytes] of this.#counters.close(now).get("writeBytes") ?? []) written.set(owner, { kind: this.#counters.kindOf(owner), mb: bytes / MB });
    return written;
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
   * This function reads the byte counters of the network adapters and the TCP connections (H24). It keeps the previous
   * read of the adapters for the throughput. A failed read gives no read, and the tick continues.
   */
  #readNetwork(now: number): void {
    if (this.#sampler.network) {
      this.#previousNetwork = this.#network;
      try {
        this.#network = { at: now, adapters: this.#sampler.network() };
      } catch {
        this.#network = undefined;
      }
    }
    if (this.#sampler.tcp) {
      try {
        this.#tcp = this.#sampler.tcp();
        this.#tcpAt = now;
      } catch {
        this.#tcp = undefined;
      }
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

  /**
   * This function takes one power event (H30). It only sets the state. The caller then asks for a tick, which reads the
   * battery, or makes a full read of the computer after a wake.
   */
  powerEvent(event: PowerEvent): void {
    switch (event.type) {
      case "source":
        // The alerts on the battery start or end with the power source, so the tick also checks the alerts.
        if (this.#powerState.ac !== event.ac) this.#checkDue = true;
        this.#powerState.ac = event.ac;
        this.#batteryDue = true;
        break;
      case "percent":
        this.#batteryDue = true;
        break;
      case "lid":
        this.#powerState.lidOpen = event.open;
        break;
      case "mode":
        this.#powerState.powerMode = event.mode;
        break;
      case "suspend":
        // The next call of the engine after the wake measures the sleep from its last call.
        break;
      case "resume":
        this.#resumePending = true;
        this.#processesAt = 0;
        break;
    }
  }

  /** This function gives the power state (H30). On battery, the clients of `headroom run` put their jobs in efficiency mode. */
  powerStatus(): PowerStatus {
    const ac = this.#battery?.ac ?? this.#powerState.ac;
    return { ac, powerMode: this.#powerState.powerMode, lidOpen: this.#powerState.lidOpen, eco: ac === false, keepAwake: this.#awake, lastSleep: this.#lastSleep };
  }

  /**
   * This function gives the time of this call, and marks a sleep that ended since the last call (H30). A resume event, or a
   * time between two calls longer than `sleepGapMs`, marks the sleep. The tick, a request, a heartbeat and a release call it.
   */
  #clock(): number {
    const now = this.#now();
    const last = this.#seenAt;
    const resumed = this.#resumePending;
    this.#seenAt = now;
    this.#resumePending = false;
    if (last !== null && ((resumed && now - last >= MIN_SLEEP_MS) || now - last >= this.#sleepGapMs)) this.#wake(last, now);
    return now;
  }

  /**
   * This function handles the end of a sleep (H30). The leases get the time of the sleep on their heartbeat, so a lease does
   * not end for no heartbeat. The rates do not span the sleep: the processor time, the process starts, the network and the
   * drives start again. The growth of the kernel pools starts again at the wake. The store keeps the sleep for the history.
   */
  #wake(from: number, to: number): void {
    for (const lease of this.#broker.resume(to - from)) this.#store.saveLease(lease);
    this.#counters.gap();
    this.#startTracker.gap(to);
    this.#network = undefined;
    this.#previousNetwork = undefined;
    this.#diskReadings.clear();
    this.#resumedAt = to;
    this.#lastSleep = { from, to };
    // The next tick reads the whole computer again.
    this.#processesAt = 0;
    this.#store.saveSleep(from, to);
  }

  /** This function reads the battery. A failed read gives no battery, and the tick continues. */
  #readBattery(): void {
    this.#batteryDue = false;
    if (!this.#sampler.battery) return;
    try {
      this.#battery = this.#sampler.battery() ?? undefined;
    } catch {
      this.#battery = undefined;
    }
  }

  /** This function reads the counter set "Energy Meter". A failed read gives no meters, and the tick continues. */
  #readMeters(): void {
    if (!this.#sampler.power) return;
    try {
      this.#meters = this.#sampler.power() ?? undefined;
    } catch {
      this.#meters = undefined;
    }
  }

  /** This function holds the power request while a lease is granted on AC power, and ends it otherwise (H30). */
  #keepAwake(): void {
    const jobs = this.#broker.leases().filter((lease) => lease.state === "granted").length;
    const reason = keepAwakeReason(this.#battery?.ac ?? this.#powerState.ac, jobs);
    if (reason !== this.#awake) this.#setAwake(reason);
  }

  #setAwake(reason: string | null): void {
    this.#awake = reason;
    try {
      this.#sampler.keepAwake?.(reason);
    } catch {
      // Without the request, Windows can put the computer to sleep. The leases continue after the wake.
    }
  }

  /** This function closes the store and the sampler. */
  close(): void {
    this.#listeners.clear();
    if (this.#awake !== null) this.#setAwake(null);
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
