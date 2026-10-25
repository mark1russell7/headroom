/**
 * The resource model of headroom (H22, `docs/RESOURCES.md`).
 *
 * Each resource kind has five parts: measure, attribute, alert, admit and enforce. A part is a pure function of
 * the reads of one tick. It has no clock and no input or output of its own, so the tests use fixed reads.
 */

import type { Alert, AlertKind, AlertRules } from "./alerts.ts";
import type { Lease } from "./broker.ts";
import type { JobLimits } from "./jobs.ts";
import { childrenOf, treeMb } from "./owners.ts";
import { MB } from "./sampler.ts";
import type { Amounts, BatteryRead, DiskSpace, NetRead, OwnerKind, PowerMeters, ProcessInfo, SessionLoad, SystemMemory, TcpTable } from "./types.ts";
import { diskSize, gb } from "./units.ts";
import type { OwnerCores, OwnerWrites } from "./counters.ts";
import { coresText, cpuRateOf, CPU_RESERVE_DEFAULT, heldMs, type TrailPoint, type TreeUse } from "./cpu.ts";
import { forecastFrom, rateText, spanText, type Forecast, type ForecastTarget, type Part, type TargetName, type Trend } from "./forecast.ts";
import { dynamicUse, netFlows, tcpByOwner } from "./network.ts";
import { batteryParts, batteryState, cpuWatts, minutesText, ownersWattsText, powerOwners, systemWatts, type BatteryState } from "./power.ts";
import type { ServiceHealth, ServiceState } from "./services.ts";
import { countText, STARTS_WINDOW_MS, topStartsText, type ProcessStarts } from "./starts.ts";

/** One instance of a resource: `memory`, `cpu`, `disk:D:` or `browser`. A lease amount names it. */
export type ResourceId = string;

/** The kinds of resource. An id with no known kind is a slot, as before. */
export type ResourceKind =
  | "memory"
  | "commit"
  | "pool"
  | "desktop"
  | "disk"
  | "cpu"
  | "slot"
  | "net"
  | "ports"
  | "service"
  | "procs"
  | "battery"
  | "power"
  | "gpu";

/**
 * The unit of the amounts of a kind. The disk writes use MB/h, and the network uses MB/s. A kind in the unit `state` has
 * no amount (H27). Its measurement has a `health`, and its used part is the latency of the last check in ms. The process
 * starts use `per minute` (H29). The battery uses Wh, and the power uses W (H30).
 */
export type Unit = "MB" | "cores" | "count" | "MB/h" | "MB/s" | "state" | "per minute" | "Wh" | "W";

/** The processor times of the computer since its start (H23), in milliseconds, for all the processors together. */
export interface CpuTimes {
  readonly busyMs: number;
  readonly idleMs: number;
}

/** The reads of one tick. The engine makes them, and each kind uses its part. */
export interface Readings {
  readonly at: number;
  readonly memory: SystemMemory;
  /** The processes of this read. */
  readonly processes: readonly ProcessInfo[];
  /** The processes of the read before this read. The rates come from the two reads. */
  readonly previous: readonly ProcessInfo[];
  /**
   * The owners that wrote most in the last hour, from the counter tracker of the engine (H20). The attribute part of the
   * disk gives them, and the disk alert names them.
   */
  readonly writes?: readonly OwnerWrites[] | undefined;
  /** The cores of each owner, as an average over the last minute, from the counter tracker of the engine. The cpu kind uses them. */
  readonly cores?: readonly OwnerCores[] | undefined;
  readonly disks: readonly DiskSpace[];
  readonly load: SessionLoad;
  /** The processor times since the start of the computer (H23). */
  readonly cpu?: CpuTimes | undefined;
  /** The count of logical processors. */
  readonly processors: number;
  /** The capacity of each configured pool, from the store. */
  readonly pools: Amounts;
  /** The sum of the amounts of the granted leases, for each id. */
  readonly granted: Amounts;
  /** The byte counters of the network adapters at this read (H24). */
  readonly network?: NetRead | undefined;
  /** The byte counters of the network adapters at the read before this read. The throughput comes from the two reads. */
  readonly previousNetwork?: NetRead | undefined;
  /** The TCP connections and the dynamic port range (H24). */
  readonly tcp?: TcpTable | undefined;
  /** The health of each service after the last round of checks (H27). */
  readonly services?: readonly ServiceHealth[] | undefined;
  /** The process starts of the computer, of each owner and of each leased job, from the start tracker of the engine (H29). */
  readonly starts?: ProcessStarts | undefined;
  /** The battery (H30). A computer with no battery has none. */
  readonly battery?: BatteryRead | undefined;
  /** The counter set "Energy Meter" (H30). A computer with no such counters has none. */
  readonly meters?: PowerMeters | undefined;
  /** The granted leases. The battery alert names the jobs that run on battery (H30). */
  readonly leases?: readonly Lease[] | undefined;
  /**
   * The trail of each instance: the used part at each read of the last minutes, the oldest first (H23). A level rule with
   * a duration reads it. Only `cpu` has a trail at this time.
   */
  readonly trails?: ReadonlyMap<ResourceId, readonly TrailPoint[]> | undefined;
  /** The process trees with no lease that used many cores in the last 11 minutes (H23). The runaway rule of the CPU reads them. */
  readonly trees?: readonly TreeUse[] | undefined;
  /** The cores of each granted lease over the last minute, by lease id (H23). The CPU alert names the leased jobs. */
  readonly leaseCores?: ReadonlyMap<string, number> | undefined;
  /** The forecasts of each instance, the nearest first (H32). The forecast rules read them. */
  readonly forecasts?: ReadonlyMap<ResourceId, readonly Forecast[]> | undefined;
}

/** The level of one instance at one tick, in the unit of its kind. */
export interface Measurement {
  readonly id: ResourceId;
  /** The capacity, or `null` when the kind has no limit to measure, for example a kernel pool. */
  readonly capacity: number | null;
  /** The used part, or `null` before headroom measures it, for example the processors before H23. */
  readonly used: number | null;
  /** The free part, or `null` without a capacity. For the memory, it is the available memory. */
  readonly free: number | null;
  /** The health of a service (H27). Only a kind in the unit `state` has it. */
  readonly health?: ServiceHealth | undefined;
  /** The power source, the charge, the rate and the time left of the battery (H30). Only the kind `battery` has it. */
  readonly battery?: BatteryState | undefined;
}

/** The use of one owner of an instance, in the unit of the attribute part of its kind. */
export interface ResourceOwner {
  readonly owner: string;
  readonly kind: OwnerKind;
  readonly value: number;
  readonly unit: Unit;
}

/** The level of one instance, with its kind, its unit and its owners. `Status.resources` gives one for each instance. */
export interface ResourceStatus extends Measurement {
  readonly kind: ResourceKind;
  readonly unit: Unit;
  /**
   * The 10 owners that use the instance most, from the attribute part of its kind. A kind with no attribute part has none.
   * Memory: the private MB. Disk: the MB written in the last hour, for all the drives together. CPU: the cores. Ports: the connections.
   * Process starts: the starts in one minute (H29).
   */
  readonly owners: readonly ResourceOwner[];
  /** The forecast to the nearest target (H32). An instance with no trend toward a target has none. */
  readonly forecast?: Forecast | undefined;
}

/** The measure part of a kind. */
export interface Measure {
  /** This function gives the instances of the kind at one tick. */
  read(readings: Readings): readonly Measurement[];
}

/** The owner of each process at one tick. */
export interface Owners {
  /** The owner of each process: `session:graph`, `mcp:vex`, `docker` or `system`. */
  readonly ownerOf: ReadonlyMap<number, string>;
  /** The kind of each owner. */
  readonly kindOf: ReadonlyMap<string, OwnerKind>;
  /** The lease of each process under a granted lease: the lease process and its descendants. */
  readonly leaseOf: ReadonlyMap<number, string>;
}

/** The use of one resource by one owner. */
export interface OwnerUse {
  /** The kind: `memory`, `disk` or `cpu`. The disk counters do not name the drive. */
  readonly resource: ResourceKind;
  /** The owner, or `lease:<id>`. A lease row is a part of the row of its session, not an addition to it. */
  readonly owner: string;
  readonly kind: OwnerKind | "lease";
  readonly amount: number;
  readonly processes: number;
}

/** The attribute part of a kind. */
export interface Attribute {
  /** The unit of the use. For the disk, it is MB/h written, not MB. */
  readonly unit: Unit;
  /** This function gives the counter of one process, or `undefined` when the read has no counter. */
  counter(info: ProcessInfo): number | undefined;
  /** This function gives the use of each owner and each lease, the largest first. */
  read(readings: Readings, owners: Owners): readonly OwnerUse[];
}

