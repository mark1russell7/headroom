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
 *   The message names the owners that wrote most in the last hour (H20).
 * - `ports`: few free dynamic TCP ports (H24). When none is free, new connections fail. The message names the owners
 *   with the most connections, and the count in TIME_WAIT.
 * - `service`: a shared service that does not answer for 2 checks in a row, or answers slowly for 3 checks (H27).
 *   Docker and the MCP servers are critical. headroom does not restart the service.
 * - `churn`: more than 600 process starts in one minute, as an average over 10 minutes (H29). Each new process leaks
 *   kernel memory in the AMD display driver. The message names the owners and the leased jobs with the most starts.
 * - `battery`: on battery, little time or charge left, or leased jobs that run on battery (H30). The message of the jobs
 *   alert names the owners that use the most power, as an estimate. Each battery alert ends when AC power returns.
 * - `cpu`: the cores in use stay above 85% of the processors for 5 minutes, or critical above 95% (H23). The message
 *   names the 3 owners with the most cores and their leased jobs. The alert ends after 2 minutes below the limit.
 * - `runaway` also covers a process tree with no lease that uses more than 4 cores for 10 minutes (H23).
 * - `forecast`: the fit of the history of an instance reaches a limit soon (H32). A drive reaches its critical level within
 *   24 hours, a kernel pool its alert level within 2 hours, or the commit charge 90% within 30 minutes. The message names
 *   the rate, the time and the owners that the model has.
 * - `stop`: an event, not a condition. Another process stopped the daemon or the clients of `headroom run`.
 *   An event alert stays active for some minutes.
 * - `drain`: a planned drain for a reboot (H34). The alert `drain` names the running jobs. The alert `drain:ready` tells
 *   that no job runs. The engine keeps them, not `detect()`.
 *
 * The alerts only report. headroom does not stop a process for an alert.
 *
 * The rules of each kind are in the alert part of its resource (`resources.ts`). `detect()` examines them in the
 * order of the kinds, and adds no text of its own.
 */

import type { Lease } from "./broker.ts";
import type { TrailPoint, TreeUse } from "./cpu.ts";
import type { Forecast } from "./forecast.ts";
import {
  grows,
  healthLevel,
  leasesOf,
  levelOf,
  RESOURCES,
  sustainedLevel,
  treeAbove,
  type Change,
  type Level,
  type LevelRule,
  type OutlierRule,
  type Owners,
  type Readings,
  type ResourceId,
} from "./resources.ts";
import { parentOf } from "./owners.ts";
import type { ServiceHealth } from "./services.ts";
import type { ProcessStarts } from "./starts.ts";
import type { BatteryRead, DiskSpace, OwnerKind, PowerMeters, ProcessInfo, SessionLoad, SystemMemory, TcpTable } from "./types.ts";
import type { OwnerCores, OwnerWrites } from "./counters.ts";

export { diskSize } from "./units.ts";

