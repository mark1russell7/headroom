/**
 * The engine joins the sampler, the owners, the broker and the store. It has no timer: its caller
 * calls `tick()` every few seconds, and after each request and each release.
 */

import { DEFAULT_ALERT_RULES, detect, type Alert, type AlertRules, type DiskInput } from "./alerts.ts";
import { Broker, isActive, type Capacity, type JobExit, type Lease, type LeaseRequest } from "./broker.ts";
import { conditionWait, localClock, nextUnmet, UsageReader, type ConditionFacts, type UsageFacts } from "./conditions.ts";
import { isAbsolute } from "node:path";
import { CounterTracker, type OwnerCores, type OwnerWrites } from "./counters.ts";
import { cpuGroups, LEASE_GROUP, suggestCores, TREE_GROUP, type TrailPoint, type TreeUse } from "./cpu.ts";
import { gpuRead, gpuStatus, leaseGpuMb, type GpuRead, type GpuStatus } from "./gpu.ts";
import {
  ContainerOwners,
  dockerShares,
  dockerStatus,
  splitCores,
  splitOwners,
  type DockerContainerStatus,
  type DockerRead,
  type DockerShare,
  type DockerStatus,
} from "./docker.ts";
import { NO_STARTS, StartTracker, type ProcessStarts } from "./starts.ts";
import { largeFileDirs, largeFiles, type LargeFile } from "./disks.ts";
import { findJobs, type JobQuery, type JobState } from "./job-state.ts";
import { availableParallelism } from "node:os";
import { listeningPorts, tcpSummary, type TcpPorts, type TcpSummary } from "./network.ts";
import { attribute, readSessions, sessionsDir, treeMb } from "./owners.ts";
import { OwnerRecords } from "./orphans.ts";
import { HandleTracker, handleStatus, type HandleStatus } from "./handles.ts";
import { PeerResolver, RoleBook, type Peer, type PeerInput } from "./peer.ts";
import { fitTrend, forecastFrom, FORECAST_WINDOW_MS, type Forecast, type ResourcePoint, type Trend } from "./forecast.ts";
import {
  fitsHistory,
  forecastsOf,
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
import { batteryState, cpuWatts, keepAwakeReason, type PowerEvent, type PowerMode, type PowerStatus } from "./power.ts";
import {
  busyText,
  CALL_EVERY_MS,
  presenceEco,
  presenceReserve,
  presenceStatus,
  PresenceTracker,
  presenceWait,
  type CallRead,
  type PresencePolicy,
  type PresenceRead,
  type PresenceStatus,
} from "./presence.ts";
import {
  AUTO_DRAIN_END_MS,
  AUTO_DRAIN_MARGIN_MB,
  AUTO_DRAIN_START_MS,
  autoDrainEndedText,
  DRAIN_ALERT,
  DRAIN_ENDED_ALERT,
  DRAIN_READY_ALERT,
  drainAlerts,
  drainName,
  drainStatus,
  drainWait,
  poolsPoints,
  rebootBudget,
  windowsReboot,
  type Drain,
  type DrainStatus,
  type PoolBudget,
  type RebootBudget,
  type ResumePlanFile,
  type WindowsReboot,
} from "./reboot.ts";
import { MB, type Sampler } from "./sampler.ts";
import { checkHealth, type ServiceHealth } from "./services.ts";
import { learnSpawn, leaseRate, percentile90, promote, spawnConflict, startsSumConflict, windowRate, type SpawnClass } from "./spawn.ts";
import { AUTO_DRAIN_MAX_MB, AUTO_DRAIN_MIN_MB, AWAY_AFTER_MIN_MS, isAutoDrainLevel, PRESENCE_TIME_MAX_MS, type Config, type MemoryRow, type OwnerRow, type Sleep, type Store } from "./store.ts";
import { checkJobTemp, sweepJobTemp } from "./temp.ts";
import { heatOwners, ThermalTracker, type ThermalRead, type ThermalStatus } from "./thermal.ts";
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
  /**
   * The fleet registry of the roles for `resources.peer` (H46). The default is `~/git/fleet/registry/roles.json`.
   * The folder `roles` next to this file holds the role files.
   */
  readonly rolesFile?: string | undefined;
  /** This function reads the usage file for `usage<N` (H31). The default reads the file. The engine keeps each read for 30 seconds. */
  readonly readUsage?: ((path: string) => UsageFacts) | undefined;
  /** This function runs when a planned drain starts (H34). The daemon writes the resume plan (H13) in it. */
  readonly onDrainStart?: (() => void) | undefined;
  /**
   * This function gives the last read of the Docker engine (H38), or `undefined` when the engine does not answer. The daemon
   * reads the engine every 30 seconds. The default gives no read.
   */
  readonly docker?: (() => DockerRead | undefined) | undefined;
  /** This function gives the file of the resume plan and the time of its last write (H34), or `null` without a file. */
  readonly resumePlan?: (() => ResumePlanFile | null) | undefined;
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
  /**
   * The cores that the broker keeps out of the counted `cpu` pool for Mark at this time (H23). `free.cpu` is after this
   * reserve. While Mark is present, it is the setting plus `presentReserve`. While Mark is away, it is 0 (H33).
   */
  readonly cpuReserve: number;
  /** The presence of Mark at the laptop (H33): the state, its start and reason, the time since the last input and the history. */
  readonly presence: PresenceStatus;
  /**
   * The reboot budget (H34): the kernel pools with their growth and forecast, a waiting Windows update and the uptime. It
   * also has a recommendation, the planned drain and the file of the resume plan.
   */
  readonly reboot: RebootBudget;
  /**
   * The speed and the heat of the CPU (H35): the speed limits, the speed, the thermal zones and the throttle. While the CPU
   * is throttled, it names the 3 owners with the most cores. It is `null` on a computer with no such counters.
   */
  readonly thermal: ThermalStatus | null;
  /**
   * The GPU (H36): each adapter with its memory, its limits, its engine use and its owners, and the GPU memory of
   * each granted lease. It is `null` on a computer with no GPU counters.
   */
  readonly gpu: GpuStatus | null;
  /**
   * The handles (H48): their sum for all the processes, the warning line of one process, and the 3 processes with the most
   * handles. Each of the 3 has its owner. It is `null` on a computer with no count of handles.
   */
  readonly handles: HandleStatus | null;
  /**
   * Docker (H38): each container with its owner, its memory and its cores, the VM and the disk use of Docker. It is `null`
   * when the Docker engine does not answer.
   */
  readonly docker: DockerStatus | null;
}

/** A change of the settings. A field that is absent stays as it is, and `null` removes the setting. */
export interface ConfigChange {
  readonly jobTemp?: string | null | undefined;
  readonly health?: Readonly<Record<string, string>> | null | undefined;
  /** The limit of a spawn-heavy job in starts a minute (H47). `null` gives the default of 600. */
  readonly spawnHeavy?: number | null | undefined;
  /** The battery floor in percent (H31): a whole number from 0 to 100. `null` gives the default of 25. */
  readonly batteryFloor?: number | null | undefined;
  /** The usage file for `usage<N` (H31): an absolute path. `null` gives the default file of the fleet. */
  readonly usageFile?: string | null | undefined;
  /** The cores that the broker keeps for Mark (H23): a number from 0 to the count of processors. `null` gives the default of 2. */
  readonly cpuReserve?: number | null | undefined;
  /** The presence rules (H33): true for on, false for off. `null` gives the default: on. */
  readonly presence?: boolean | null | undefined;
  /** The time with no input after which Mark is away, in ms (H33): 30 seconds to one day. `null` gives the default of 5 minutes. */
  readonly awayAfterMs?: number | null | undefined;
  /** The longest wait of a heavy lease while Mark is busy, in ms (H33): 0 to one day. `null` gives the default of 20 minutes. */
  readonly busyWaitMs?: number | null | undefined;
  /** The cores that the reserve gets while Mark is present (H33): 0 to the count of processors. `null` gives the default of 2. */
  readonly presentReserve?: number | null | undefined;
  /** The level of the automatic drain in MB (H34): 0 for off, or 1 GB to 1 TB. `null` gives the default of 6 GB. */
  readonly autoDrainMb?: number | null | undefined;
}