/** The level of an alert rule. */
export type Level = "warning" | "critical";

/** A limit: an amount, a part of the capacity, or both. With both, the lower one counts. */
export interface Limit {
  readonly amount?: number | undefined;
  readonly ratio?: number | undefined;
}

/** The change of one instance over a window, from the history of the engine. */
export interface Change {
  readonly windowMs: number;
  /** The gain of the used part over the window. A negative gain is a decrease. */
  readonly usedGain?: number | undefined;
  /** The loss of the free part over the window. */
  readonly freeLoss?: number | undefined;
}

/** The text of one alert: its subject, its message and its size in MB. */
export interface AlertText {
  readonly subject: string;
  readonly message: string;
  readonly mb: number;
}

/** The facts of an alert on an instance. */
export interface InstanceFacts {
  readonly measurement: Measurement;
  /** The change of the instance over the window of the rule, when the history has it. */
  readonly change: Change | undefined;
  readonly readings: Readings;
  /** The owner of each process. The text of the ports alert names the owners with the most connections. */
  readonly owners: Owners;
  /** The level of the alert. The text of the CPU alert names the limit of its level (H23). */
  readonly level?: Level | undefined;
  /** The level of the active alert of the rule before this check, or `null`. A forecast rule keeps its alert with it (H32). */
  readonly active?: Level | null | undefined;
}

/** The facts of an alert on one process, or on one process tree (H23). */
export interface ProcessFacts {
  /** The process, or the root of the tree. */
  readonly process: ProcessInfo;
  readonly owner: string;
  /** The counter of the process, in the unit of the kind. A tree gives its cores over the last minute. */
  readonly amount: number;
  /** The live processes of the tree. A rule on one process has none. */
  readonly processes?: number | undefined;
}

/** The fields of each rule. */
export interface RuleBase {
  /** The kind of the alert, as before: `memory`, `pool`, `disk` or `runaway`. */
  readonly alert: AlertKind;
  /** The id of the alert. The default is the id of the instance. The rules of `pool:nonpaged` keep the id `pool`. */
  readonly alertId?: ((instance: ResourceId) => string) | undefined;
  /** With this flag, the alert gives the level of the rule in `severity`. Without it, the kind of the alert gives the level. */
  readonly severity?: boolean | undefined;
}

/** A rule on the level of an instance. `free`: below the limit. `used`: above the limit. */
export interface LevelRule extends RuleBase {
  readonly type: "level";
  readonly on: "free" | "used";
  /** The rule examines only this instance. Without it, the rule examines each instance of the kind. */
  readonly instance?: ResourceId | undefined;
  readonly warning?: Limit | undefined;
  readonly critical?: Limit | undefined;
  /**
   * The condition must continue for this time (H23). CPU uses it, because short peaks are normal. The rule reads the trail
   * of the instance. Without a trail, the rule gives no alert.
   */
  readonly forMs?: number | undefined;
  /**
   * An active alert of a rule with `forMs` ends only after this time below the limit of its level (H23). Thus a short dip
   * does not end the alert.
   */
  readonly clearMs?: number | undefined;
  /**
   * With less history than this, the rule gives no alert (H29). The history is the window of the change of the instance.
   * The churn rule uses it, because its rate is an average over 10 minutes.
   */
  readonly minHistoryMs?: number | undefined;
  text(facts: InstanceFacts): AlertText;
}

/** A rule on the change of an instance over a window. */
export interface GrowthRule extends RuleBase {
  readonly type: "growth";
  /** `used`: a gain of the used part. `free`: a loss of the free part. */
  readonly on: "free" | "used";
  /** The rule examines only this instance. Without it, the rule examines each instance of the kind. */
  readonly instance?: ResourceId | undefined;
  readonly windowMs: number;
  /** A change above this amount starts a warning. */
  readonly warning: number;
  /** With less history than this, the rule gives no alert. The pool rules use 50 minutes. */
  readonly minHistoryMs: number;
  text(facts: InstanceFacts): AlertText;
}

/** A rule on one process, or on one process tree with no lease (H23). */
export interface OutlierRule extends RuleBase {
  readonly type: "outlier";
  /** `process`: the counter of each process. `tree`: the cores of each tree of `Readings.trees`, with `forMs`. */
  readonly subject: "process" | "owner" | "tree";
  /** A counter above this amount starts the alert. */
  readonly above: number;
  /** A tree must stay above the amount for this time (H23). */
  readonly forMs?: number | undefined;
  /** An active alert on a tree ends only after this time below the amount (H23). */
  readonly clearMs?: number | undefined;
  /** The owner kinds that the rule does not examine. `runaway` skips docker, system and kernel. */
  readonly skip: readonly OwnerKind[];
  /** With this list, the rule examines only these owner kinds. `orphan` examines only `other`. */
  readonly only?: readonly OwnerKind[] | undefined;
  /** `unleased`: no lease holds the process. `orphaned`: its parent stopped. */
  readonly when: "always" | "unleased" | "orphaned";
  text(facts: ProcessFacts): AlertText;
}

/** A rule on the health of a service (H27): the same state for a count of checks in a row. */
export interface HealthRule extends RuleBase {
  readonly type: "health";
  /** The rule examines only this instance. Without it, the rule examines each instance of the kind. */
  readonly instance?: ResourceId | undefined;
  /** The state that starts the alert. */
  readonly state: ServiceState;
  /** The count of checks in a row with the state. Fewer checks give no alert. */
  readonly checks: number;
  /** This function gives the level of the alert for the health of a service. */
  level(health: ServiceHealth): Level;
  text(facts: InstanceFacts): AlertText;
}

/**
 * A rule with its own test of the facts of an instance (H30). The battery uses it, because its alerts need the power
 * source and the leases, not only a limit. The `--when` conditions of H31 have their own registry in `conditions.ts`.
 */
export interface CheckRule extends RuleBase {
  readonly type: "check";
  /** The rule examines only this instance. Without it, the rule examines each instance of the kind. */
  readonly instance?: ResourceId | undefined;
  /** This function gives the level of the alert, or `null` when the facts give no alert. */
  level(facts: InstanceFacts): Level | null;
  text(facts: InstanceFacts): AlertText;
}

/** One alert rule of a kind. */
export type Rule = LevelRule | GrowthRule | OutlierRule | HealthRule | CheckRule;

/** The alert part of a kind. */
export interface AlertPart {
  /** This function gives the rules of the kind. The fields of `AlertRules` give their limits. */
  rules(limits: AlertRules): readonly Rule[];
  /** This function adds the names that help the reader: the pool tags that grow, the new large files and the top writers. */
  explain?(alert: Alert, readings: Readings, owners: Owners): string;
}

/** The admit part of a kind: how the broker compares a lease amount with an instance. */
export interface Admit {
  /** `measured`: the operating system gives the free part. `counted`: the capacity less the granted amounts. */
  readonly mode: "measured" | "counted";
  /** The amount that the broker keeps free. Memory: 1024 MB. Disk: the critical limit. */
  readonly reserve: Limit;
  /**
   * With this level, the reserve is the limit of this level in the level rule of the kind on the free part. Thus the
   * reserve follows the configured alert limits. Disk: `critical`.
   */
  readonly reserveFrom?: Level | undefined;
  /** The capacity of an instance with no measurement and no configuration. A slot has 1, a lock. */
  readonly defaultCapacity?: number | undefined;
  /** This function gives the part of a granted lease that its job uses at this time. Without it, the lease keeps its full amount. */
  used?(lease: Lease, id: ResourceId, readings: Readings, owners: Owners): number;
  /** At this level of an instance, no job starts, also a job with no amount of it (step 5). */
  readonly gate?: Level | undefined;
}

/** The room of one instance, from its measurement and its admit part. The engine gives it to the broker. */
export interface Room {
  readonly mode: "measured" | "counted";
  readonly capacity: number;
  /** The measured free part. It is `null` for a counted instance. */
  readonly free: number | null;
  readonly reserve: number;
  /**
   * The lowest reserve of the instance at another time (H33): the CPU reserve while Mark is away. The broker cancels a lease
   * only above the capacity less this reserve. Without it, the reserve is the lowest reserve.
   */
  readonly lowestReserve?: number | undefined;
}

/** The environment of a job, from its lease. The release removes the folders. */
export interface JobSetup {
  readonly env: Readonly<Record<string, string>>;
  readonly folders: readonly string[];
}

/** The use of a job at its release, from its job object. Only `peakMb` has a value at this time. */
export interface JobUsage {
  /** The peak memory of the job, in MB: `PeakJobMemoryUsed`. */
  readonly peakMb?: number | undefined;
  /** The MB that the job wrote: `WriteTransferCount` (H19). */
  readonly writtenMb?: number | undefined;
  /** The processor time of the job: `TotalUserTime` and `TotalKernelTime` (H23). */
  readonly cpuMs?: number | undefined;
  /** The size of the temp folder of the lease, before the release removes it (H19). */
  readonly tempMb?: number | undefined;
}