/** The kind of an alert. */
export type AlertKind =
  | "runaway" | "orphan" | "memory" | "commit" | "pool" | "desktop" | "disk" | "ports" | "service" | "churn" | "battery" | "cpu" | "forecast" | "stop" | "drain";

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
  /** More connections than this part of the dynamic TCP ports start a ports warning. The default is 0.8. */
  readonly portsWarnRatio: number;
  /** More connections than this part of the dynamic TCP ports start a critical ports alert. The default is 0.95. */
  readonly portsCriticalRatio: number;
  /** A service that is down for this count of checks in a row starts an alert (H27). The default is 2, one minute. */
  readonly serviceDownChecks: number;
  /** A service that is slow for this count of checks in a row starts a warning. The default is 3. */
  readonly serviceSlowChecks: number;
  /** More process starts than this in one minute, as an average over 10 minutes, start a churn warning (H29). The default is 600. */
  readonly churnPerMinute: number;
  /** On battery, fewer minutes left than this start a battery warning (H30). The default is 30. */
  readonly batteryWarnMinutes: number;
  /** On battery, fewer minutes left than this start a critical battery alert. The default is 10. */
  readonly batteryCriticalMinutes: number;
  /** On battery, a charge below this percent starts a critical battery alert. The default is 10. */
  readonly batteryCriticalPercent: number;
  /** Cores in use above this part of the processors start a CPU warning (H23). The default is 0.85. */
  readonly cpuWarnRatio: number;
  /** Cores in use above this part of the processors start a critical CPU alert. The default is 0.95. */
  readonly cpuCriticalRatio: number;
  /** The CPU level must stay above its limit for this time, in ms. The default is 300000, 5 minutes. */
  readonly cpuForMs: number;
  /** An active CPU alert ends after this time below its limit, in ms. The default is 120000, 2 minutes. */
  readonly cpuClearMs: number;
  /** A process tree with no lease above this count of cores is a runaway (H23). The default is 4. */
  readonly runawayCores: number;
  /** The tree must stay above `runawayCores` for this time, in ms. The default is 600000, 10 minutes. */
  readonly runawayCoresMs: number;
  /** A forecast of a drive at its critical level within this time, in ms, starts a forecast warning (H32). The default is 24 hours. */
  readonly forecastDiskMs: number;
  /** A forecast of a kernel pool at its alert level within this time, in ms, starts a forecast warning. The default is 2 hours. */
  readonly forecastPoolMs: number;
  /** A forecast of the commit charge at 90% of its limit within this time, in ms, starts a forecast warning. The default is 30 minutes. */
  readonly forecastCommitMs: number;
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
  portsWarnRatio: 0.8,
  portsCriticalRatio: 0.95,
  serviceDownChecks: 2,
  serviceSlowChecks: 3,
  churnPerMinute: 600,
  batteryWarnMinutes: 30,
  batteryCriticalMinutes: 10,
  batteryCriticalPercent: 10,
  cpuWarnRatio: 0.85,
  cpuCriticalRatio: 0.95,
  cpuForMs: 300_000,
  cpuClearMs: 120_000,
  runawayCores: 4,
  runawayCoresMs: 600_000,
  forecastDiskMs: 24 * 3_600_000,
  forecastPoolMs: 2 * 3_600_000,
  forecastCommitMs: 30 * 60_000,
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
  /** The owners that wrote most in the last hour (H20). A disk alert names the first 3 above 100 MB. */
  readonly writes?: readonly OwnerWrites[] | undefined;
  /** The TCP connections and the dynamic port range (H24). */
  readonly tcp?: TcpTable | undefined;
  /** The health of each service after the last round of checks (H27). */
  readonly services?: readonly ServiceHealth[] | undefined;
  /** The process starts of the computer, of each owner and of each leased job (H29). */
  readonly starts?: ProcessStarts | undefined;
  /** The battery (H30). The battery alerts need it. */
  readonly battery?: BatteryRead | undefined;
  /** The counter set "Energy Meter" (H30). The battery alert names the owners that use the most power. */
  readonly meters?: PowerMeters | undefined;
  /** The cores of each owner over the last minute. The power of an owner is an estimate from them (H30). */
  readonly cores?: readonly OwnerCores[] | undefined;
  /** The time of the check (H23). The rules with a duration need it. Without it, each trail ends at its last point. */
  readonly at?: number | undefined;
  /** The count of logical processors: the capacity of `cpu` (H23). Without it, the CPU has no capacity, and its level rule gives no alert. */
  readonly processors?: number | undefined;
  /** The active alerts before this check (H23). An active alert of a rule with a duration ends only after its clear time. */
  readonly active?: readonly Pick<Alert, "id" | "severity">[] | undefined;
  /** The trail of each instance (H23), for example the cores in use at each read of the last 11 minutes. */
  readonly trails?: ReadonlyMap<ResourceId, readonly TrailPoint[]> | undefined;
  /** The process trees with no lease and their cores (H23). */
  readonly trees?: readonly TreeUse[] | undefined;
  /** The cores of each granted lease over the last minute, by lease id (H23). */
  readonly leaseCores?: ReadonlyMap<string, number> | undefined;
  /** The forecasts of each instance, the nearest first (H32). The forecast rules read them. */
  readonly forecasts?: ReadonlyMap<ResourceId, readonly Forecast[]> | undefined;
}

const NO_MEMORY: SystemMemory = { totalMb: 0, availableMb: 0, commitMb: 0, commitLimitMb: 0, kernelPagedMb: 0, kernelNonpagedMb: 0 };
const NO_LOAD: SessionLoad = { processes: 0, userObjects: null, gdiObjects: null };
const HOUR_MS = 3_600_000;