/** This function gives the presence rules from the settings (H33). */
function policyOf(config: Config): PresencePolicy {
  return { enabled: config.presence, awayAfterMs: config.awayAfterMs, busyWaitMs: config.busyWaitMs, presentReserve: config.presentReserve };
}

/** The efficiency mode of the job of a lease, with the reason for a person (H30, H33). */
export interface EcoState {
  readonly on: boolean;
  /** The reason, for example "the laptop runs on battery" or "Mark works at the laptop", or `null` when the mode is off. */
  readonly reason: string | null;
}

/** An alert that ended. */
export interface EndedAlert extends Alert {
  readonly endedAt: number;
}

/** A memory amount and a CPU amount for a job, from the peaks of its last runs. */
export interface Suggestion {
  /** The amount in MB, or `null` when no run of the job has a peak. */
  readonly memoryMb: number | null;
  /** The number of runs that the amount uses. */
  readonly runs: number;
  /** The highest peak of those runs in MB. */
  readonly peakMb: number | null;
  /** The cores of `--cpu auto` (H23), or `null` when no run of the job has peak cores. */
  readonly cores: number | null;
  /** The number of runs that the cores use. */
  readonly coreRuns: number;
  /** The highest peak cores of those runs. */
  readonly peakCores: number | null;
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
/** The time that the engine keeps a read of the reboot keys of the registry (H34). */
const REGISTRY_EVERY_MS = 5 * 60_000;
/** The alerts of a drain that the engine keeps from the state of the drain, not from `detect()` (H34). */
const DRAIN_IDS: ReadonlySet<string> = new Set([DRAIN_ALERT, DRAIN_READY_ALERT]);
/** After a resume event, a time between two calls of the engine shorter than this is not a sleep. A tick that came first marked it. */
const MIN_SLEEP_MS = 5000;
const round = (mb: number): number => Math.round(mb * 10) / 10;
/** The window of the GPU trails (H36): the rule needs 2 minutes above its limit, and one minute below it to end. */
const GPU_TRAIL_MS = 5 * 60_000;
/** A lease keeps a new peak of GPU memory only when it grows by this amount, so the store gets few writes. */
const GPU_PEAK_STEP_MB = 16;

/** The active alerts and the alerts that ended last. */
export interface Alerts {
  readonly active: readonly Alert[];
  readonly ended: readonly EndedAlert[];
}

export type { ResourcePoint } from "./forecast.ts";

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
  /** The CPU group of each process at the last read (H23): a leased job or a process tree. */
  #groups: ReadonlyMap<number, string> = new Map();
  /** The cores of each granted lease over the last minute, by lease id (H23). */
  #leaseCores: ReadonlyMap<string, number> = new Map();
  /** The cores that the broker keeps for Mark (H23), from the settings. */
  #cpuReserve: number;
  /** The state of Mark at the laptop (H33), with the last events and a short history. */
  readonly #presence = new PresenceTracker();
  /** The presence rules from the settings (H33). */
  #policy: PresencePolicy;
  /** The last read of the camera and the microphone, and its time (H33). */
  #call: CallRead | null = null;
  #callAt = Number.NEGATIVE_INFINITY;
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
  /** The resolver of `resources.peer`, with its caches (H46). */
  readonly #peers: PeerResolver;
  #processesAt = 0;
  #recordedAt = 0;
  #prunedAt = 0;
  readonly #startedAt: number;
  /** The last read of the battery and of the Energy Meter (H30). */
  #battery: BatteryRead | undefined;
  #meters: PowerMeters | undefined;
  /** The trail of the speed and the heat of the CPU (H35), from the reads of the last 11 minutes. */
  readonly #thermal = new ThermalTracker();
  /** The last GPU read (H36), and the used part of each adapter at each read of the last minutes, for the GPU alert. */
  #gpu: GpuRead | undefined;
  #gpuTrails = new Map<ResourceId, TrailPoint[]>();
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
  /** The reader of the usage file for `usage<N` (H31), with its cache of 30 seconds. */
  readonly #usage: UsageReader;
  /** The facts of the conditions at one time, so one tick reads the settings one time (H31). It also keeps the limit of H47. */
  #facts: { readonly at: number; readonly facts: ConditionFacts; readonly floor: number; readonly spawnHeavy: number } | null = null;
  /**
   * The points of the last hour of each instance with a fit forecast (H32), one for each sample of the store, the oldest
   * first. A start of the daemon reads them from the store. A wake empties them, because a fit does not span a sleep.
   */
  readonly #trendPoints = new Map<ResourceId, ResourcePoint[]>();
  /** The fit of each instance and part at the last sample, by `<id>|<part>`. A part with no trend is absent. */
  #trends = new Map<string, Trend>();
  /** The planned drain for a reboot (H34), from the settings. */
  #drain: Drain | null = null;
  readonly #onDrainStart: () => void;
  readonly #resumePlan: () => ResumePlanFile | null;
  /** The growth of each kernel pool over the last hour, in MB, from the last check of the alerts (H34). */
  #poolGrowth: { readonly nonpaged: number | null; readonly paged: number | null } = { nonpaged: null, paged: null };
  /** The last read of the reboot keys of the registry, and its time (H34). */
  #windowsReboot: { readonly at: number; readonly value: WindowsReboot | null } | null = null;
  /** The level of the automatic drain in MB from the settings, or 0 for off (H34). */
  #autoDrainMb: number;
  /** The first tick at or above the level, and the first tick of an automatic drain under its end level. */
  #autoHighSince: number | null = null;
  #autoLowSince: number | null = null;
  /** The time of the last `headroom drain --cancel`, or `null`. While it holds, the automatic rule starts no drain. */
  #autoHold: number | null;
  /** The fit of the two kernel pools together at the last sample, for the forecast to the automatic level. */
  #poolsTrend: Trend | null = null;
  /** The owner record of each live process (H48). An orphan keeps the owner of its record after its parent ends. */
  readonly #records = new OwnerRecords();
  /** The handles of each process with many handles over the last 7 minutes (H48). */
  readonly #handles = new HandleTracker();
  /** The fleet registry of the roles: `resources.peer` (H46) and the owners of the containers (H38) read it. */
  readonly #roles: RoleBook;
  /** The source of the reads of the Docker engine (H38), the owners of the containers, and the last read with its owners. */
  readonly #dockerSource: () => DockerRead | undefined;
  readonly #containerOwners = new ContainerOwners();
  #dockerFacts: { readonly read: DockerRead; readonly containers: readonly DockerContainerStatus[]; readonly shares: readonly DockerShare[] } | null = null;
  /** The Docker resource of the status, from the last read of the processes (H38). */
  #docker: DockerStatus | null = null;

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
    this.#roles = new RoleBook(options.rolesFile);
    this.#peers = this.#peerResolver(this.#roles);
    this.#dockerSource = options.docker ?? (() => undefined);
    this.#usage = new UsageReader(options.readUsage);
    this.#broker = new Broker({
      now: this.#now,
      reserveMb: this.#reserveMb,
      // The admit part of the kind of each id tells the part of a granted lease that its job uses.
      used: (lease, id) => {
        const readings = this.#readings;
        return readings === null ? 0 : (resourceOf(id).admit?.used?.(lease, id, readings, this.#ownership) ?? 0);
      },
      // H47: a spawn-heavy lease and a lease with the slot browser do not run at the same time.
      conflict: spawnConflict,
      // H47: beside a browser test, the sum of the start rates of the other leases stays at or below the limit.
      groupConflict: (lease, granted, before) => startsSumConflict(lease, granted, before, (each) => this.#startRate(each), this.#conditionFacts().spawnHeavy),
      // H31: a lease waits until each of its conditions holds, and a heavy lease waits on a low battery.
      // H34: in a planned drain, a lease waits for the reboot, unless its job runs with --during-drain.
      condition: (lease) => {
        const drained = drainWait(lease, this.#drain, this.#now(), localClock, this.#drain?.auto ? this.#poolsMb() : null);
        if (drained !== null) return drained;
        const { facts, floor } = this.#conditionFacts();
        // H33: while Mark is busy, a new heavy lease waits, for at most the busy wait.
        return conditionWait(lease, facts, floor) ?? presenceWait(lease, this.#presence.current, this.#policy, facts.now);
      },
    });
    this.#broker.restore(this.#store.activeLeases());
    this.#bootedAt = this.#sampler.bootedAt?.() ?? 0;
    this.#onDrainStart = options.onDrainStart ?? (() => undefined);
    this.#resumePlan = options.resumePlan ?? (() => null);
    // H34: the drain continues after a restart of the daemon. A start of the computer after the drain means that the reboot came.
    this.#drain = this.#store.drain();
    if (this.#drain !== null && this.#bootedAt > this.#drain.setAt) {
      this.#endDrain(this.#startedAt, `The reboot came, so ${drainName(this.#drain)} ended. New jobs start again.`);
    }
    // A reboot also ends the hold of the automatic drain after a cancel.
    this.#autoHold = this.#store.autoDrainHold();
    if (this.#autoHold !== null && this.#bootedAt > this.#autoHold) this.#setAutoHold(null);
    // The snapshots of the last hour continue after a restart, so the change of each tag has its full window. A start of
    // the computer empties the pools, so the snapshots before it do not continue.
    this.#tags = this.#store.poolTagsSince(Math.max(this.#startedAt - POOL_TAGS_KEEP_MS, this.#bootedAt));
    this.#tagsAt = this.#tags.at(-1)?.at ?? 0;
    // The writes of the last hour continue after a restart, so a disk alert names the owners that filled the drive.
    this.#counters.restore("writeBytes", this.#store.writesSince(this.#startedAt - 3_600_000).map((row) => ({ ...row, amount: row.amount * MB })));
    this.#writes = this.#counters.writes(this.#startedAt);
    // H48: the owner records continue after a restart, so an orphan keeps the owner that it had before the restart.
    this.#records.restore(this.#store.processOwners());
    const config = this.#store.config();
    this.#cpuReserve = config.cpuReserve;
    this.#autoDrainMb = config.autoDrainMb;
    this.#policy = policyOf(config);
    this.#memory = this.#sampler.memory();
    this.#seedTrends();
  }

  /**
   * This function reads the points of the last hour of each instance with a fit forecast from the store (H32). The points
   * start after the start of the computer and after the last sleep, so a fit does not span either.
   */
  #seedTrends(): void {
    const from = this.#startedAt - FORECAST_WINDOW_MS;
    const since = Math.max(from, this.#bootedAt, this.#store.sleepsSince(from).at(-1)?.[1] ?? 0);
    for (const row of this.#store.resourcesSince(since)) {
      if (!fitsHistory(row.id)) continue;
      const list = this.#trendPoints.get(row.id) ?? [];
      list.push([row.at, point(row.used), point(row.free)]);
      this.#trendPoints.set(row.id, list);
    }
    this.#fitTrends();
  }

  /** This function adds the measurements of a sample to the points of the forecasts, removes the old points, and fits again (H32). */
  #recordTrends(now: number): void {
    for (const each of this.#measurements) {
      if (!fitsHistory(each.id)) continue;
      const list = this.#trendPoints.get(each.id) ?? [];
      list.push([now, point(each.used), point(each.free)]);
      this.#trendPoints.set(each.id, list);
    }
    for (const [id, list] of this.#trendPoints) {
      const old = list.findIndex((each) => now - each[0] <= FORECAST_WINDOW_MS);
      if (old < 0) this.#trendPoints.delete(id);
      else if (old > 0) list.splice(0, old);
    }
    this.#fitTrends();
  }

  /** This function fits the used part and the free part of each instance with points. The fit starts after the last wake. */
  #fitTrends(): void {
    const since = Math.max(this.#bootedAt, this.#resumedAt);
    const trends = new Map<string, Trend>();
    for (const [id, list] of this.#trendPoints) {
      for (const part of ["used", "free"] as const) {
        const trend = fitTrend(list, part, { since });
        if (trend !== null) trends.set(`${id}|${part}`, trend);
      }
    }
    this.#trends = trends;
    // H34: the fit of the two kernel pools together gives the forecast to the level of the automatic drain.
    const nonpaged = this.#trendPoints.get("pool:nonpaged") ?? [];
    const paged = this.#trendPoints.get("pool:paged") ?? [];
    this.#poolsTrend = fitTrend(poolsPoints(nonpaged, paged), "used", { since });
  }

  /** This function gives the forecasts of each instance at a time, the nearest first, from the fits of the last sample (H32). */
  #forecasts(now: number): Map<ResourceId, Forecast[]> {
    const forecasts = new Map<ResourceId, Forecast[]>();
    for (const each of this.#measurements) {
      const list = forecastsOf(each, (part) => this.#trends.get(`${each.id}|${part}`) ?? null, this.#alertRules, now);
      if (list.length > 0) forecasts.set(each.id, list);
    }
    return forecasts;
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
    // The reserve of a drive is the critical limit of the disk alert. The reserve of `cpu` is the cores for Mark (H23).
    const result = rooms(ids, measurements, readings.pools, { [MEMORY]: this.#reserveMb, cpu: this.#reserveNow() }, this.#alertRules);
    // H33: the reserve is 0 while Mark is away, so a lease above the reserve of this time waits and is not cancelled.
    const cpu = result["cpu"];
    if (cpu !== undefined && this.#policy.enabled && this.#presence.current !== null) result["cpu"] = { ...cpu, lowestReserve: 0 };
    return { totalMb: this.#memory.totalMb, availableMb: this.#memory.availableMb, pools: readings.pools, rooms: result };
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
      thermal: this.#thermal.state(this.#now()) ?? undefined,
      gpu: this.#gpu,
      leases,
      docker: this.#docker,
    };
    return this.#readings;
  }

  /**
   * This function gives the last read of the Docker engine with the owner of each container (H38), or `null` with no read.
   * The owners come from the fleet roles, one time for each new read.
   */
  #readDocker(): { readonly read: DockerRead; readonly containers: readonly DockerContainerStatus[]; readonly shares: readonly DockerShare[] } | null {
    let read: DockerRead | undefined;
    try {
      read = this.#dockerSource();
    } catch {
      read = undefined;
    }
    if (read === undefined) {
      this.#dockerFacts = null;
      return null;
    }
    if (this.#dockerFacts?.read !== read) {
      const containers = this.#containerOwners.attribute(read.containers, this.#roles.roles());
      this.#dockerFacts = { read, containers, shares: dockerShares(containers) };
    }
    return this.#dockerFacts;
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
      // H48: an orphan gets the owner of its record, with the label `(orphan)`.
      const { owners, ownerOf } = attribute(this.#processes, this.#sessions, this.#memory, undefined, this.#servers(), this.#records.byKey());
      this.#store.saveProcessOwners(this.#records.observe(now, this.#processes, ownerOf, (pid) => this.#sampler.commandLine?.(pid) ?? null));
      this.#handles.read(now, this.#processes);
      // H38: the containers of Docker get their part of the owner `docker`. The rest is `docker (VM)`. The processes of
      // Docker keep the owner `docker`, so the kinds keep it too.
      const docker = this.#readDocker();
      this.#owners = docker === null ? owners : splitOwners(owners, docker.shares);
      this.#ownership = {
        ownerOf,
        kindOf: new Map([...owners, ...this.#owners].map((owner) => [owner.owner, owner.kind])),
        leaseOf: leasesOf(this.#processes, this.#broker.leases()),
      };
      // H23: the tracker keeps the processor time of each leased job and of each process tree.
      this.#groups = cpuGroups(this.#processes, this.#ownership);
      this.#counters.read(now, this.#processes, ownerOf, this.#ownership.kindOf, this.#groups);
      this.#writes = this.#counters.writes(now);
      const cores = this.#counters.cores(now);
      this.#cores = docker === null ? cores : splitCores(cores, docker.shares);
      this.#docker =
        docker === null ? null : dockerStatus({ ...docker, processes: this.#processes, owners: this.#owners, cores: this.#cores });
      this.#leaseCores = new Map([...this.#counters.groupCores(now, LEASE_GROUP)].map(([group, cores]) => [group.slice(LEASE_GROUP.length), cores]));
      this.#recordPeakCores();
      this.#startTracker.read(now, this.#processes, this.#ownership, this.#sampler.processSequence?.(), this.#broker.leases());
      this.#starts = this.#startTracker.summary(now);
      // H31: the admission of this tick tests `starts<N` on the new sample, so a waiting lease starts at once when it holds.
      this.#facts = null;
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
      this.#readThermal(now);
      // H36: the GPU read uses the PDH collection of the Energy Meter.
      this.#readGpu(now);
      this.#check(now, ownerOf);
    } else if (this.#batteryDue) {
      // A power event: the battery is cheap to read, so the tick reads it before the next read of the processes.
      this.#readBattery();
      if (this.#checkDue) this.#check(now, this.#ownership.ownerOf);
    }
    // H33: the presence of this tick comes before the admission, so a lease that waits for Mark starts at once.
    this.#readPresence(now);
    // H34: the automatic drain, the end of a drain at its time --until, and its start, come before the admission of this tick.
    this.#autoDrain(now);
    this.#drainBefore(now);
    const changed = this.#broker.tick(this.capacity());
    this.#persist(changed);
    this.#drainAfter(now);
    this.#recordUnmet();
    this.#keepAwake();
    if (now - this.#recordedAt >= this.#recordEveryMs) {
      this.#recordedAt = now;
      this.#store.saveSample(now, this.#memory, this.#owners, this.#load, this.#measurements, this.#writtenMb(now));
      this.#recordTrends(now);
    }
    if (now - this.#prunedAt >= 3_600_000) {
      this.#prunedAt = now;
      this.#store.prune(now - this.#retentionMs, now - Math.max(this.#retentionMs, LEASE_KEEP_MS));
      this.#broker.forget(now - 3_600_000);
    }
    return changed;
  }

  /** This function adds a request and grants it at once when it fits. The past runs of its job give its spawn class (H47). */
  request(request: LeaseRequest): Lease {
    this.#readPresence(this.#clock());
    const lease = this.#broker.request(request, this.spawnClass(request.job, request.holder, request.spawnHeavy));
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
    const released = this.#broker.release(id, reason, peakMb ?? null, usage, exit, processes);
    const lease = released === undefined ? undefined : this.#releasePeakCores(this.#measureStarts(released, processes));
    if (lease) this.#persist([lease]);
    this.#persist(this.#broker.tick(this.capacity()));
    return lease ? (this.#broker.get(id) ?? lease) : undefined;
  }

  /**
   * This function gives a memory amount for a job from the peaks of its last runs. The amount is the 90th percentile
   * and 25% more, rounded up to 64 MB. It prefers the runs of the same holder. Without a run, it gives `null`.
   * The cores of `--cpu auto` use the same rule on the peak cores, up to a whole core and the cores that leases can get (H23).
   */
  suggest(job: string, holder?: string): Suggestion {
    const own = holder === undefined ? [] : this.#store.peaksOf(job, holder);
    const peaks = own.length > 0 ? own : this.#store.peaksOf(job);
    const ownCores = holder === undefined ? [] : this.#store.corePeaksOf(job, holder);
    const corePeaks = ownCores.length > 0 ? ownCores : this.#store.corePeaksOf(job);
    const cores = suggestCores(corePeaks, this.#leasableCores());
    const cpu = { cores, coreRuns: cores === null ? 0 : corePeaks.length, peakCores: cores === null ? null : Math.max(...corePeaks) };
    const p90 = percentile90(peaks);
    if (p90 === null) return { memoryMb: null, runs: 0, peakMb: null, ...cpu };
    return { memoryMb: Math.max(256, Math.ceil((p90 * 1.25) / 64) * 64), runs: peaks.length, peakMb: Math.round(Math.max(...peaks)), ...cpu };
  }

  /**
   * This function gives the cores that the leases can get together (H23): the processors or the pool `cpu`, less the reserve
   * for Mark. It uses the reserve of the settings, not the reserve of this time (H33).
   */
  #leasableCores(): number {
    const pool = this.#store.pools()["cpu"];
    return Math.max(0, Math.min(this.#processors, pool ?? this.#processors) - this.#cpuReserve);
  }

  /**
   * This function gives the spawn class of a job from the peak starts of its last runs (H47). It uses the rule of
   * `suggest`: the 90th percentile of the last 20 runs, the runs of the same holder first. `override` is the option of the run.
   */
  spawnClass(job: string, holder?: string, override?: boolean): SpawnClass {
    const own = holder === undefined ? [] : this.#store.startPeaksOf(job, holder);
    const peaks = own.length > 0 ? own : this.#store.startPeaksOf(job);
    return learnSpawn(peaks, this.#store.config().spawnHeavy, override);
  }

  /** This function finds the jobs of a query in the store, the newest first (H26). Without `all`, it gives at most one job. */
  jobs(query: JobQuery): JobState[] {
    return findJobs(this.#store, query, this.#now());
  }

  /** This function records a heartbeat of a lease. `processes` is the count of processes that its job started so far (H29). */
  renew(id: string, processes?: number): Lease | undefined {
    this.#clock();
    const renewed = this.#broker.renew(id, processes);
    if (renewed === undefined) return undefined;
    const lease = this.#measureStarts(renewed, processes);
    this.#store.saveLease(lease);
    return lease;
  }

  /**
   * This function gives a count of the job object of a lease to the start tracker (H29). Then it measures the starts of
   * the job over the last 30 seconds, and keeps the peak on the lease (H47). A job above the limit becomes spawn-heavy.
   */
  #measureStarts(lease: Lease, processes: number | undefined): Lease {
    if (processes === undefined || lease.processes === undefined) return lease;
    const now = this.#now();
    this.#startTracker.report(lease, now, lease.processes, this.#ownership);
    this.#starts = this.#startTracker.summary(now);
    const rate = windowRate(this.#startTracker.points(lease.id));
    if (rate === null) return lease;
    const peak = Math.max(lease.peakStartsPerMin ?? 0, Math.round(rate));
    const spawn = promote(lease.spawn, peak, this.#store.config().spawnHeavy);
    if (peak === lease.peakStartsPerMin && spawn === lease.spawn) return lease;
    return this.#broker.update(lease.id, { peakStartsPerMin: peak, ...(spawn === undefined ? {} : { spawn }) }) ?? lease;
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
   * a URL of `health` that is not http or https. It also refuses a limit of `spawnHeavy` that is not a whole number above 0.
   * With an error, it changes no setting.
   */
  setConfig(change: ConfigChange): Config {
    const jobTemp = change.jobTemp === undefined || change.jobTemp === null ? change.jobTemp : checkJobTemp(change.jobTemp);
    const health = change.health === undefined || change.health === null ? change.health : JSON.stringify(checkHealth(change.health));
    const limit = change.spawnHeavy;
    if (typeof limit === "number" && !(Number.isInteger(limit) && limit > 0)) throw new RangeError("The limit of spawn-heavy must be a whole number above 0");
    const floor = change.batteryFloor;
    if (typeof floor === "number" && !(Number.isInteger(floor) && floor >= 0 && floor <= 100)) throw new RangeError("The battery floor must be a whole number from 0 to 100");
    const usageFile = change.usageFile;
    if (typeof usageFile === "string" && !isAbsolute(usageFile)) throw new RangeError(`The usage file must be an absolute path: ${usageFile}`);
    const reserve = change.cpuReserve;
    if (typeof reserve === "number" && !(Number.isFinite(reserve) && reserve >= 0 && reserve <= this.#processors)) {
      throw new RangeError(`The CPU reserve must be a number from 0 to ${this.#processors}, the count of processors`);
    }
    const presence = this.#checkPresence(change);
    const autoDrain = change.autoDrainMb;
    if (typeof autoDrain === "number" && !isAutoDrainLevel(autoDrain)) {
      throw new RangeError(`The level of the automatic drain must be 0 (off) or a whole number of MB from ${AUTO_DRAIN_MIN_MB} to ${AUTO_DRAIN_MAX_MB}`);
    }
    if (jobTemp !== undefined) this.#store.setConfig("jobTemp", jobTemp);
    if (health !== undefined) this.#store.setConfig("health", health);
    if (limit !== undefined) this.#store.setConfig("spawnHeavy", limit === null ? null : String(limit));
    if (floor !== undefined) this.#store.setConfig("batteryFloor", floor === null ? null : String(floor));
    if (usageFile !== undefined) this.#store.setConfig("usageFile", usageFile);
    if (reserve !== undefined) {
      this.#store.setConfig("cpuReserve", reserve === null ? null : String(reserve));
      this.#cpuReserve = this.#store.config().cpuReserve;
    }
    if (autoDrain !== undefined) {
      this.#store.setConfig("autoDrainMb", autoDrain === null ? null : String(autoDrain));
      this.#autoDrainMb = this.#store.config().autoDrainMb;
      // A new level is a new decision of Mark, so the hold of a cancel ends.
      this.#setAutoHold(null);
      this.#autoHighSince = null;
    }
    if (presence) {
      if (change.presence !== undefined) this.#store.setConfig("presence", change.presence === null ? null : change.presence ? "on" : "off");
      if (change.awayAfterMs !== undefined) this.#store.setConfig("awayAfterMs", change.awayAfterMs === null ? null : String(change.awayAfterMs));
      if (change.busyWaitMs !== undefined) this.#store.setConfig("busyWaitMs", change.busyWaitMs === null ? null : String(change.busyWaitMs));
      if (change.presentReserve !== undefined) this.#store.setConfig("presentReserve", change.presentReserve === null ? null : String(change.presentReserve));
      this.#policy = policyOf(this.#store.config());
      // A new time for away can change the state at once.
      this.#readPresence(this.#now(), true);
    }
    // H31: a new floor or a new usage file can let a waiting lease start. H23: a smaller CPU reserve can too. H47: a higher
    // limit can too. H33: a change of the presence rules can too.
    if (floor !== undefined || usageFile !== undefined || reserve !== undefined || limit !== undefined || presence) {
      this.#facts = null;
      this.#persist(this.#broker.tick(this.capacity()));
    }
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
    const attribution = this.#readings === null ? undefined : { readings: this.#readings, owners: this.#ownership };
    const now = this.#now();
    const forecasts = this.#forecasts(now);
    return {
      at: now,
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
      resources: withKinds(this.#measurements, attribution, forecasts),
      writes: this.#writes,
      tcp: this.#tcp === undefined ? null : tcpSummary(this.#tcp),
      starts: this.#starts,
      power: this.powerStatus(),
      cpuReserve: this.#reserveNow(),
      presence: presenceStatus(this.#presence, this.#policy),
      reboot: this.#rebootBudget(now, forecasts),
      thermal: this.thermalStatus(),
      gpu: gpuStatus(this.#gpu, this.#ownership, new Map(this.#processes.map((info) => [info.pid, info.name]))),
      handles: handleStatus(this.#processes, this.#ownership.ownerOf, (info) => this.#records.get(info), this.#alertRules.handlesWarn),
      docker: this.#docker,
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
  /**
   * This function gives the peer of a local TCP connection: its process, the nearest `claude.exe`, the session and the
   * role (H46). `PeerResolver.resolve()` gives the steps, the errors and the limit.
   */
  peer(input: PeerInput): Peer {
    return this.#peers.resolve(input);
  }

  /** This function makes the peer resolver on the sampler, the process snapshot and the sessions of the engine. */
  #peerResolver(roles: RoleBook): PeerResolver {
    const sampler = this.#sampler;
    const tcpEndpoints = sampler.tcpEndpoints?.bind(sampler);
    const processStart = sampler.processStart?.bind(sampler);
    return new PeerResolver({
      tcpEndpoints,
      processes: () => this.#processes,
      freshProcesses: () => sampler.processTree?.() ?? sampler.processes(),
      processStart,
      sessions: () => this.#sessions,
      freshSessions: () => readSessions(this.#sessionsDir),
      roles: () => roles.roles(),
    });
  }

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
    // The kinds of the owners of the processes: the split of Docker (H38) does not change the owner `docker` of a process.
    const kindOf = this.#ownership.kindOf;
    // The growth of the pool is measured over one hour. A history shorter than 50 minutes gives no growth. A start of the
    // computer empties the pools, so the history starts at the start of the computer or later. A sleep stops the growth,
    // so the history also starts at the last wake (H30).
    const first = this.#store.memorySince(Math.max(now - 3_600_000, this.#bootedAt, this.#resumedAt))[0];
    const hourOld = first !== undefined && now - first.at > 50 * 60_000;
    const poolHourAgoMb = hourOld ? first.kernelNonpagedMb : undefined;
    const pagedHourAgoMb = hourOld ? first.kernelPagedMb : undefined;
    // H34: the reboot budget gives the growth of each pool over the same hour.
    this.#poolGrowth = {
      nonpaged: poolHourAgoMb === undefined ? null : Math.round(this.#memory.kernelNonpagedMb - poolHourAgoMb),
      paged: pagedHourAgoMb === undefined ? null : Math.round(this.#memory.kernelPagedMb - pagedHourAgoMb),
    };
    const disks: DiskInput[] = this.#disks.map((disk) => {
      const { droppedMb, windowMinutes } = this.#diskWindow(disk.mount);
      return { ...disk, droppedMb, windowMinutes };
    });
    const found = detect(
      {
        memory: this.#memory, processes: this.#processes, ownerOf, kindOf, leases: this.#broker.leases(), poolHourAgoMb, pagedHourAgoMb,
        load: this.#load, disks, writes: this.#writes, tcp: this.#tcp, services: this.#services(), starts: this.#starts,
        battery: this.#battery, meters: this.#meters, cores: this.#cores, thermal: this.#thermal.state(now) ?? undefined, gpu: this.#gpu,
        // H23: the CPU rules read the trails of the counter tracker, and an active alert ends only after its clear time.
        // H36: the GPU rule reads the trail of the used part of each adapter.
        at: now, processors: this.#processors, active: [...this.#alerts.values()], leaseCores: this.#leaseCores,
        trails: new Map([...(this.#cores === undefined ? [] : [["cpu", this.#counters.coresTrail(now)] as const]), ...this.#gpuTrails]),
        trees: this.#trees(now),
        // H32: the forecast rules read the forecasts from the fits of the last sample.
        forecasts: this.#forecasts(now),
        // H48: only a process above the lower line of the handles rule in the window needs its trail.
        handles: this.#handles.trails(this.#processes, Math.min(this.#alertRules.handlesWarn, this.#alertRules.handlesGain)),
        recordOf: (info) => this.#records.get(info),
        // H38: the Docker alerts read the last disk read of the engine.
        docker: this.#docker,
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
      if ((alert.id === "pool" || alert.id === "forecast:pool:nonpaged") && named) found[index] = { ...alert, message: `${alert.message}${named}` };
      if ((alert.id === "pool:paged" || alert.id === "forecast:pool:paged") && pagedNamed) found[index] = { ...alert, message: `${alert.message}${pagedNamed}` };
    }
    for (const [id, event] of this.#events) {
      if (event.until <= now) this.#events.delete(id);
      else found.push(event.alert);
    }
    const ids = new Set(found.map((alert) => alert.id));
    for (const [id, alert] of this.#alerts) {
      // H34: the state of the drain keeps its alerts, so the check of the alerts does not end them.
      if (ids.has(id) || DRAIN_IDS.has(id)) continue;
      this.#alerts.delete(id);
      this.#ended = [{ ...alert, endedAt: now }, ...this.#ended].slice(0, 50);
    }
    for (const alert of found) this.#alerts.set(alert.id, { ...alert, since: this.#alerts.get(alert.id)?.since ?? now });
  }

  /**
   * This function gives the process trees with no lease and their trails (H23). Only a tree that went above the runaway
   * amount in the trail, and that still runs, needs its trail.
   */
  #trees(now: number): TreeUse[] {
    const counts = new Map<string, number>();
    for (const group of this.#groups.values()) if (group.startsWith(TREE_GROUP)) counts.set(group, (counts.get(group) ?? 0) + 1);
    const trees: TreeUse[] = [];
    for (const group of this.#counters.groupsSeen(now, TREE_GROUP)) {
      const processes = counts.get(group);
      if (processes === undefined) continue;
      const trail = this.#counters.coresTrail(now, group);
      if (!trail.some((point) => point.value > this.#alertRules.runawayCores)) continue;
      trees.push({ pid: Number(group.slice(TREE_GROUP.length)), processes, trail });
    }
    return trees;
  }

  /**
   * This function keeps the highest cores of each granted lease over one minute (H23). It writes a lease only when its
   * peak grows by 0.1 core or more, so the store gets few writes.
   */
  #recordPeakCores(): void {
    for (const [id, cores] of this.#leaseCores) {
      const lease = this.#broker.get(id);
      if (lease === undefined || lease.state !== "granted" || cores < (lease.peakCores ?? 0) + 0.1) continue;
      const next = this.#broker.update(id, { peakCores: Math.round(cores * 100) / 100 });
      if (next !== undefined) this.#store.saveLease(next);
    }
  }

  /**
   * This function keeps the average cores of a job over its run as its peak, when they are higher (H23). The client of
   * `headroom run` gives the processor time of the job object at the release. A short job has no read of one minute.
   */
  #releasePeakCores(lease: Lease): Lease {
    const cpuMs = lease.usage?.cpuMs;
    const ranMs = lease.grantedAt === null || lease.endedAt === null ? 0 : lease.endedAt - lease.grantedAt;
    if (cpuMs === undefined || ranMs < 1000) return lease;
    const cores = Math.round((cpuMs / ranMs) * 100) / 100;
    if (cores <= (lease.peakCores ?? 0)) return lease;
    return this.#broker.update(lease.id, { peakCores: cores }) ?? lease;
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
   * battery, or makes a full read of the computer after a wake. That tick also admits the leases whose conditions hold (H31).
   */
  powerEvent(event: PowerEvent): void {
    // H31: the conditions of the next tick use the new state.
    this.#facts = null;
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
      case "presence":
      case "display":
        // H33: the tick that the daemon asks for classifies the state again and runs the admission.
        this.#presence.event(event, this.#now());
        break;
    }
  }

  /**
   * This function gives the efficiency mode of the job of a lease (H30, H33). On battery, each job runs in efficiency
   * mode. While Mark is present or busy, each heavy job does, unless it has `--ignore-presence`.
   */
  ecoOf(lease: Lease): EcoState {
    if (this.powerStatus().eco) return { on: true, reason: "the laptop runs on battery" };
    const current = this.#presence.current;
    if (current === null || !presenceEco(lease, current, this.#policy)) return { on: false, reason: null };
    return { on: true, reason: current.state === "busy" ? `Mark ${busyText(current.busy)}` : "Mark works at the laptop" };
  }

  /** This function gives the CPU reserve for Mark at this time (H23, H33): larger while Mark is present, 0 while Mark is away. */
  #reserveNow(): number {
    return presenceReserve(this.#cpuReserve, this.#presence.current, this.#policy, this.#processors);
  }

  /**
   * This function reads the presence of Mark and classifies it (H33). It reads the time since the last input and the
   * notification state at each call. It reads the camera and the microphone at most one time in 30 seconds, or at once with
   * `fresh`. A new state makes new facts for the conditions.
   */
  #readPresence(now: number, fresh = false): void {
    const sampler = this.#sampler;
    if (sampler.presence === undefined) return;
    if (sampler.calls !== undefined && (fresh || now - this.#callAt >= CALL_EVERY_MS || now < this.#callAt)) {
      this.#callAt = now;
      try {
        this.#call = sampler.calls();
      } catch {
        this.#call = null;
      }
    }
    let read: PresenceRead;
    try {
      read = sampler.presence();
    } catch {
      read = { idleMs: null, notification: null };
    }
    if (this.#presence.update(now, read, this.#call, this.#policy.awayAfterMs)) this.#facts = null;
  }

  /**
   * This function checks the presence settings of a change (H33). It throws a `RangeError` for a wrong value. It gives true
   * when the change has a presence setting.
   */
  #checkPresence(change: ConfigChange): boolean {
    const { awayAfterMs, busyWaitMs, presentReserve } = change;
    if (typeof awayAfterMs === "number" && !(Number.isInteger(awayAfterMs) && awayAfterMs >= AWAY_AFTER_MIN_MS && awayAfterMs <= PRESENCE_TIME_MAX_MS)) {
      throw new RangeError("The time for away must be a whole number of ms from 30 seconds to one day");
    }
    if (typeof busyWaitMs === "number" && !(Number.isInteger(busyWaitMs) && busyWaitMs >= 0 && busyWaitMs <= PRESENCE_TIME_MAX_MS)) {
      throw new RangeError("The busy wait must be a whole number of ms from 0 to one day");
    }
    if (typeof presentReserve === "number" && !(Number.isFinite(presentReserve) && presentReserve >= 0 && presentReserve <= this.#processors)) {
      throw new RangeError(`The present reserve must be a number from 0 to ${this.#processors}, the count of processors`);
    }
    return change.presence !== undefined || awayAfterMs !== undefined || busyWaitMs !== undefined || presentReserve !== undefined;
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
    // H35: a limit of the CPU does not span the sleep.
    this.#thermal.gap();
    // H36: the time above the GPU limit does not span the sleep.
    this.#gpuTrails = new Map();
    this.#network = undefined;
    this.#previousNetwork = undefined;
    this.#diskReadings.clear();
    // H32: a fit does not span the sleep, so the forecasts start again with the points after the wake.
    this.#trendPoints.clear();
    this.#trends = new Map();
    this.#poolsTrend = null;
    // H34: the times of the automatic drain do not span the sleep.
    this.#autoHighSince = null;
    this.#autoLowSince = null;
    this.#resumedAt = to;
    this.#lastSleep = { from, to };
    // The next tick reads the whole computer again.
    this.#processesAt = 0;
    this.#store.saveSleep(from, to);
  }

  /**
   * This function gives the facts of the conditions at this time, and the battery floor (H31). It reads the settings one
   * time for each time. Only a condition that reads the usage reads the usage file, and the reader keeps it for 30 seconds.
   */
  #conditionFacts(): { readonly facts: ConditionFacts; readonly floor: number; readonly spawnHeavy: number } {
    const now = this.#now();
    if (this.#facts !== null && this.#facts.at === now) return this.#facts;
    const config = this.#store.config();
    const reader = this.#usage;
    const tracker = this.#startTracker;
    let usage: UsageFacts | undefined;
    let starts: number | null | undefined;
    const facts: ConditionFacts = {
      now,
      ac: this.powerStatus().ac,
      percent: this.#battery === undefined ? null : batteryState(this.#battery).percent,
      presence: this.#sampler.presence === undefined ? null : (this.#presence.current?.state ?? null),
      thermal: this.#thermal.state(now),
      get usage(): UsageFacts {
        usage ??= reader.read(config.usageFile, now);
        return usage;
      },
      get starts(): number | null {
        if (starts === undefined) starts = tracker.recent(now);
        return starts;
      },
    };
    this.#facts = { at: now, facts, floor: config.batteryFloor, spawnHeavy: config.spawnHeavy };
    return this.#facts;
  }

  /**
   * This function gives the rate of a lease for the sum of the start rates (H47). A granted lease with two counts gives its
   * own rate over the last 30 seconds. Each other lease gives its learned rate.
   */
  #startRate(lease: Lease): number {
    return leaseRate(lease, lease.state === "granted" ? windowRate(this.#startTracker.points(lease.id)) : null);
  }

  /**
   * This function checks the conditions of each granted lease (H31). A lease continues when a condition stops. The lease
   * records the condition and the time, and the record closes when the condition holds again.
   */
  #recordUnmet(): void {
    const changed: Lease[] = [];
    for (const lease of this.#broker.leases()) {
      if (lease.state !== "granted" || lease.conditions === undefined) continue;
      const unmet = nextUnmet(lease, this.#conditionFacts().facts);
      if (unmet === lease.unmet || unmet === undefined) continue;
      const next = this.#broker.update(lease.id, { unmet });
      if (next !== undefined) changed.push(next);
    }
    this.#persist(changed);
  }

  /** This function reads the battery. A failed read gives no battery, and the tick continues. */
  #readBattery(): void {
    this.#batteryDue = false;
    this.#facts = null;
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

  /**
   * This function reads the speed and the heat of the CPU into the trail (H35). It uses the collection of the Energy Meter.
   * A failed read adds no point, and the tick continues. The admission of this tick tests `cool` on the new read.
   */
  #readThermal(now: number): void {
    if (!this.#sampler.thermal) return;
    let read: ThermalRead | null = null;
    try {
      read = this.#sampler.thermal();
    } catch {
      // A missing counter gives no read. The state ends one minute after the last read.
    }
    this.#thermal.add(now, read);
    this.#facts = null;
  }

  /** This function gives the speed and the heat of the CPU (H35). While the CPU is throttled, it adds the owners with the most cores. */
  thermalStatus(): ThermalStatus | null {
    const state = this.#thermal.state(this.#now());
    if (state === null) return null;
    const owners = state.throttled ? heatOwners(this.#cores, cpuWatts(this.#meters), this.#broker.leases(), this.#ownership.ownerOf) : [];
    return { ...state, owners };
  }

  /**
   * This function reads the GPU (H36), and keeps the used part of each adapter in its trail for the GPU alert. A failed
   * read gives no GPU, and the tick continues. A computer with no GPU counters has no GPU.
   */
  #readGpu(now: number): void {
    if (!this.#sampler.gpu) return;
    try {
      this.#gpu = gpuRead(this.#sampler.gpu(), this.#memory.totalMb) ?? undefined;
    } catch {
      this.#gpu = undefined;
    }
    const trails = new Map<ResourceId, TrailPoint[]>();
    for (const adapter of this.#gpu?.adapters ?? []) {
      const kept = (this.#gpuTrails.get(adapter.id) ?? []).filter((point) => now - point.at < GPU_TRAIL_MS);
      trails.set(adapter.id, [...kept, { at: now, value: adapter.usedMb }]);
    }
    this.#gpuTrails = trails;
    this.#recordPeakGpu();
  }

  /** This function keeps the highest GPU memory of each granted lease (H36). It writes a lease only when its peak grows by 16 MB or more. */
  #recordPeakGpu(): void {
    for (const [id, mb] of leaseGpuMb(this.#gpu, this.#ownership.leaseOf)) {
      const lease = this.#broker.get(id);
      if (lease === undefined || lease.state !== "granted" || mb < (lease.peakGpuMb ?? 0) + GPU_PEAK_STEP_MB) continue;
      const next = this.#broker.update(id, { peakGpuMb: Math.round(mb) });
      if (next !== undefined) this.#store.saveLease(next);
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

  /** This function gives the planned drain with its running jobs (H34), or `null` without a drain. */
  drain(): DrainStatus | null {
    return drainStatus(this.#drain, this.#broker.leases(), this.#now());
  }

  /**
   * This function plans a drain for a reboot (H34). From `at`, new leases wait, and the running leases finish. `until` ends
   * the drain when no reboot came. A second drain replaces the first. It throws a `RangeError` for an end before the start.
   */
  setDrain(at: number, until: number | null = null): DrainStatus {
    const now = this.#clock();
    if (!Number.isFinite(at)) throw new RangeError("The time of the drain must be a time in milliseconds since the epoch");
    if (until !== null && !(Number.isFinite(until) && until > at && until > now)) throw new RangeError("The end of the drain must come after its start and after the current time");
    this.#saveDrain({ at, until, setAt: now, startedAt: null, readyAt: null });
    this.#drainBefore(now);
    this.#facts = null;
    this.#persist(this.#broker.tick(this.capacity()));
    this.#drainAfter(now);
    const drain = this.drain();
    if (drain === null) throw new RangeError("The drain ended at once");
    return drain;
  }

  /**
   * This function cancels the drain (H34). The waiting leases start when they fit. It gives the drain, or `null` without one.
   * After a cancel, the automatic rule starts no drain until the pools fall under its end level, or until a reboot.
   */
  cancelDrain(): DrainStatus | null {
    const now = this.#clock();
    const current = this.drain();
    if (current === null) return null;
    this.#endDrain(now, null);
    // The automatic rule does not start a new drain at once: it waits for the pools to fall, or for a reboot.
    this.#setAutoHold(now);
    this.#persist(this.#broker.tick(this.capacity()));
    return current;
  }

  /** This function writes the drain to the store, or removes it with `null`. */
  #saveDrain(drain: Drain | null): void {
    this.#drain = drain;
    this.#store.setDrain(drain);
  }

  /**
   * This function ends the drain (H34). Its alerts end. With a message, an event alert `drain:ended` tells why: the reboot
   * came, or the time of `--until` came with no reboot. A cancel has no message.
   */
  #endDrain(now: number, message: string | null): void {
    this.#saveDrain(null);
    this.#syncDrainAlerts(now, null);
    if (message !== null) this.note({ id: DRAIN_ENDED_ALERT, kind: "drain", subject: "planned reboot", pid: null, mb: 0, message });
  }

  /**
   * This function handles the drain before the admission of a tick (H34). At the time of `--until`, the drain ends. At its
   * start, the drain records the time and calls `onDrainStart`, so the daemon writes the resume plan one time.
   */
  #drainBefore(now: number): void {
    const drain = this.#drain;
    if (drain === null) return;
    if (drain.until !== null && now >= drain.until) {
      const message = `The drain for the reboot at ${localClock(drain.at)} ended at ${localClock(drain.until)} with no reboot. New jobs start again.`;
      this.#endDrain(now, message);
      return;
    }
    if (now < drain.at || (drain.startedAt ?? null) !== null) return;
    this.#saveDrain({ ...drain, startedAt: now });
    try {
      this.#onDrainStart();
    } catch {
      // The resume plan is a help for the reboot. The drain continues without it.
    }
  }

  /** This function gives the non-paged pool and the paged pool together, in MB, from the last read of the memory. */
  #poolsMb(): number {
    return this.#memory.kernelNonpagedMb + this.#memory.kernelPagedMb;
  }

  /** This function sets or removes the hold of the automatic drain, in the engine and in the store. */
  #setAutoHold(at: number | null): void {
    this.#autoHold = at;
    this.#store.setAutoDrainHold(at);
  }

  /**
   * This function applies the rule of the automatic drain at a tick (H34). It uses the drain of `headroom drain`, with no end
   * time, so the start, the alerts and the resume plan stay the same.
   *
   * - The pools at or above the level for 2 minutes, with no drain and no hold, start an automatic drain.
   * - An automatic drain ends when the pools stay under the level less 300 MB for 10 minutes.
   * - The rule does not change a drain of `headroom drain`.
   */
  #autoDrain(now: number): void {
    const poolsMb = this.#poolsMb();
    const drain = this.#drain;
    const auto = drain?.auto ?? null;
    if (drain !== null) {
      this.#autoHighSince = null;
      if (auto === null || poolsMb >= auto.levelMb - AUTO_DRAIN_MARGIN_MB) {
        this.#autoLowSince = null;
        return;
      }
      this.#autoLowSince ??= now;
      if (now - this.#autoLowSince < AUTO_DRAIN_END_MS) return;
      this.#autoLowSince = null;
      this.#endDrain(now, autoDrainEndedText(auto));
      return;
    }
    this.#autoLowSince = null;
    const level = this.#autoDrainMb;
    // The hold of a cancel ends when the pools fall under the end level.
    if (this.#autoHold !== null && level > 0 && poolsMb < level - AUTO_DRAIN_MARGIN_MB) this.#setAutoHold(null);
    if (level <= 0 || this.#autoHold !== null || poolsMb < level) {
      this.#autoHighSince = null;
      return;
    }
    this.#autoHighSince ??= now;
    if (now - this.#autoHighSince < AUTO_DRAIN_START_MS) return;
    this.#autoHighSince = null;
    this.#saveDrain({ at: now, until: null, setAt: now, startedAt: null, readyAt: null, auto: { levelMb: level, poolsMb: Math.round(poolsMb) } });
  }

  /** This function records the time when no job runs in an active drain, and updates the alerts of the drain (H34). */
  #drainAfter(now: number): void {
    const drain = this.#drain;
    const before = drainStatus(drain, this.#broker.leases(), now);
    if (drain !== null && before !== null && before.state === "active") {
      const readyAt = before.running.length === 0 ? (drain.readyAt ?? now) : null;
      if (readyAt !== (drain.readyAt ?? null)) this.#saveDrain({ ...drain, readyAt });
    }
    this.#syncDrainAlerts(now, this.drain());
  }

  /**
   * This function sets the alerts of the drain from its state (H34). An alert that the state does not give any more ends. The
   * alert `drain` starts at the start of the drain, and the alert `drain:ready` at the time when no job runs.
   */
  #syncDrainAlerts(now: number, drain: DrainStatus | null): void {
    const found = drainAlerts(drain);
    const ids = new Set(found.map((alert) => alert.id));
    for (const id of DRAIN_IDS) {
      const alert = this.#alerts.get(id);
      if (alert === undefined || ids.has(id)) continue;
      this.#alerts.delete(id);
      this.#ended = [{ ...alert, endedAt: now }, ...this.#ended].slice(0, 50);
    }
    for (const alert of found) {
      const start = alert.id === DRAIN_READY_ALERT ? drain?.readyAt : (drain?.startedAt ?? drain?.at);
      this.#alerts.set(alert.id, { ...alert, since: this.#alerts.get(alert.id)?.since ?? start ?? now });
    }
  }

  /** This function reads the reboot keys of the registry, at most one time in 5 minutes (H34). */
  #windowsRebootRead(now: number): WindowsReboot | null {
    const sampler = this.#sampler;
    if (sampler.registryKey === undefined) return null;
    if (this.#windowsReboot !== null && now - this.#windowsReboot.at < REGISTRY_EVERY_MS) return this.#windowsReboot.value;
    const value = windowsReboot((path) => sampler.registryKey?.(path) ?? "unknown");
    this.#windowsReboot = { at: now, value };
    return value;
  }

  /** This function gives the reboot budget at a time (H34), from the memory, the forecasts of the last sample and the drain. */
  #rebootBudget(now: number, forecasts: ReadonlyMap<ResourceId, readonly Forecast[]>): RebootBudget {
    const rules = this.#alertRules;
    const pool = (id: PoolBudget["id"], usedMb: number, alertMb: number, growth: number | null, growthLimitMb: number): PoolBudget => {
      const list = forecasts.get(id) ?? [];
      const forecast = list.find((each) => each.target.on === "used" && each.target.amount === alertMb) ?? list[0] ?? null;
      return { id, usedMb: Math.round(usedMb), alertMb, growthMbPerHour: growth, growthLimitMb, forecast };
    };
    let plan: ResumePlanFile | null = null;
    try {
      plan = this.#resumePlan();
    } catch {
      plan = null;
    }
    const level = this.#autoDrainMb;
    const poolsMb = Math.round(this.#poolsMb());
    const trend = this.#poolsTrend;
    const autoForecast = level > 0 && trend !== null ? forecastFrom(trend, { on: "used", amount: level, name: "critical" }, now, poolsMb) : null;
    return rebootBudget({
      at: now,
      autoDrain: { levelMb: level, poolsMb, forecast: autoForecast },
      pools: [
        pool("pool:nonpaged", this.#memory.kernelNonpagedMb, rules.poolMb, this.#poolGrowth.nonpaged, rules.poolGrowthMb),
        pool("pool:paged", this.#memory.kernelPagedMb, rules.pagedMb, this.#poolGrowth.paged, rules.pagedGrowthMb),
      ],
      windows: this.#windowsRebootRead(now),
      bootedAt: this.#bootedAt > 0 ? this.#bootedAt : null,
      drain: this.drain(),
      resumePlan: plan,
    });
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