/** The enforce part of a kind: what the job object of `headroom run` can limit. */
export interface Enforce {
  /**
   * This function gives the limit for an amount, with `--limit`. `null`: the kind has no limit, so headroom only reports.
   * The CPU rate needs the count of logical processors (H23).
   */
  limit(amount: number, processors: number): Partial<JobLimits> | null;
  /** This function gives the setup of a job for its lease. */
  setup?(lease: Lease): JobSetup;
  /** The fields of `JobUsage` that the kind reports at the release. */
  readonly report: readonly (keyof JobUsage)[];
}

/**
 * The forecast part of a kind (H32). The targets of an instance are the limits of the level rules of its kind, and the
 * targets of `more`. A kind with no forecast part has no forecast: the processors, the network, the starts and the slots.
 */
export interface ForecastPart {
  /** This function gives more targets of an instance, for example an empty drive. */
  more?(measurement: Measurement): readonly ForecastTarget[];
  /** This function gives the forecast of an instance with no fit, for example the time left of the battery. */
  given?(measurement: Measurement, now: number): Forecast | null;
}

/** One resource kind with its five parts. A part that a kind does not have is `null`. */
export interface Resource {
  readonly kind: ResourceKind;
  readonly unit: Unit;
  readonly measure: Measure;
  readonly attribute: Attribute | null;
  readonly alert: AlertPart;
  readonly admit: Admit | null;
  readonly enforce: Enforce | null;
  /** The forecast part (H32), or absent when the kind has no forecast. */
  readonly forecast?: ForecastPart | undefined;
}

/** The alert part of a kind with no rules. */
const NO_ALERTS: AlertPart = { rules: () => [] };

/** The window of the growth rules of the kernel pools. */
const HOUR_MS = 3_600_000;

/** The text of an alert on a kernel pool: its size, and its growth over the last hour when it grew. */
function poolText(subject: string, name: string, cause: string): (facts: InstanceFacts) => AlertText {
  return ({ measurement, change }) => {
    const used = measurement.used ?? 0;
    const growth = change?.usedGain ?? 0;
    const grew = growth > 0 ? `, ${Math.round(growth)} MB more than one hour ago` : "";
    return { subject, mb: Math.round(used), message: `The ${name} kernel pool is ${gb(used)}${grew}. ${cause}` };
  };
}

/** This function gives the use of each owner and each lease from the amount of each process, the largest first. */
function byOwner(resource: ResourceKind, processes: readonly ProcessInfo[], owners: Owners, amountOf: (info: ProcessInfo) => number | undefined): OwnerUse[] {
  const sums = new Map<string, { kind: OwnerKind | "lease"; amount: number; processes: number }>();
  const add = (owner: string, kind: OwnerKind | "lease", amount: number): void => {
    const sum = sums.get(owner) ?? { kind, amount: 0, processes: 0 };
    sum.amount += amount;
    sum.processes += 1;
    sums.set(owner, sum);
  };
  for (const info of processes) {
    const amount = amountOf(info);
    if (amount === undefined) continue;
    const owner = owners.ownerOf.get(info.pid) ?? "other";
    add(owner, owners.kindOf.get(owner) ?? "other", amount);
    const lease = owners.leaseOf.get(info.pid);
    if (lease !== undefined) add(`lease:${lease}`, "lease", amount);
  }
  return [...sums]
    .map(([owner, sum]) => ({ resource, owner, kind: sum.kind, amount: sum.amount, processes: sum.processes }))
    .sort((a, b) => b.amount - a.amount);
}

/** This function gives the attribute part of a kind from the counter of one process. */
function perProcess(resource: ResourceKind, unit: Unit, counter: (info: ProcessInfo) => number | undefined): Attribute {
  return { unit, counter, read: (readings, owners) => byOwner(resource, readings.processes, owners, counter) };
}

/**
 * The attribute part of the disk (H20). The counter of a process is the MB that it wrote since its start. The use of an
 * owner is the MB that it wrote in the last hour, from the counter tracker of the engine. The counters do not name the drive.
 */
const DISK_WRITES: Attribute = {
  unit: "MB/h",
  counter: (info) => (info.writeBytes === undefined ? undefined : info.writeBytes / MB),
  read: (readings) =>
    (readings.writes ?? []).map((each) => ({ resource: "disk", owner: each.owner, kind: each.kind, amount: each.mbLastHour, processes: 0 })),
};

/**
 * The attribute part of the processors. The counter of a process is its processor time in milliseconds. The use of an
 * owner is its cores, as an average over the last minute, from the counter tracker of the engine.
 */
const CPU_USE: Attribute = {
  unit: "cores",
  counter: (info) => info.cpuMs,
  read: (readings) => (readings.cores ?? []).map((each) => ({ resource: "cpu", owner: each.owner, kind: each.kind, amount: each.cores, processes: 0 })),
};

/** The owners that wrote most in the last hour for the disk alert: the first 3 above 100 MB. */
const WRITERS_SHOWN = 3;
const WRITERS_ABOVE_MB = 100;

/** This function gives the text of the owners that wrote most in the last hour, or "" when no owner wrote 100 MB. */
export function writersText(writes: readonly OwnerWrites[] | undefined): string {
  const top = [...(writes ?? [])]
    .filter((each) => each.mbLastHour >= WRITERS_ABOVE_MB)
    .sort((a, b) => b.mbLastHour - a.mbLastHour)
    .slice(0, WRITERS_SHOWN);
  return top.length === 0 ? "" : ` Most writes in the last hour: ${top.map((each) => `${each.owner} ${diskSize(each.mbLastHour)}`).join(", ")}.`;
}

/** An active forecast alert ends only past this part of its horizon. Thus a small change of the rate does not end it and start it again. */
const FORECAST_CLEAR = 1.25;

/** This function gives the clock time of a forecast in UTC, as the other alerts give it: "06:40". */
const utcClock = (at: number): string => new Date(at).toISOString().slice(11, 16);

/** This function gives the forecast of the instance of the facts to a target, from a fit. */
function forecastTo(facts: InstanceFacts, name: TargetName): Forecast | undefined {
  return facts.readings.forecasts?.get(facts.measurement.id)?.find((each) => each.source === "fit" && each.target.name === name);
}

/**
 * This function gives a forecast rule (H32): a warning when the fit of an instance reaches a target within the horizon.
 * The alert id is `forecast:<instance>`. The text names the rate, the time, and the owners that the model has.
 */
function forecastRule(name: TargetName, horizonMs: number, text: (facts: InstanceFacts, forecast: Forecast) => AlertText): CheckRule {
  return {
    type: "check",
    alert: "forecast",
    alertId: (id) => `forecast:${id}`,
    severity: true,
    level: (facts) => {
      const forecast = forecastTo(facts, name);
      const limit = facts.active === undefined || facts.active === null ? horizonMs : horizonMs * FORECAST_CLEAR;
      return forecast !== undefined && forecast.minutes * 60_000 <= limit ? "warning" : null;
    },
    text: (facts) => {
      const forecast = forecastTo(facts, name);
      return forecast === undefined ? { subject: facts.measurement.id, mb: 0, message: `${facts.measurement.id} has no forecast.` } : text(facts, forecast);
    },
  };
}

/** This function gives "in 3 h 10 min, at 06:40 UTC" for a forecast. */
const whenText = (forecast: Forecast): string => `in ${spanText(forecast.minutes)}, at ${utcClock(forecast.at)} UTC`;

/** The text of the forecast alert of a drive: the loss in one hour, the time of the critical level, and the top writers. */
function diskForecastText({ measurement, readings }: InstanceFacts, forecast: Forecast): AlertText {
  const mount = measurement.id.slice("disk:".length);
  return {
    subject: `drive ${mount}`,
    mb: Math.round(measurement.free ?? 0),
    message: `Drive ${mount} loses ${rateText(forecast.rate, "MB")}. At this rate, it has ${diskSize(forecast.target.amount)} free ${whenText(forecast)}.${writersText(readings.writes)}`,
  };
}

/** The count of owners that the text of a forecast alert names. */
const FORECAST_OWNERS_SHOWN = 3;

/**
 * The text of the forecast alert of a kernel pool. Each new process leaks non-paged pool in the AMD display driver. Thus the
 * text of the non-paged pool names the owners with the most process starts. The engine adds the pool tags that grow.
 */