/** This function gives the reads of one check for the measure parts of the kinds. */
function readingsOf(
  input: Pick<
    AlertInput,
    | "memory" | "processes" | "load" | "disks" | "writes" | "tcp" | "services" | "starts" | "battery" | "meters" | "cores" | "at" | "processors"
    | "trails" | "trees" | "leaseCores" | "forecasts"
  > & {
    readonly leases?: readonly Lease[] | undefined;
  },
): Readings {
  return {
    at: input.at ?? 0, memory: input.memory, processes: input.processes, previous: [], disks: input.disks ?? [], load: input.load ?? NO_LOAD,
    processors: input.processors ?? 0, pools: {}, granted: {}, writes: input.writes, tcp: input.tcp, services: input.services, starts: input.starts,
    battery: input.battery, meters: input.meters, cores: input.cores, leases: input.leases?.filter((lease) => lease.state === "granted"),
    trails: input.trails, trees: input.trees, leaseCores: input.leaseCores, forecasts: input.forecasts,
  };
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
  // The rate of the process starts is an average over the time that the reads cover (H29).
  if (input.starts !== undefined) changes.set("procs", { windowMs: input.starts.spanMs });
  return changes;
}

/**
 * This function tells if an outlier rule examines a process with this owner kind. A process is an orphan when its parent
 * ended, also when a new process has the ID of the parent (H29).
 */
function examines(rule: OutlierRule, info: ProcessInfo, kind: OwnerKind, owners: Owners, byPid: ReadonlyMap<number, ProcessInfo>): boolean {
  if (rule.skip.includes(kind) || (rule.only !== undefined && !rule.only.includes(kind))) return false;
  if (rule.when === "unleased") return !owners.leaseOf.has(info.pid);
  if (rule.when === "orphaned") return info.ppid > 0 && parentOf(info, byPid) === undefined;
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
  const byPid = new Map(input.processes.map((info) => [info.pid, info]));
  for (const info of input.processes) {
    const owner = input.ownerOf.get(info.pid) ?? "other";
    const kind = input.kindOf.get(owner) ?? "other";
    // The first rule that gives an alert stops the search, so a process gets at most one alert.
    kinds.some(({ resource, rules: each }) => {
      const amount = resource.attribute?.counter(info);
      if (amount === undefined) return false;
      for (const rule of each) {
        if (rule.type !== "outlier" || rule.subject !== "process" || !(amount > rule.above) || !examines(rule, info, kind, owners, byPid)) continue;
        const text = rule.text({ process: info, owner, amount });
        alerts.push({ id: `${rule.alert}:${info.pid}`, kind: rule.alert, subject: text.subject, pid: info.pid, mb: text.mb, message: text.message });
        return true;
      }
      return false;
    });
  }

  // The rules on the process trees with no lease (H23). The tree must stay above the amount, and an active alert ends
  // after its clear time.
  const activeLevel = new Map((input.active ?? []).map((alert) => [alert.id, alert.severity ?? "warning"] as const));
  const endOf = (trail: readonly TrailPoint[]): number => input.at ?? trail.at(-1)?.at ?? 0;
  for (const { rules: each } of kinds) {
    for (const rule of each) {
      if (rule.type !== "outlier" || rule.subject !== "tree") continue;
      for (const tree of input.trees ?? []) {
        const info = byPid.get(tree.pid);
        if (info === undefined) continue;
        const owner = input.ownerOf.get(info.pid) ?? "other";
        if (!examines(rule, info, input.kindOf.get(owner) ?? "other", owners, byPid)) continue;
        const id = rule.alertId?.(String(tree.pid)) ?? `${rule.alert}:${tree.pid}`;
        if (!treeAbove(rule, tree.trail, endOf(tree.trail), activeLevel.has(id))) continue;
        const text = rule.text({ process: info, owner, amount: tree.trail.at(-1)?.value ?? 0, processes: tree.processes });
        alerts.push({ id, kind: rule.alert, subject: text.subject, pid: info.pid, mb: text.mb, message: text.message });
      }
    }
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
        const trail = readings.trails?.get(measurement.id);
        const level: Level | null =
          rule.type === "level"
            ? (change?.windowMs ?? 0) >= (rule.minHistoryMs ?? 0)
              ? sustainedLevel(rule, measurement, trail, endOf(trail ?? []), activeLevel.get(id) ?? null)
              : null
            : rule.type === "health"
              ? healthLevel(rule, measurement)
              : rule.type === "check"
                ? rule.level({ measurement, change, readings, owners, active: activeLevel.get(id) ?? null })
                : grows(rule, change)
                  ? "warning"
                  : null;
        if (level === null) continue;
        ids.add(id);
        const text = rule.text({ measurement, change, readings, owners, level });
        const severity = rule.severity === true ? { severity: level } : {};
        alerts.push({ id, kind: rule.alert, subject: text.subject, pid: null, mb: text.mb, ...severity, message: text.message });
      }
    }
  }
  return alerts;
}

