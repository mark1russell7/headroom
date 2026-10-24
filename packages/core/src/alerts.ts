/**
 * The alerts (H9, H14): the conditions that come before a computer runs out of memory.
 *
 * - `runaway`: one process above a size that holds no lease, outside Docker and the system.
 * - `orphan`: a large process with no owner whose parent stopped. Nothing reads its output.
 * - `memory`: little available memory.
 * - `commit`: a commit charge near its limit.
 * - `pool`: a large kernel pool (non-paged or paged), or a pool that grows fast. A driver leak shows here.
 * - `desktop`: many processes in the session. The desktop heap can run out, and new processes then fail at their start.
 * - `disk`: little free space on a fixed drive. A full drive stops the builds, the tests and git of all the sessions.
 * - `stop`: an event, not a condition. Another process stopped the daemon or the clients of `headroom run`.
 *   An event alert stays active for some minutes.
 *
 * The alerts only report. headroom does not stop a process for an alert.
 *
 * The rules of each kind are in the alert part of its resource (`resources.ts`). `detect()` examines them in the
 * order of the kinds, and adds no text of its own.
 */

import type { Lease } from "./broker.ts";
import { grows, leasesOf, levelOf, RESOURCES, type Change, type Level, type LevelRule, type OutlierRule, type Owners, type Readings, type ResourceId } from "./resources.ts";
import type { DiskSpace, OwnerKind, ProcessInfo, SessionLoad, SystemMemory } from "./types.ts";

export { diskSize } from "./units.ts";

/** The kind of an alert. */
export type AlertKind = "runaway" | "orphan" | "memory" | "commit" | "pool" | "desktop" | "disk" | "stop";

/** The level of an alert. Only some kinds set it. */
export type AlertSeverity = "warning" | "critical";

/** One active alert. */
export interface Alert {
  /** The key of the alert: the kind and the subject. The same condition keeps the same key. */
  readonly id: string;
  readonly kind: AlertKind;
  /** The process, or the part of the computer. */
  readonly subject: string;
  readonly pid: number | null;
  /** The size that started the alert, in MB. */
  readonly mb: number;
  readonly message: string;
  /** The level of the alert. Without it, the kind gives the level. */
  readonly severity?: AlertSeverity | undefined;
  /** The time of the first sample that showed the condition. */
  readonly since: number;
}

/** The limits of the alerts. */
export interface AlertRules {
  /** A process above this size, in MB, with no lease, is a runaway. The default is 4096. */
  readonly runawayMb: number;
  /** An orphan above this size, in MB, starts an alert. The default is 1024. */
  readonly orphanMb: number;
  /** Less available memory than this, in MB, starts an alert. The default is 1024. */
  readonly availableMb: number;
  /** A commit charge above this part of its limit starts an alert. The default is 0.9. */
  readonly commitRatio: number;
  /** A non-paged pool above this size, in MB, starts an alert. The default is 3072. */
  readonly poolMb: number;
  /** A non-paged pool that grows more than this in one hour, in MB, starts an alert. The default is 500. */
  readonly poolGrowthMb: number;
  /** A paged pool above this size, in MB, starts an alert. The default is 4096. */
  readonly pagedMb: number;
  /** A paged pool that grows more than this in one hour, in MB, starts an alert. The default is 500. */
  readonly pagedGrowthMb: number;
  /** More processes than this in the session start an alert. The default is 1000. */
  readonly processes: number;
  /** Less free space than this on a fixed drive, in MB, starts a disk warning. The default is 20480. */
  readonly diskWarnMb: number;
  /** Less free space than this on a fixed drive, in MB, starts a critical disk alert, and `headroom run` does not start a job. The default is 5120. */
  readonly diskCriticalMb: number;
}

/** The default limits. */
export const DEFAULT_ALERT_RULES: AlertRules = {
  runawayMb: 4096,
  orphanMb: 1024,
  availableMb: 1024,
  commitRatio: 0.9,
  poolMb: 3072,
  poolGrowthMb: 500,
  pagedMb: 4096,
  pagedGrowthMb: 500,
  processes: 1000,
  diskWarnMb: 20_480,
  diskCriticalMb: 5120,
};

/** One fixed drive, with the free space that it lost over the last hour. */
export interface DiskInput extends DiskSpace {
  /** The free space that the drive lost over the window, in MB. It is 0 when the free space grew. */
  readonly droppedMb?: number | undefined;
  /** The length of the window, in minutes. */
  readonly windowMinutes?: number | undefined;
}

/**
 * This function gives the level of the free space of a drive: "critical", "warning", or `null` when the drive has
 * enough free space. On a small drive, the limits are at most 20% and 5% of its size, so a small drive does not always alert.
 */
export function diskLevel(disk: DiskSpace, rules: Pick<AlertRules, "diskWarnMb" | "diskCriticalMb"> = DEFAULT_ALERT_RULES): AlertSeverity | null {
  const resource = RESOURCES.get("disk");
  const rule = resource?.alert.rules({ ...DEFAULT_ALERT_RULES, ...rules }).find((each): each is LevelRule => each.type === "level");
  const [measurement] = resource?.measure.read(readingsOf({ memory: NO_MEMORY, processes: [], disks: [disk] })) ?? [];
  return rule === undefined || measurement === undefined ? null : levelOf(rule, measurement);
}