function poolForecastText(name: string, cause: string): (facts: InstanceFacts, forecast: Forecast) => AlertText {
  return ({ measurement, readings }, forecast) => {
    const starts = name === "non-paged" && readings.starts !== undefined ? topStartsText(readings.starts, FORECAST_OWNERS_SHOWN) : "";
    const most = starts === "" ? "" : ` Most process starts: ${starts}.`;
    return {
      subject: `${name} pool`,
      mb: Math.round(measurement.used ?? 0),
      message: `The ${name} kernel pool grows ${rateText(forecast.rate, "MB")}. At this rate, it reaches its alert level of ${gb(forecast.target.amount)} ${whenText(forecast)}. ${cause}${most}`,
    };
  };
}

/** The text of the forecast alert of the commit charge, with the owners that hold the most private memory. */
function commitForecastText({ measurement, readings, owners }: InstanceFacts, forecast: Forecast): AlertText {
  const capacity = measurement.capacity ?? 0;
  const percent = capacity > 0 ? Math.round((forecast.target.amount / capacity) * 100) : 0;
  const top = byOwner("memory", readings.processes, owners, (info) => info.privateMb)
    .filter((each) => each.kind !== "lease" && each.amount > 0)
    .slice(0, FORECAST_OWNERS_SHOWN);
  const most = top.length === 0 ? "" : ` Most private memory: ${top.map((each) => `${each.owner} ${gb(each.amount)}`).join(", ")}.`;
  return {
    subject: "commit",
    mb: Math.round(measurement.used ?? 0),
    message: `The commit charge grows ${rateText(forecast.rate, "MB")}. At this rate, it reaches ${percent}% of its limit (${gb(forecast.target.amount)}) ${whenText(forecast)}.${most} At the limit, new allocations fail.`,
  };
}

/** The forecast part of a kind whose targets are only the limits of its level rules. */
const LEVEL_TARGETS: ForecastPart = {};

/** The memory: one instance. The capacity is the physical memory, and the free part is the available memory. */
const MEMORY_RESOURCE: Resource = {
  kind: "memory",
  unit: "MB",
  measure: {
    read: ({ memory }) => [{ id: "memory", capacity: memory.totalMb, used: memory.totalMb - memory.availableMb, free: memory.availableMb }],
  },
  attribute: perProcess("memory", "MB", (info) => info.privateMb),
  alert: {
    rules: (limits) => [
      {
        // Docker and WSL have caps of their own, and the system is not a job.
        type: "outlier",
        alert: "runaway",
        subject: "process",
        above: limits.runawayMb,
        skip: ["docker", "system", "kernel"],
        when: "unleased",
        text: ({ process, owner, amount }) => {
          const subject = `${process.name} (${process.pid})`;
          return { subject, mb: Math.round(amount), message: `${subject} of ${owner} holds ${gb(amount)} with no lease` };
        },
      },
      {
        // Nothing reads the output of an orphan.
        type: "outlier",
        alert: "orphan",
        subject: "process",
        above: limits.orphanMb,
        skip: [],
        only: ["other"],
        when: "orphaned",
        text: ({ process, amount }) => {
          const subject = `${process.name} (${process.pid})`;
          return { subject, mb: Math.round(amount), message: `${subject} holds ${gb(amount)}, and its parent (${process.ppid}) stopped` };
        },
      },
      {
        type: "level",
        alert: "memory",
        on: "free",
        warning: { amount: limits.availableMb },
        text: ({ measurement }) => {
          const free = Math.round(measurement.free ?? 0);
          return { subject: "memory", mb: free, message: `Only ${free} MB of memory is available` };
        },
      },
    ],
  },
  admit: {
    mode: "measured",
    reserve: { amount: 1024 },
    // A job that starts uses little memory, but its lease holds the rest of its amount.
    used: (lease, _id, readings) => (lease.pid === null ? 0 : treeMb(lease.pid, readings.processes)),
  },
  enforce: { limit: (amount) => ({ memoryMb: amount }), report: ["peakMb"] },
  // The target is the limit of the memory alert: 1 GB available.
  forecast: LEVEL_TARGETS,
};

/** The commit charge. Its capacity is the commit limit. A memory lease covers it, so it has no admit part. */
const COMMIT: Resource = {
  kind: "commit",
  unit: "MB",
  measure: {
    read: ({ memory }) => {
      const capacity = memory.commitLimitMb > 0 ? memory.commitLimitMb : null;
      return [{ id: "commit", capacity, used: memory.commitMb, free: capacity === null ? null : capacity - memory.commitMb }];
    },
  },
  attribute: null,
  alert: {
    rules: (limits) => [
      {
        type: "level",
        alert: "commit",
        on: "used",
        warning: { ratio: limits.commitRatio },
        text: ({ measurement }) => {
          const used = measurement.used ?? 0;
          return { subject: "commit", mb: Math.round(used), message: `The commit charge is ${gb(used)} of its limit ${gb(measurement.capacity ?? 0)}` };
        },
      },
      forecastRule("warning", limits.forecastCommitMs, commitForecastText),
    ],
  },
  admit: null,
  enforce: null,
  // The target is the limit of the commit alert: 90% of the commit limit.
  forecast: LEVEL_TARGETS,
};

/** The kernel pools. Windows tells no capacity, so only the used part counts. */
const POOL: Resource = {
  kind: "pool",
  unit: "MB",
  measure: {
    read: ({ memory }) => [
      { id: "pool:nonpaged", capacity: null, used: memory.kernelNonpagedMb, free: null },
      { id: "pool:paged", capacity: null, used: memory.kernelPagedMb, free: null },
    ],
  },
  attribute: null,
  alert: {
    rules: (limits) => {
      const nonpaged = poolText("non-paged pool", "non-paged", "A driver can leak it.");
      const paged = poolText("paged pool", "paged", "A file system filter can leak it.");
      // The rules of the non-paged pool keep the alert id `pool` of before.
      const pool = (): string => "pool";
      return [
        { type: "level", alert: "pool", alertId: pool, instance: "pool:nonpaged", on: "used", warning: { amount: limits.poolMb }, text: nonpaged },
        {
          type: "growth", alert: "pool", alertId: pool, instance: "pool:nonpaged", on: "used",
          windowMs: HOUR_MS, warning: limits.poolGrowthMb, minHistoryMs: 50 * 60_000, text: nonpaged,
        },
        { type: "level", alert: "pool", instance: "pool:paged", on: "used", warning: { amount: limits.pagedMb }, text: paged },
        {
          type: "growth", alert: "pool", instance: "pool:paged", on: "used",
          windowMs: HOUR_MS, warning: limits.pagedGrowthMb, minHistoryMs: 50 * 60_000, text: paged,
        },
        { ...forecastRule("warning", limits.forecastPoolMs, poolForecastText("non-paged", "A driver can leak it.")), instance: "pool:nonpaged" },
        { ...forecastRule("warning", limits.forecastPoolMs, poolForecastText("paged", "A file system filter can leak it.")), instance: "pool:paged" },
      ];
    },
  },
  admit: null,
  enforce: null,
  // The targets are the limits of the level rules of each pool: 3 GB non-paged and 4 GB paged.
  forecast: LEVEL_TARGETS,
};

/** The desktop of the session. Its used part is the count of the processes of the session. */
const DESKTOP: Resource = {
  kind: "desktop",
  unit: "count",
  measure: { read: ({ load }) => [{ id: "desktop", capacity: null, used: load.processes, free: null }] },
  attribute: null,
  alert: {
    rules: (limits) => [
      {
        type: "level",
        alert: "desktop",
        on: "used",
        warning: { amount: limits.processes },
        text: ({ readings: { load } }) => {
          const objects = load.userObjects === null ? "" : ` (${load.userObjects} USER and ${load.gdiObjects ?? 0} GDI objects)`;
          return {
            subject: "session",
            mb: 0,
            message: `${load.processes} processes run in this session${objects}. With this many, a new process can stop at its start with 0xC0000142, because the desktop heap runs out.`,
          };
        },
      },
    ],
  },
  admit: null,
  enforce: null,
};

