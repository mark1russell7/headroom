/**
 * The resource model of headroom (H22, `docs/RESOURCES.md`).
 *
 * Each resource kind has five parts: measure, attribute, alert, admit and enforce. A part is a pure function of
 * the reads of one tick. It has no clock and no input or output of its own, so the tests use fixed reads.
 */

import type { Alert, AlertKind, AlertRules } from "./alerts.ts";
import type { Lease } from "./broker.ts";
import type { JobLimits } from "./jobs.ts";
import { treeMb } from "./owners.ts";
import type { Amounts, DiskSpace, OwnerKind, ProcessInfo, SessionLoad, SystemMemory } from "./types.ts";
import { diskSize, gb } from "./units.ts";

/** One instance of a resource: `memory`, `cpu`, `disk:D:` or `browser`. A lease amount names it. */
export type ResourceId = string;

/** The kinds of resource. An id with no known kind is a slot, as before. */
export type ResourceKind = "memory" | "commit" | "pool" | "desktop" | "disk" | "cpu" | "slot" | "network" | "port" | "gpu";

/** The unit of the amounts of a kind. The disk writes use MB/h. */
export type Unit = "MB" | "cores" | "count" | "MB/h";

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
}

/** The level of one instance, with its kind and its unit. `Status.resources` gives one for each instance. */
export interface ResourceStatus extends Measurement {
  readonly kind: ResourceKind;
  readonly unit: Unit;
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
}

/** The facts of an alert on one process. */
export interface ProcessFacts {
  readonly process: ProcessInfo;
  readonly owner: string;
  /** The counter of the process, in the unit of the kind. */
  readonly amount: number;
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
  /** The condition must continue for this time (H23). CPU uses it, because short peaks are normal. */
  readonly forMs?: number | undefined;
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

/** A rule on one process. */
export interface OutlierRule extends RuleBase {
  readonly type: "outlier";
  readonly subject: "process" | "owner";
  /** A counter above this amount starts the alert. */
  readonly above: number;
  /** The owner kinds that the rule does not examine. `runaway` skips docker, system and kernel. */
  readonly skip: readonly OwnerKind[];
  /** With this list, the rule examines only these owner kinds. `orphan` examines only `other`. */
  readonly only?: readonly OwnerKind[] | undefined;
  /** `unleased`: no lease holds the process. `orphaned`: its parent stopped. */
  readonly when: "always" | "unleased" | "orphaned";
  text(facts: ProcessFacts): AlertText;
}

/** One alert rule of a kind. */
export type Rule = LevelRule | GrowthRule | OutlierRule;

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
  /** This function gives the limit for an amount, with `--limit`. `null`: the kind has no limit, so headroom only reports. */
  limit(amount: number): Partial<JobLimits> | null;
  /** This function gives the setup of a job for its lease. */
  setup?(lease: Lease): JobSetup;
  /** The fields of `JobUsage` that the kind reports at the release. */
  readonly report: readonly (keyof JobUsage)[];
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

/** This function gives the attribute part of a kind from the counter of one process. */
function perProcess(resource: ResourceKind, unit: Unit, counter: (info: ProcessInfo) => number | undefined): Attribute {
  return {
    unit,
    counter,
    read(readings, owners) {
      const sums = new Map<string, { kind: OwnerKind | "lease"; amount: number; processes: number }>();
      const add = (owner: string, kind: OwnerKind | "lease", amount: number): void => {
        const sum = sums.get(owner) ?? { kind, amount: 0, processes: 0 };
        sum.amount += amount;
        sum.processes += 1;
        sums.set(owner, sum);
      };
      for (const info of readings.processes) {
        const amount = counter(info);
        if (amount === undefined) continue;
        const owner = owners.ownerOf.get(info.pid) ?? "other";
        add(owner, owners.kindOf.get(owner) ?? "other", amount);
        const lease = owners.leaseOf.get(info.pid);
        if (lease !== undefined) add(`lease:${lease}`, "lease", amount);
      }
      return [...sums]
        .map(([owner, sum]) => ({ resource, owner, kind: sum.kind, amount: sum.amount, processes: sum.processes }))
        .sort((a, b) => b.amount - a.amount);
    },
  };
}

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
    ],
  },
  admit: null,
  enforce: null,
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
      ];
    },
  },
  admit: null,
  enforce: null,
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
  attribute: null,
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
        text: ({ measurement, change }) => {
          const mount = measurement.id.slice("disk:".length);
          const free = measurement.free ?? 0;
          const dropped = change?.freeLoss ?? 0;
          const minutes = (change?.windowMs ?? 0) / 60_000;
          const window = minutes >= 55 ? "one hour ago" : `${Math.round(minutes)} minutes ago`;
          const drop = dropped >= 100 && minutes >= 1 ? `, ${diskSize(dropped)} less than ${window}` : "";
          return { subject: `drive ${mount}`, mb: Math.round(free), message: `Drive ${mount} has ${diskSize(free)} free of ${diskSize(measurement.capacity ?? 0)}${drop}.` };
        },
      },
    ],
  },
  // A disk lease keeps its full amount until its release, because the write counters are larger than the new space.
  // The reserve is the critical limit of the disk alert.
  admit: { mode: "measured", reserve: { amount: 5120, ratio: 0.05 }, reserveFrom: "critical" },
  // Windows has no space quota for one job. H19 gives each job its own temp folder, and the release reports its size.
  enforce: { limit: () => null, report: ["tempMb"] },
};

/**
 * The processors. Until H23 measures their use, the broker counts them: the capacity is the count of logical processors,
 * less the granted amounts. A configured pool `cpu` is a cap.
 */
const CPU: Resource = {
  kind: "cpu",
  unit: "cores",
  measure: { read: ({ processors }) => [{ id: "cpu", capacity: processors, used: null, free: null }] },
  attribute: null,
  alert: NO_ALERTS,
  admit: { mode: "counted", reserve: {} },
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
  [MEMORY_RESOURCE, COMMIT, POOL, DESKTOP, DISK, CPU, SLOT].map((resource) => [resource.kind, resource]),
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

/** This function tells if the change of an instance passes the limit of a growth rule. A change over a short history does not. */
export function grows(rule: GrowthRule, change: Change | undefined): boolean {
  if (change === undefined || change.windowMs < rule.minHistoryMs) return false;
  const amount = rule.on === "used" ? change.usedGain : change.freeLoss;
  return amount !== undefined && amount > rule.warning;
}

/** This function gives the measurements of all the kinds at one tick, in the order of the kinds. */
export function measure(readings: Readings): Measurement[] {
  return [...RESOURCES.values()].flatMap((resource) => resource.measure.read(readings));
}

/** This function adds the kind and the unit to each measurement. */
export function withKinds(measurements: readonly Measurement[]): ResourceStatus[] {
  return measurements.map((each) => {
    const resource = resourceOf(each.id);
    return { id: each.id, kind: resource.kind, unit: resource.unit, capacity: each.capacity, used: each.used, free: each.free };
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
  const capacity = measured === null ? (configured ?? admit.defaultCapacity ?? 1) : Math.min(measured, configured ?? measured);
  return { mode: "counted", capacity, free: null, reserve: reserve ?? reserveOf(id, capacity, limits) };
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

/** This function gives the lease of each process under a granted lease: the lease process and its descendants. */
export function leasesOf(processes: readonly ProcessInfo[], leases: readonly Lease[]): Map<number, string> {
  const children = new Map<number, number[]>();
  for (const info of processes) {
    if (info.pid === info.ppid) continue;
    children.set(info.ppid, [...(children.get(info.ppid) ?? []), info.pid]);
  }
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