/** The data of one check. */
export interface AlertInput {
  readonly memory: SystemMemory;
  readonly processes: readonly ProcessInfo[];
  /** The owner of each process, and the kind of each owner. */
  readonly ownerOf: ReadonlyMap<number, string>;
  readonly kindOf: ReadonlyMap<string, OwnerKind>;
  readonly leases: readonly Lease[];
  /** The non-paged pool one hour ago, in MB, when the history has it. */
  readonly poolHourAgoMb?: number | undefined;
  /** The paged pool one hour ago, in MB, when the history has it. */
  readonly pagedHourAgoMb?: number | undefined;
  /** The load of the session. */
  readonly load?: SessionLoad | undefined;
  /** The fixed drives. */
  readonly disks?: readonly DiskInput[] | undefined;
}

const NO_MEMORY: SystemMemory = { totalMb: 0, availableMb: 0, commitMb: 0, commitLimitMb: 0, kernelPagedMb: 0, kernelNonpagedMb: 0 };
const NO_LOAD: SessionLoad = { processes: 0, userObjects: null, gdiObjects: null };
const HOUR_MS = 3_600_000;

/** This function gives the reads of one check for the measure parts of the kinds. */
function readingsOf(input: Pick<AlertInput, "memory" | "processes" | "load" | "disks">): Readings {
  return { at: 0, memory: input.memory, processes: input.processes, previous: [], disks: input.disks ?? [], load: input.load ?? NO_LOAD, processors: 0, pools: {}, granted: {} };
}

/**
 * This function gives the change of each instance from the history of a check. A kernel pool gets its growth over
 * one hour. A drive gets the loss of its free space over its window.
 */
function changesOf(input: AlertInput): Map<ResourceId, Change> {
  const changes = new Map<ResourceId, Change>();
  if (input.poolHourAgoMb !== undefined) changes.set("pool:nonpaged", { windowMs: HOUR_MS, usedGain: input.memory.kernelNonpagedMb - input.poolHourAgoMb });
  if (input.pagedHourAgoMb !== undefined) changes.set("pool:paged", { windowMs: HOUR_MS, usedGain: input.memory.kernelPagedMb - input.pagedHourAgoMb });
  for (const disk of input.disks ?? []) changes.set(`disk:${disk.mount}`, { windowMs: (disk.windowMinutes ?? 0) * 60_000, freeLoss: disk.droppedMb ?? 0 });
  return changes;
}

/** This function tells if an outlier rule examines a process with this owner kind. */
function examines(rule: OutlierRule, info: ProcessInfo, kind: OwnerKind, owners: Owners, pids: ReadonlySet<number>): boolean {
  if (rule.skip.includes(kind) || (rule.only !== undefined && !rule.only.includes(kind))) return false;
  if (rule.when === "unleased") return !owners.leaseOf.has(info.pid);
  if (rule.when === "orphaned") return info.ppid > 0 && !pids.has(info.ppid);
  return true;
}

/**
 * This function gives the conditions of one check, without their start time. First come the alerts on the processes,
 * at most one for each process. Then come the alerts on the instances, in the order of the kinds.
 */
export function detect(input: AlertInput, rules: AlertRules = DEFAULT_ALERT_RULES): Omit<Alert, "since">[] {
  const alerts: Omit<Alert, "since">[] = [];
  const readings = readingsOf(input);
  const owners: Owners = { ownerOf: input.ownerOf, kindOf: input.kindOf, leaseOf: leasesOf(input.processes, input.leases) };
  const changes = changesOf(input);
  const kinds = [...RESOURCES.values()].map((resource) => ({ resource, rules: resource.alert.rules(rules) }));

  // The rules on one process. Only the process subject has rules at this time (H20 adds the owners).
  const pids = new Set(input.processes.map((info) => info.pid));
  for (const info of input.processes) {
    const owner = input.ownerOf.get(info.pid) ?? "other";
    const kind = input.kindOf.get(owner) ?? "other";
    // The first rule that gives an alert stops the search, so a process gets at most one alert.
    kinds.some(({ resource, rules: each }) => {
      const amount = resource.attribute?.counter(info);
      if (amount === undefined) return false;
      for (const rule of each) {
        if (rule.type !== "outlier" || rule.subject !== "process" || !(amount > rule.above) || !examines(rule, info, kind, owners, pids)) continue;
        const text = rule.text({ process: info, owner, amount });
        alerts.push({ id: `${rule.alert}:${info.pid}`, kind: rule.alert, subject: text.subject, pid: info.pid, mb: text.mb, message: text.message });
        return true;
      }
      return false;
    });
  }

  // The rules on the instances. The first rule that gives an alert id wins, so a pool with two rules gives one alert.
  const ids = new Set<string>();
  for (const { resource, rules: each } of kinds) {
    const instanceRules = each.filter((rule) => rule.type !== "outlier");
    if (instanceRules.length === 0) continue;
    for (const measurement of resource.measure.read(readings)) {
      const change = changes.get(measurement.id);
      for (const rule of instanceRules) {
        if (rule.instance !== undefined && rule.instance !== measurement.id) continue;
        const id = rule.alertId?.(measurement.id) ?? measurement.id;
        if (ids.has(id)) continue;
        const level: Level | null = rule.type === "level" ? levelOf(rule, measurement) : grows(rule, change) ? "warning" : null;
        if (level === null) continue;
        ids.add(id);
        const text = rule.text({ measurement, change, readings });
        const severity = rule.severity === true ? { severity: level } : {};
        alerts.push({ id, kind: rule.alert, subject: text.subject, pid: null, mb: text.mb, ...severity, message: text.message });
      }
    }
  }
  return alerts;
}