/** The fixed drives: one instance for each drive. The free part is the space that this user can use. */
const DISK: Resource = {
  kind: "disk",
  unit: "MB",
  measure: {
    read: ({ disks }) => disks.map((disk) => ({ id: `disk:${disk.mount}`, capacity: disk.totalMb, used: disk.totalMb - disk.freeMb, free: disk.freeMb })),
  },
  attribute: DISK_WRITES,
  alert: {
    rules: (limits) => [
      {
        // With both limits, the lower one counts. Thus a small drive does not always alert.
        type: "level",
        alert: "disk",
        on: "free",
        severity: true,
        warning: { amount: limits.diskWarnMb, ratio: 0.2 },
        critical: { amount: limits.diskCriticalMb, ratio: 0.05 },
        text: ({ measurement, change, readings }) => {
          const mount = measurement.id.slice("disk:".length);
          const free = measurement.free ?? 0;
          const dropped = change?.freeLoss ?? 0;
          const minutes = (change?.windowMs ?? 0) / 60_000;
          const window = minutes >= 55 ? "one hour ago" : `${Math.round(minutes)} minutes ago`;
          const drop = dropped >= 100 && minutes >= 1 ? `, ${diskSize(dropped)} less than ${window}` : "";
          // The write counters do not name the drive, so each disk alert names the same owners (H20).
          const writers = writersText(readings.writes);
          return {
            subject: `drive ${mount}`,
            mb: Math.round(free),
            message: `Drive ${mount} has ${diskSize(free)} free of ${diskSize(measurement.capacity ?? 0)}${drop}.${writers}`,
          };
        },
      },
      forecastRule("critical", limits.forecastDiskMs, diskForecastText),
    ],
  },
  // A disk lease keeps its full amount until its release, because the write counters are larger than the new space.
  // The reserve is the critical limit of the disk alert.
  admit: { mode: "measured", reserve: { amount: 5120, ratio: 0.05 }, reserveFrom: "critical" },
  // Windows has no space quota for one job. H19 gives each job its own temp folder, and the release reports its size.
  enforce: { limit: () => null, report: ["tempMb"] },
  // The targets are the warning and the critical limits of the disk alert, and a full drive.
  forecast: { more: () => [{ on: "free", amount: 0, name: "empty" }] },
};

/** The count of owners that the text of the CPU alert names. */
const CPU_OWNERS_SHOWN = 3;

/** This function gives a part of the capacity as a whole percent. */
const percentOf = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/**
 * This function gives the text of the CPU alert (H23): the cores in use and the limit of its level. It also names the 3
 * owners with the most cores, and the leased jobs of those owners.
 */
function cpuText({ measurement, readings, owners, level }: InstanceFacts, limits: AlertRules): AlertText {
  const used = measurement.used ?? 0;
  const capacity = measurement.capacity ?? 0;
  const line = Math.round((level === "critical" ? limits.cpuCriticalRatio : limits.cpuWarnRatio) * 100);
  const minutes = Math.round(limits.cpuForMs / 60_000);
  // The process of `headroom run` holds each leased job, so its owner is the owner of the job.
  const leased = new Map<string, string[]>();
  for (const lease of readings.leases ?? []) {
    const owner = lease.pid === null ? undefined : owners.ownerOf.get(lease.pid);
    if (owner === undefined) continue;
    const cores = readings.leaseCores?.get(lease.id);
    leased.set(owner, [...(leased.get(owner) ?? []), `${lease.job.slice(0, 40)}${cores === undefined ? "" : ` ${cores.toFixed(1)}`}`]);
  }
  const top = (readings.cores ?? []).filter((each) => each.cores >= 0.05).slice(0, CPU_OWNERS_SHOWN);
  const named = top.map((each) => {
    const jobs = leased.get(each.owner);
    return `${each.owner} ${each.cores.toFixed(1)}${jobs === undefined ? "" : ` (leased: ${jobs.join(", ")})`}`;
  });
  const most = named.length === 0 ? "" : ` Most cores: ${named.join(", ")}.`;
  return {
    subject: "processors",
    mb: 0,
    message: `${used.toFixed(1)} of ${capacity} cores are in use (${percentOf(used, capacity)}%), above ${line}% for ${minutes} minutes.${most} A full processor makes the laptop slow for Mark, and timing tests of other sessions fail.`,
  };
}

/** This function gives the text of the runaway alert on a process tree with no lease (H23), in the style of the memory runaway alert. */
function runawayTreeText({ process, owner, amount, processes }: ProcessFacts, limits: AlertRules): AlertText {
  const subject = `${process.name} (${process.pid})`;
  const others = (processes ?? 1) - 1;
  const tree = others <= 0 ? "" : ` and its ${others} child ${others === 1 ? "process" : "processes"}`;
  const minutes = Math.round(limits.runawayCoresMs / 60_000);
  return {
    subject,
    mb: 0,
    message: `${subject} of ${owner}${tree} ${others <= 0 ? "uses" : "use"} ${coresText(amount)} with no lease, above ${coresText(limits.runawayCores)} for ${minutes} minutes. Run such work with headroom run --cpu.`,
  };
}

/**
 * The processors (H23). The capacity is the count of logical processors, and the used part is the cores in use, as an
 * average over the last minute. The broker counts the `cpu` amounts of the leases. It keeps a reserve for Mark out of
 * the count: 2 cores by default, or the setting `cpuReserve`. A configured pool `cpu` is a cap.
 */
const CPU: Resource = {
  kind: "cpu",
  unit: "cores",
  // The used part is the sum of the cores of all the owners. It is `null` before the tracker has two reads.
  measure: {
    read: ({ processors, cores }) => {
      if (cores === undefined) return [{ id: "cpu", capacity: processors, used: null, free: null }];
      const used = Math.round(cores.reduce((sum, each) => sum + each.cores, 0) * 100) / 100;
      return [{ id: "cpu", capacity: processors, used, free: Math.max(0, Math.round((processors - used) * 100) / 100) }];
    },
  },
  attribute: CPU_USE,
  alert: {
    rules: (limits) => [
      {
        // The level of a minute of builds and tests is often high, so the level must stay for some minutes.
        type: "level",
        alert: "cpu",
        alertId: () => "cpu",
        on: "used",
        severity: true,
        warning: { ratio: limits.cpuWarnRatio },
        critical: { ratio: limits.cpuCriticalRatio },
        forMs: limits.cpuForMs,
        clearMs: limits.cpuClearMs,
        text: (facts) => cpuText(facts, limits),
      },
      {
        // Docker and WSL have caps of their own, and the system is not a job.
        type: "outlier",
        alert: "runaway",
        alertId: (pid) => `runaway:cpu:${pid}`,
        subject: "tree",
        above: limits.runawayCores,
        forMs: limits.runawayCoresMs,
        clearMs: limits.cpuClearMs,
        skip: ["docker", "system", "kernel"],
        when: "unleased",
        text: (facts) => runawayTreeText(facts, limits),
      },
    ],
  },
  admit: { mode: "counted", reserve: { amount: CPU_RESERVE_DEFAULT } },
  // `--limit` gives a hard cap of the CPU rate. Without it, `headroom run` gives the job the default weight.
  enforce: { limit: (amount, processors) => ({ cpuRate: cpuRateOf(amount, processors) }), report: ["cpuMs"] },
};

/**
 * The network (H24): two instances, `net:in` and `net:out`, in MB/s for all the physical and Wi-Fi adapters together.
 * The capacity is the sum of the link speeds. The bytes of each process need ETW, so this kind has no attribute part.
 */
const NET: Resource = {
  kind: "net",
  unit: "MB/s",
  measure: {
    read: ({ network, previousNetwork }) => {
      if (network === undefined) return [];
      const flows = netFlows(previousNetwork, network);
      return (["in", "out"] as const).map((direction) => {
        const { capacity, used } = flows[direction];
        const free = capacity === null || used === null ? null : Math.max(0, Math.round((capacity - used) * 1000) / 1000);
        return { id: `net:${direction}`, capacity, used, free };
      });
    },
  },
  attribute: null,
  alert: NO_ALERTS,
  admit: null,
  enforce: null,
};

/** The count of owners that the text of the ports alert names. */
const PORT_OWNERS_SHOWN = 3;

/**
 * The attribute part of the TCP ports: the connections of each owner with a local port in the dynamic range. A row
 * with no process, for example TIME_WAIT on Windows, has no owner.
 */
const TCP_CONNECTIONS: Attribute = {
  unit: "count",
  // The read of a process has no count of connections, so the outlier rules do not examine the ports.
  counter: () => undefined,
  read: ({ tcp }, owners) =>
    tcp === undefined
      ? []
      : tcpByOwner(tcp, owners.ownerOf, owners.kindOf).map((each) => ({
          resource: "ports",
          owner: each.owner,
          kind: each.kind,
          amount: each.connections,
          processes: each.processes,
        })),
};

/**
 * The dynamic TCP ports (H24): one instance, `ports:tcp`. The capacity is the dynamic port range. The used part is the
 * count of connections with a local port in the range, in each state. When no port is free, new connections fail.
 */
const PORTS: Resource = {
  kind: "ports",
  unit: "count",
  measure: {
    read: ({ tcp }) => {
      if (tcp === undefined) return [];
      const { used } = dynamicUse(tcp);
      return [{ id: "ports:tcp", capacity: tcp.dynamic.count, used, free: tcp.dynamic.count - used }];
    },
  },
  attribute: TCP_CONNECTIONS,
  alert: {
    rules: (limits) => [
      {
        type: "level",
        alert: "ports",
        on: "used",
        severity: true,
        warning: { ratio: limits.portsWarnRatio },
        critical: { ratio: limits.portsCriticalRatio },
        text: ({ measurement, readings, owners }) => {
          const used = measurement.used ?? 0;
          const capacity = measurement.capacity ?? 0;
          const tcp = readings.tcp;
          const waiting = tcp === undefined ? 0 : dynamicUse(tcp).timeWait;
          const top = tcp === undefined ? [] : tcpByOwner(tcp, owners.ownerOf, owners.kindOf).slice(0, PORT_OWNERS_SHOWN);
          const most = top.length === 0 ? "" : ` Most connections: ${top.map((each) => `${each.owner} ${each.connections}`).join(", ")}.`;
          const percent = capacity > 0 ? Math.round((used / capacity) * 100) : 0;
          return {
            subject: "TCP ports",
            mb: 0,
            message: `${used} of ${capacity} dynamic TCP ports are in use (${percent}%), ${waiting} of them in TIME_WAIT.${most} When no dynamic port is free, new connections fail.`,
          };
        },
      },
    ],
  },
  // Later: a port lease for the dev servers.
  admit: null,
  enforce: null,
  // The targets are the limits of the ports alert: 80% and 95% of the dynamic ports.
  forecast: LEVEL_TARGETS,
};

/** This function gives a time span for a person: "30 s", "3 min" or "1.5 h". */
function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** This function gives the text of an alert on a service. The service does not answer, the MCP server does not start, or the answer is slow. */
function serviceText({ measurement }: InstanceFacts): AlertText {
  const health = measurement.health;
  const subject = health?.name ?? measurement.id;
  if (health === undefined) return { subject, mb: 0, message: `The service ${measurement.id} has no health data.` };
  if (health.state === "slow") {
    return { subject, mb: 0, message: `${health.title} answers slowly: ${health.latencyMs ?? 0} ms at the last check, ${health.checks} slow checks in a row.` };
  }
  if (health.type === "mcp") return { subject, mb: 0, message: `${health.title} does not start: ${(health.error ?? "no reason").replace(/\.+$/, "")}.` };
  const since = new Date(health.since).toISOString().slice(11, 16);
  const needs = health.needs === null ? "" : ` ${health.needs}`;
  return {
    subject,
    mb: 0,
    message: `${health.title} does not answer since ${since} UTC (${span(health.checkedAt - health.since)}).${needs} headroom does not restart it.`,
  };
}

/**
 * The shared services (H27). Each service has one instance: `service:docker`, `service:mcp:<server>`, and `service:<name>`
 * for each URL of the setting `health`. The unit is `state`. The measurement has the health, and the used part is the
 * latency of the last check. An alert does not restart a service.
 */
const SERVICE: Resource = {
  kind: "service",
  unit: "state",
  measure: {
    read: ({ services }) => (services ?? []).map((health) => ({ id: `service:${health.name}`, capacity: null, used: health.latencyMs, free: null, health })),
  },
  attribute: null,
  alert: {
    rules: (limits) => [
      // Docker and the MCP servers are critical. The services of the setting `health` give a warning.
      {
        type: "health", alert: "service", severity: true, state: "down", checks: limits.serviceDownChecks,
        level: (health) => (health.critical ? "critical" : "warning"), text: serviceText,
      },
      { type: "health", alert: "service", severity: true, state: "slow", checks: limits.serviceSlowChecks, level: () => "warning", text: serviceText },
    ],
  },
  admit: null,
  enforce: null,
};

/** The count of owners and jobs that the text of the churn alert names. */
const CHURN_SHOWN = 3;

/** The reason of the churn alert, for the reader. */
const CHURN_CAUSE = "Each new process leaks kernel memory in the AMD display driver until it is updated (hub ask amd-driver).";

/**
 * The attribute part of the process starts (H29): the starts of each owner in one minute, its jobs and its own commands
 * together. The own commands are a lower bound, because a read every 10 seconds misses most short processes.
 */
const PROCESS_STARTS: Attribute = {
  unit: "per minute",
  // A read of a process has no count of starts, so the outlier rules do not examine the starts.
  counter: () => undefined,
  read: ({ starts }) =>
    (starts?.owners ?? []).map((each) => ({ resource: "procs", owner: each.owner, kind: each.kind, amount: each.perMinute, processes: 0 })),
};

/** This function gives the text of the churn alert: the rate, the owners and the leased jobs with the most starts, and the reason. */
function churnText({ measurement, readings }: InstanceFacts): AlertText {
  const starts = readings.starts;
  const rate = countText(measurement.used ?? 0);
  const minutes = Math.round((starts?.spanMs ?? STARTS_WINDOW_MS) / 60_000);
  const most = starts === undefined ? "" : topStartsText(starts, CHURN_SHOWN);
  const jobs = (starts?.jobs ?? []).filter((each) => each.processes > 0).slice(0, CHURN_SHOWN);
  const named = most === "" ? "" : ` Most: ${most}.`;
  const leased = jobs.length === 0 ? "" : ` Leased jobs with the most starts: ${jobs.map((each) => `${each.job} of ${each.holder} ${countText(each.processes)} so far`).join(", ")}.`;
  return { subject: "process starts", mb: 0, message: `Processes start at ${rate} a minute over the last ${minutes} minutes.${named}${leased} ${CHURN_CAUSE}` };
}

/**
 * The process starts (H29): one instance, `procs`, in starts per minute over the last 10 minutes. It has no capacity.
 * On Windows, the sequence numbers of the processes give the exact count. Elsewhere, the count is a lower bound.
 */
const PROCS: Resource = {
  kind: "procs",
  unit: "per minute",
  measure: { read: ({ starts }) => (starts === undefined || starts.spanMs <= 0 ? [] : [{ id: "procs", capacity: null, used: starts.perMinute, free: null }]) },
  attribute: PROCESS_STARTS,
  alert: {
    rules: (limits) => [
      {
        // The rate is an average over 10 minutes, so the rule waits for the full window.
        type: "level",
        alert: "churn",
        alertId: () => "churn",
        on: "used",
        severity: true,
        warning: { amount: limits.churnPerMinute },
        minHistoryMs: STARTS_WINDOW_MS * 0.95,
        text: churnText,
      },
    ],
  },
  admit: null,
  enforce: null,
};

/** This function gives an amount in mWh in Wh, with 2 decimals. */
const wh = (mwh: number): number => Math.round(mwh / 10) / 100;

/** This function gives the text of a battery in a sentence, for example "on battery (47%, 21.9 W, 1 h 7 min left)". */
function batteryPhrase(state: BatteryState): string {
  const [source, ...rest] = batteryParts(state);
  return rest.length === 0 ? (source ?? "") : `${source ?? ""} (${rest.join(", ")})`;
}

/** This function gives the level of the low battery alert: on battery only, from the time left and the charge. */
export function batteryLevel(state: BatteryState | undefined, limits: AlertRules): Level | null {
  if (state === undefined || state.ac) return null;
  const minutes = state.minutesLeft;
  if (state.percent < limits.batteryCriticalPercent || (minutes !== null && minutes < limits.batteryCriticalMinutes)) return "critical";
  if (minutes !== null && minutes < limits.batteryWarnMinutes) return "warning";
  return null;
}

/**
 * This function gives the forecast of the battery (H32): the time left that Windows estimates, on battery only. The rate is
 * the rate of the battery in W, the change of the charge in Wh in one hour.
 */
export function batteryForecast(measurement: Measurement, now: number): Forecast | null {
  const state = measurement.battery;
  if (state === undefined || state.ac || state.minutesLeft === null) return null;
  return {
    minutes: state.minutesLeft,
    at: now + state.minutesLeft * 60_000,
    target: { on: "free", amount: 0, name: "empty" },
    rate: state.rateW ?? 0,
    confidence: 1,
    source: "windows",
  };
}

/** The count of jobs and owners that the text of the battery alert names. */
const BATTERY_SHOWN = 3;

/** This function gives the text of the low battery alert. */
function lowBatteryText({ measurement }: InstanceFacts): AlertText {
  const state = measurement.battery;
  if (state === undefined) return { subject: "battery", mb: 0, message: "The battery has no data." };
  const left = state.minutesLeft === null ? `${state.percent}%` : `${state.percent}%, ${minutesText(state.minutesLeft)} left`;
  return {
    subject: "battery",
    mb: 0,
    message: `The laptop runs on battery: ${left}. Connect the charger. At the critical level, Windows puts the laptop to sleep, and the jobs stop.`,
  };
}

/** This function gives the text of the alert on the leased jobs that run on battery, with the owners that use the most power. */
function batteryJobsText({ measurement, readings }: InstanceFacts): AlertText {
  const leases = readings.leases ?? [];
  const named = leases.slice(0, BATTERY_SHOWN).map((lease) => `${lease.job.slice(0, 60)} of ${lease.holder}`).join(", ");
  const more = leases.length > BATTERY_SHOWN ? ` and ${leases.length - BATTERY_SHOWN} more` : "";
  const most = ownersWattsText(powerOwners(readings.cores, cpuWatts(readings.meters)), BATTERY_SHOWN);
  const source = measurement.battery === undefined ? "on battery" : batteryPhrase(measurement.battery);
  const jobs = `${leases.length} leased ${leases.length === 1 ? "job runs" : "jobs run"}`;
  return {
    subject: "battery",
    mb: 0,
    message: `The laptop runs ${source}, and ${jobs}: ${named}${more}.${most === "" ? "" : ` Most power (estimate): ${most}.`} The jobs run in efficiency mode. Connect the charger for full speed.`,
  };
}

/**
 * The battery (H30): one instance, `battery`, in Wh. The capacity is the full charge capacity, and the free part is the
 * charge. The measurement has the power source, the percent, the rate and the time left. A computer with no battery has
 * no instance. Only Windows reads the battery.
 */
const BATTERY: Resource = {
  kind: "battery",
  unit: "Wh",
  measure: {
    read: ({ battery }) =>
      battery === undefined
        ? []
        : [{ id: "battery", capacity: wh(battery.maxMwh), used: wh(battery.maxMwh - battery.remainingMwh), free: wh(battery.remainingMwh), battery: batteryState(battery) }],
  },
  attribute: null,
  alert: {
    // Both rules need the battery, so an alert ends when AC power returns.
    rules: (limits) => [
      { type: "check", alert: "battery", severity: true, level: ({ measurement }) => batteryLevel(measurement.battery, limits), text: lowBatteryText },
      {
        type: "check",
        alert: "battery",
        alertId: () => "battery:jobs",
        severity: true,
        level: ({ measurement, readings }) => (measurement.battery?.ac === false && (readings.leases ?? []).length > 0 ? "warning" : null),
        text: batteryJobsText,
      },
    ],
  },
  // H31: the battery admits no amount. The conditions of `conditions.ts` read the power source and the charge: a heavy job
  // waits below the battery floor, and a job with `--timing` or `--when ac` waits for AC power.
  admit: null,
  // The client of `headroom run` puts its job in efficiency mode (EcoQoS) on battery, from the answer of its heartbeat.
  enforce: null,
  // H32: Windows estimates the time left on battery from its own rate, so the battery has no fit.
  forecast: { given: batteryForecast },
};

/**
 * The attribute part of the power (H30): an estimate in watts. The power of an owner is the CPU power times its part of the
 * cores over the last minute. Windows gives no energy counter for each process without admin rights.
 */
const POWER_USE: Attribute = {
  unit: "W",
  // A read of a process has no power, so the outlier rules do not examine the power.
  counter: () => undefined,
  read: ({ cores, meters }) =>
    powerOwners(cores, cpuWatts(meters)).map((each) => ({ resource: "power", owner: each.owner, kind: each.kind, amount: each.watts, processes: 0 })),
};

/**
 * The power of the computer (H30): one instance, `power`, in watts. The used part is the meter `system power` of the counter
 * set "Energy Meter". It has no capacity. A computer with no Energy Meter has no instance.
 */
const POWER: Resource = {
  kind: "power",
  unit: "W",
  measure: {
    read: ({ meters }) => {
      const watts = systemWatts(meters);
      return watts === null ? [] : [{ id: "power", capacity: null, used: Math.round(watts * 10) / 10, free: null }];
    },
  },
  attribute: POWER_USE,
  alert: NO_ALERTS,
  admit: null,
  enforce: null,
};

/** A slot: `browser`, `docker` or any other name. Its capacity is configured with `headroom pool`, else 1. */
const SLOT: Resource = {
  kind: "slot",
  unit: "count",
  measure: {
    read: ({ pools, granted }) =>
      [...new Set([...Object.keys(pools), ...Object.keys(granted)])]
        .filter((id) => kindOf(id) === "slot")
        .map((id) => {
          const capacity = pools[id] ?? 1;
          const used = granted[id] ?? 0;
          return { id, capacity, used, free: capacity - used };
        }),
  },
  attribute: null,
  alert: NO_ALERTS,
  admit: { mode: "counted", reserve: {}, defaultCapacity: 1 },
  enforce: null,
};

/** The resource kinds by name, in the order of their measurements and their alerts. */
export const RESOURCES: ReadonlyMap<ResourceKind, Resource> = new Map(
  [MEMORY_RESOURCE, COMMIT, POOL, DESKTOP, DISK, CPU, NET, PORTS, SERVICE, PROCS, BATTERY, POWER, SLOT].map((resource) => [resource.kind, resource]),
);

/** This function gives the kind of an id: `disk:D:` gives `disk`, and `browser` gives `slot`. */
export function kindOf(id: ResourceId): ResourceKind {
  const colon = id.indexOf(":");
  const name = colon < 0 ? id : id.slice(0, colon);
  for (const kind of RESOURCES.keys()) if (kind === name) return kind;
  return "slot";
}

/** This function gives the resource of an id. An id with no known kind gives the slot. */
export function resourceOf(id: ResourceId): Resource {
  return RESOURCES.get(kindOf(id)) ?? SLOT;
}

/** This function gives the amount of a limit for a capacity, or `null` when the limit has no amount and no usable ratio. */
export function limitOf(limit: Limit, capacity: number | null): number | null {
  const amounts: number[] = [];
  if (limit.amount !== undefined) amounts.push(limit.amount);
  if (limit.ratio !== undefined && capacity !== null) amounts.push(limit.ratio * capacity);
  return amounts.length === 0 ? null : Math.min(...amounts);
}

/** This function gives the level of an instance for a level rule, or `null` when the instance is inside the limits. */
export function levelOf(rule: LevelRule, measurement: Measurement): Level | null {
  const value = rule.on === "free" ? measurement.free : measurement.used;
  if (value === null) return null;
  for (const level of ["critical", "warning"] as const) {
    const limit = rule[level];
    const amount = limit === undefined ? null : limitOf(limit, measurement.capacity);
    if (amount === null) continue;
    if (rule.on === "free" ? value < amount : value > amount) return level;
  }
  return null;
}

/** The order of the levels: an active critical alert also holds the warning. */
const RANK: Readonly<Record<Level, number>> = { warning: 1, critical: 2 };

/**
 * This function gives the level of an instance for a level rule with a duration (H23), or `null`. A level starts when the
 * trail stays past its limit for `forMs`. An active level ends after `clearMs` inside its limit. `active` is the level of
 * the active alert of the rule. A rule with no `forMs` gives `levelOf()`, and a rule with no trail gives `null`.
 */
export function sustainedLevel(rule: LevelRule, measurement: Measurement, trail: readonly TrailPoint[] | undefined, now: number, active: Level | null): Level | null {
  if (rule.forMs === undefined) return levelOf(rule, measurement);
  if (trail === undefined || trail.length === 0) return null;
  // A capacity of 0 is no capacity, for example the processors of a check with no count of them.
  const capacity = measurement.capacity !== null && measurement.capacity > 0 ? measurement.capacity : null;
  for (const level of ["critical", "warning"] as const) {
    const limit = rule[level];
    const amount = limit === undefined ? null : limitOf(limit, capacity);
    if (amount === null) continue;
    // The trail gives the used part. The free part is the capacity less the used part.
    const past = (used: number): boolean => (rule.on === "free" ? capacity !== null && capacity - used < amount : used > amount);
    if (heldMs(trail, now, past) >= rule.forMs) return level;
    if (active !== null && RANK[active] >= RANK[level] && heldMs(trail, now, (used) => !past(used)) < (rule.clearMs ?? 0)) return level;
  }
  return null;
}

/**
 * This function tells if a process tree stays above the amount of a tree rule (H23). It starts after `forMs` above the
 * amount. An active alert ends after `clearMs` at or below the amount.
 */
export function treeAbove(rule: OutlierRule, trail: readonly TrailPoint[], now: number, active: boolean): boolean {
  if (trail.length === 0) return false;
  const above = (cores: number): boolean => cores > rule.above;
  if (heldMs(trail, now, above) >= (rule.forMs ?? 0)) return true;
  return active && heldMs(trail, now, (cores) => !above(cores)) < (rule.clearMs ?? 0);
}

/** This function gives the level of a service for a health rule, or `null` when the service has not had the state for enough checks. */
export function healthLevel(rule: HealthRule, measurement: Measurement): Level | null {
  const health = measurement.health;
  return health !== undefined && health.state === rule.state && health.checks >= rule.checks ? rule.level(health) : null;
}

/** This function tells if the change of an instance passes the limit of a growth rule. A change over a short history does not. */
export function grows(rule: GrowthRule, change: Change | undefined): boolean {
  if (change === undefined || change.windowMs < rule.minHistoryMs) return false;
  const amount = rule.on === "used" ? change.usedGain : change.freeLoss;
  return amount !== undefined && amount > rule.warning;
}

/** This function tells if the forecast of an id comes from a fit of its history (H32). The battery has a forecast with no fit. */
export function fitsHistory(id: ResourceId): boolean {
  const part = resourceOf(id).forecast;
  return part !== undefined && part.given === undefined;
}

/**
 * This function gives the targets of the forecast of an instance (H32). They are the warning and the critical limit of each
 * level rule of its kind, and the targets of its forecast part. A rule with a duration does not count, because a level of
 * one read does not start its alert. A kind with no forecast part, or with a forecast with no fit, has no targets.
 */
export function forecastTargets(measurement: Measurement, limits: AlertRules): ForecastTarget[] {
  const resource = resourceOf(measurement.id);
  const part = resource.forecast;
  if (part === undefined || part.given !== undefined) return [];
  const targets: ForecastTarget[] = [];
  for (const rule of resource.alert.rules(limits)) {
    if (rule.type !== "level" || rule.forMs !== undefined || (rule.instance !== undefined && rule.instance !== measurement.id)) continue;
    for (const name of ["warning", "critical"] as const) {
      const limit = rule[name];
      const amount = limit === undefined ? null : limitOf(limit, measurement.capacity);
      if (amount !== null) targets.push({ on: rule.on, amount: Math.round(amount * 100) / 100, name });
    }
  }
  return [...targets, ...(part.more?.(measurement) ?? [])];
}

/**
 * This function gives the forecasts of an instance to each of its targets, the nearest first (H32). `trendOf` gives the
 * fit of one part of the instance. The start of each forecast is the measurement at `now`.
 */
export function forecastsOf(measurement: Measurement, trendOf: (part: Part) => Trend | null, limits: AlertRules, now: number): Forecast[] {
  const part = resourceOf(measurement.id).forecast;
  if (part === undefined) return [];
  if (part.given !== undefined) {
    const given = part.given(measurement, now);
    return given === null ? [] : [given];
  }
  const list: Forecast[] = [];
  for (const target of forecastTargets(measurement, limits)) {
    const trend = trendOf(target.on);
    const forecast = trend === null ? null : forecastFrom(trend, target, now, measurement[target.on]);
    if (forecast !== null) list.push(forecast);
  }
  return list.sort((a, b) => a.minutes - b.minutes);
}

/** This function gives the measurements of all the kinds at one tick, in the order of the kinds. */
export function measure(readings: Readings): Measurement[] {
  return [...RESOURCES.values()].flatMap((resource) => resource.measure.read(readings));
}

/** The count of owners of each instance in `Status.resources`. */
const OWNERS_SHOWN = 10;

/** This function rounds the use of an owner for its unit: a count to a whole number, else 1 decimal, as the dashboard shows it. */
function roundFor(unit: Unit, value: number): number {
  const scale = unit === "count" ? 1 : 10;
  return Math.round(value * scale) / scale;
}

/**
 * This function adds the kind, the unit and the owners to each measurement. The owners come from the attribute part of the
 * kind, with the reads and the owners of the processes. The rows of the leases are absent, because they are parts of their owners.
 * With the forecasts of the instances, each instance gets its nearest forecast (H32).
 */
export function withKinds(
  measurements: readonly Measurement[],
  attribution?: { readonly readings: Readings; readonly owners: Owners },
  forecasts?: ReadonlyMap<ResourceId, readonly Forecast[]>,
): ResourceStatus[] {
  const byKind = new Map<ResourceKind, readonly ResourceOwner[]>();
  const ownersOf = (resource: Resource): readonly ResourceOwner[] => {
    const attribute = resource.attribute;
    if (attribute === null || attribution === undefined) return [];
    let list = byKind.get(resource.kind);
    if (list === undefined) {
      list = attribute
        .read(attribution.readings, attribution.owners)
        .flatMap((use) => (use.kind === "lease" ? [] : [{ owner: use.owner, kind: use.kind, value: roundFor(attribute.unit, use.amount), unit: attribute.unit }]))
        .filter((each) => each.value > 0)
        .slice(0, OWNERS_SHOWN);
      byKind.set(resource.kind, list);
    }
    return list;
  };
  return measurements.map((each) => {
    const resource = resourceOf(each.id);
    const health = each.health === undefined ? {} : { health: each.health };
    const battery = each.battery === undefined ? {} : { battery: each.battery };
    const nearest = forecasts?.get(each.id)?.[0];
    return {
      id: each.id,
      kind: resource.kind,
      unit: resource.unit,
      capacity: each.capacity,
      used: each.used,
      free: each.free,
      ...health,
      ...battery,
      owners: ownersOf(resource),
      ...(nearest === undefined ? {} : { forecast: nearest }),
    };
  });
}

/**
 * This function gives the reserve of one id for a capacity. With alert limits and `reserveFrom`, the reserve is the limit
 * of that level in the level rule of the kind. Otherwise, it is the reserve of the admit part.
 */
export function reserveOf(id: ResourceId, capacity: number | null, limits?: AlertRules): number {
  const resource = resourceOf(id);
  const admit = resource.admit;
  if (admit === null) return 0;
  if (admit.reserveFrom !== undefined && limits !== undefined) {
    const rule = resource.alert
      .rules(limits)
      .find((each): each is LevelRule => each.type === "level" && each.on === "free" && (each.instance === undefined || each.instance === id));
    const limit = rule?.[admit.reserveFrom];
    if (limit !== undefined) return limitOf(limit, capacity) ?? 0;
  }
  return limitOf(admit.reserve, capacity) ?? 0;
}

/**
 * This function gives the room of one id. A kind with no admit part counts as a slot. A measured instance
 * with no measurement, for example a drive that does not exist, gets the capacity 0.
 */
export function roomOf(id: ResourceId, measurement: Measurement | undefined, pools: Amounts, reserve?: number, limits?: AlertRules): Room {
  const admit = resourceOf(id).admit;
  const configured = pools[id];
  if (admit === null) return { mode: "counted", capacity: configured ?? 1, free: null, reserve: 0 };
  if (admit.mode === "measured") {
    const capacity = measurement?.capacity ?? 0;
    return { mode: "measured", capacity, free: measurement?.free ?? 0, reserve: reserve ?? reserveOf(id, capacity, limits) };
  }
  // A counted instance with a measured capacity uses the configured pool as a cap.
  const measured = measurement?.capacity ?? null;
  if (measured === null) {
    const capacity = configured ?? admit.defaultCapacity ?? 1;
    return { mode: "counted", capacity, free: null, reserve: reserve ?? reserveOf(id, capacity, limits) };
  }
  // The reserve keeps the last units of the measured capacity (H23). A pool below them already keeps them, so the
  // reserve is only the part above the pool: 16 processors, a pool of 15 and a reserve of 2 give 14 cores.
  const capacity = Math.min(measured, configured ?? measured);
  const kept = reserve ?? reserveOf(id, measured, limits);
  return { mode: "counted", capacity, free: null, reserve: Math.max(0, kept - (measured - capacity)) };
}

/**
 * This function gives the room of each id from the measurements, the configured pools and the reserves that the caller sets.
 * With alert limits, the reserve of a drive is the critical limit of the disk alert.
 */
export function rooms(
  ids: Iterable<ResourceId>,
  measurements: readonly Measurement[],
  pools: Amounts,
  reserves: Amounts = {},
  limits?: AlertRules,
): Record<ResourceId, Room> {
  const byId = new Map(measurements.map((each) => [each.id, each]));
  const result: Record<ResourceId, Room> = {};
  for (const id of ids) result[id] = roomOf(id, byId.get(id), pools, reserves[id], limits);
  return result;
}

/**
 * This function gives the lease of each process under a granted lease: the lease process and its descendants. A child
 * that started before its parent ID is not a descendant, because the ID is in use again (H29).
 */
export function leasesOf(processes: readonly ProcessInfo[], leases: readonly Lease[]): Map<number, string> {
  const children = new Map<number, number[]>();
  for (const [ppid, list] of childrenOf(processes)) children.set(ppid, list.map((info) => info.pid));
  const result = new Map<number, string>();
  for (const lease of leases) {
    if (lease.state !== "granted" || lease.pid === null) continue;
    const stack = [lease.pid];
    while (stack.length > 0) {
      const pid = stack.pop() as number;
      if (result.has(pid)) continue;
      result.set(pid, lease.id);
      stack.push(...(children.get(pid) ?? []));
    }
  }
  return result;
}
