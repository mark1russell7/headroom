/**
 * The reboot budget and the planned drain (H34).
 *
 * The AMD display driver of this laptop leaks kernel memory with each new process. Only a reboot gives that memory back.
 * The budget tells when a reboot is due. It reads the levels of the kernel pools, their growth, their forecast (H32), a
 * Windows update that waits for a reboot, and the uptime.
 *
 * The drain prepares a planned reboot. From its time, new leases wait, and the running leases finish. headroom does not
 * reboot the computer and does not log off. Only Mark does these actions.
 *
 * The functions of this module are pure. The engine gives them the time and the reads.
 */

import type { Alert } from "./alerts.ts";
import type { Lease } from "./broker.ts";
import { localClock } from "./conditions.ts";
import { spanText, type Forecast } from "./forecast.ts";
import { gb } from "./units.ts";

/** The state of one registry key at a read: it exists, it does not exist, or the read failed. */
export type KeyState = "present" | "absent" | "unknown";

/** One registry key of `HKEY_LOCAL_MACHINE` whose presence tells that Windows waits for a reboot. */
export interface RebootKey {
  /** The name for a person, for example "Windows Update". */
  readonly name: string;
  /** The path under `HKEY_LOCAL_MACHINE`. */
  readonly path: string;
}

/** The keys that headroom reads. It only reads them: it does not write or remove a key. */
export const REBOOT_KEYS: readonly RebootKey[] = [
  { name: "Windows Update", path: "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired" },
  { name: "Component Based Servicing", path: "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending" },
];

/** The reboot state of Windows, from the keys of `REBOOT_KEYS`. */
export interface WindowsReboot {
  /** True when one key or more exists: an update waits for a reboot. */
  readonly pending: boolean;
  /** The names of the keys that exist, for example "Windows Update". */
  readonly sources: readonly string[];
}

/**
 * This function gives the reboot state of Windows from a probe of each key of `REBOOT_KEYS`. A probe that throws counts as
 * `unknown`. When no key gives an answer, the function gives `null`.
 */
export function windowsReboot(probe: (path: string) => KeyState): WindowsReboot | null {
  const states = REBOOT_KEYS.map((key) => {
    try {
      return { key, state: probe(key.path) };
    } catch {
      return { key, state: "unknown" as const };
    }
  });
  if (states.every((each) => each.state === "unknown")) return null;
  const sources = states.filter((each) => each.state === "present").map((each) => each.key.name);
  return { pending: sources.length > 0, sources };
}

/** The id of a kernel pool instance. */
export type PoolId = "pool:nonpaged" | "pool:paged";

/** The state of one kernel pool for the reboot budget, in MB. */
export interface PoolBudget {
  readonly id: PoolId;
  readonly usedMb: number;
  /** The alert level of the pool: 3 GB for the non-paged pool and 4 GB for the paged pool. */
  readonly alertMb: number;
  /** The growth over the last hour, or `null` with less than 50 minutes of history since the start or the last wake. */
  readonly growthMbPerHour: number | null;
  /** The growth in one hour that starts the alert of the pool: 500 MB. */
  readonly growthLimitMb: number;
  /** The forecast of the pool to its alert level (H32), or `null` with no clear trend. */
  readonly forecast: Forecast | null;
}

/**
 * The level of a recommendation. `overdue`: a pool is at or above its alert level. `soon`: a pool reaches it within the
 * horizon. `plan`: a pool grows fast with no forecast. `update`: only a Windows update waits. `none`: no reboot is due.
 */
export type RebootLevel = "overdue" | "soon" | "plan" | "update" | "none";

/** The recommendation of the reboot budget. */
export interface RebootAdvice {
  readonly level: RebootLevel;
  /** The latest time for the reboot, in ms since the epoch: the time of the nearest forecast. Other levels have `null`. */
  readonly by: number | null;
  /** The recommendation for a person, for example "Reboot within 6 hours: the non-paged pool reaches its alert level at 07:40." */
  readonly text: string;
}

/** The horizon of the level `soon`: a forecast further away gives no recommendation to reboot. */
export const REBOOT_HORIZON_MINUTES: number = 24 * 60;

/** The options of `rebootAdvice()`. */
export interface AdviceOptions {
  /** The horizon of the level `soon`, in minutes. The default is `REBOOT_HORIZON_MINUTES`. */
  readonly horizonMinutes?: number | undefined;
  /** This function writes a time for a person. The default writes the local clock: "07:40". */
  readonly clock?: ((at: number) => string) | undefined;
}

/** This function gives the name of a pool in a sentence. */
function poolName(id: PoolId): string {
  return id === "pool:nonpaged" ? "the non-paged pool" : "the paged pool";
}

/** This function gives the first letter of a text in upper case. */
function capital(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** This function gives the time to a reboot for a person: "50 minutes" below 2 hours, else whole hours: "6 hours". */
function withinText(minutes: number): string {
  if (minutes <= 1) return "1 minute";
  if (minutes < 120) return `${Math.round(minutes)} minutes`;
  return `${Math.floor(minutes / 60)} hours`;
}

/**
 * This function gives the recommendation of the reboot budget. The rules go in this order, and the first rule that applies
 * gives the level. A waiting Windows update adds one sentence to each level that is not `update`.
 *
 * - A pool at or above its alert level gives `overdue`.
 * - A forecast to the alert level within the horizon gives `soon`.
 * - A growth at or above the growth limit gives `plan`.
 * - A Windows update alone gives `update`. Else the level is `none`.
 */
export function rebootAdvice(pools: readonly PoolBudget[], windows: WindowsReboot | null, options: AdviceOptions = {}): RebootAdvice {
  const clock = options.clock ?? localClock;
  const horizon = options.horizonMinutes ?? REBOOT_HORIZON_MINUTES;
  const update = windows?.pending === true;
  const tail = update ? " A Windows update waits for a reboot too." : "";
  const over = pools.filter((pool) => pool.usedMb >= pool.alertMb);
  const first = over[0];
  if (first !== undefined) {
    const what =
      over.length === 1
        ? `${poolName(first.id)} is at ${gb(first.usedMb)}, above its alert level of ${gb(first.alertMb)}`
        : `${over.map((pool) => `${poolName(pool.id)} (${gb(pool.usedMb)})`).join(" and ")} are above their alert levels`;
    return { level: "overdue", by: null, text: `Reboot soon: ${what}.${tail}` };
  }
  const forecasts = pools.filter((pool) => pool.forecast !== null).sort((a, b) => (a.forecast?.minutes ?? 0) - (b.forecast?.minutes ?? 0));
  const nearest = forecasts[0];
  if (nearest?.forecast && nearest.forecast.minutes <= horizon) {
    const { minutes, at } = nearest.forecast;
    return { level: "soon", by: at, text: `Reboot within ${withinText(minutes)}: ${poolName(nearest.id)} reaches its alert level at ${clock(at)}.${tail}` };
  }
  const fast = pools.filter((pool) => (pool.growthMbPerHour ?? 0) >= pool.growthLimitMb).sort((a, b) => (b.growthMbPerHour ?? 0) - (a.growthMbPerHour ?? 0))[0];
  if (fast !== undefined) {
    return { level: "plan", by: null, text: `Plan a reboot: ${poolName(fast.id)} grows ${Math.round(fast.growthMbPerHour ?? 0)} MB an hour.${tail}` };
  }
  if (update) return { level: "update", by: null, text: "Reboot when it suits you: a Windows update waits for a reboot." };
  if (nearest?.forecast) {
    return { level: "none", by: null, text: `No reboot needed. ${capital(poolName(nearest.id))} reaches its alert level in ${spanText(nearest.forecast.minutes)}.` };
  }
  return { level: "none", by: null, text: "No reboot needed." };
}

/** A planned drain for a reboot (H34), as the settings keep it. The times are in ms since the epoch. */
export interface Drain {
  /** The time of the planned reboot. From this time, new leases wait. */
  readonly at: number;
  /** The end of the drain when no reboot came, or `null` for no end. */
  readonly until: number | null;
  /** The time of `headroom drain`. A start of the computer after it ends the drain, because the reboot came. */
  readonly setAt: number;
  /** The time when the drain started and the daemon wrote the resume plan, or `null` before the start. */
  readonly startedAt?: number | null | undefined;
  /** The time since when no lease runs in the drain, or `null`. The alert `drain:ready` starts at it. */
  readonly readyAt?: number | null | undefined;
}

/** The ids of the alerts of a drain. `drain:ended` is an event alert. */
export const DRAIN_ALERT = "drain";
export const DRAIN_READY_ALERT = "drain:ready";
export const DRAIN_ENDED_ALERT = "drain:ended";

/** This function reads a drain from the text of the settings. A text that is not a valid drain gives `null`. */
export function parseDrain(text: string | null | undefined): Drain | null {
  if (text === null || text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { at, until, setAt, startedAt, readyAt } = value as Record<string, unknown>;
    const time = (each: unknown): each is number => typeof each === "number" && Number.isFinite(each);
    const optional = (each: unknown): number | null => (time(each) ? each : null);
    if (!time(at) || !time(setAt) || !(until === null || until === undefined || time(until))) return null;
    return { at, until: optional(until), setAt, startedAt: optional(startedAt), readyAt: optional(readyAt) };
  } catch {
    return null;
  }
}

/** This function tells if a drain holds new leases at a time: after its start and before its end. */
export function isDrainActive(drain: Drain | null, now: number): drain is Drain {
  return drain !== null && now >= drain.at && (drain.until === null || now < drain.until);
}

/**
 * This function gives the waiting reason of a lease in a drain: "waits for the planned reboot at 02:30 (headroom drain)".
 * The reason does not start with "waits for memory", because the hook of the plugin counts only memory waits.
 */
export function drainReason(drain: Drain, clock: (at: number) => string = localClock): string {
  return `waits for the planned reboot at ${clock(drain.at)} (headroom drain)`;
}

/** This function tells why a lease waits for a drain, or gives `null`. A lease of `headroom run --during-drain` does not wait. */
export function drainWait(lease: Pick<Lease, "conditions">, drain: Drain | null, now: number, clock: (at: number) => string = localClock): string | null {
  if (!isDrainActive(drain, now) || lease.conditions?.duringDrain === true) return null;
  return drainReason(drain, clock);
}

/** One running job of a drain: the lease id, the job and its holder. */
export interface DrainJob {
  readonly id: string;
  readonly job: string;
  readonly holder: string;
}

/** A drain with its state at one time and its jobs. */
export interface DrainStatus extends Drain {
  /** `planned`: before its time. `active`: new leases wait. */
  readonly state: "planned" | "active";
  /** The granted leases: the jobs that still run. */
  readonly running: readonly DrainJob[];
  /** The count of waiting leases that the drain holds. A lease of `--during-drain` does not count. */
  readonly waiting: number;
}

/** This function gives the state of a drain at a time with the active leases, or `null` without a drain or after its end. */
export function drainStatus(drain: Drain | null, leases: readonly Lease[], now: number): DrainStatus | null {
  if (drain === null || (drain.until !== null && now >= drain.until)) return null;
  const running = leases.filter((lease) => lease.state === "granted").map((lease) => ({ id: lease.id, job: lease.job, holder: lease.holder }));
  const active = isDrainActive(drain, now);
  const waiting = active ? leases.filter((lease) => lease.state === "waiting" && lease.conditions?.duringDrain !== true).length : 0;
  return { ...drain, state: active ? "active" : "planned", running, waiting };
}

/** This function writes a count of jobs: "1 job", "2 jobs". */
function jobsText(count: number): string {
  return `${count} ${count === 1 ? "job" : "jobs"}`;
}

/**
 * This function gives the drain line of `headroom status`, or `null` without a drain. An example is "Drain for the reboot
 * at 02:30: 2 jobs still run."
 */
export function drainLine(drain: DrainStatus | null, clock: (at: number) => string = localClock): string | null {
  if (drain === null) return null;
  const when = clock(drain.at);
  const until = drain.until === null ? "" : ` The drain ends at ${clock(drain.until)} if no reboot comes.`;
  if (drain.state === "planned") return `Drain planned for the reboot at ${when}: from ${when}, new jobs wait.${until}`;
  const waits = drain.waiting === 0 ? "" : ` ${jobsText(drain.waiting)} ${drain.waiting === 1 ? "waits" : "wait"} for the reboot.`;
  const count = drain.running.length;
  const runs = count === 0 ? "no job runs, ready for the reboot" : `${jobsText(count)} still ${count === 1 ? "runs" : "run"}`;
  return `Drain for the reboot at ${when}: ${runs}.${waits}${until}`;
}

/**
 * This function gives the alerts of an active drain (kind `drain`). The alert `drain` names the running jobs and their
 * holders. The alert `drain:ready` starts when no job runs. The organizer reads the alerts at each sweep.
 */
export function drainAlerts(drain: DrainStatus | null, clock: (at: number) => string = localClock): Omit<Alert, "since">[] {
  if (drain === null || drain.state !== "active") return [];
  const when = clock(drain.at);
  const count = drain.running.length;
  const jobs = drain.running.map((each) => `${each.job.slice(0, 60)} (${each.holder})`).join(", ");
  const runs = count === 0 ? "No job runs." : `${jobsText(count)} still ${count === 1 ? "runs" : "run"}: ${jobs}.`;
  const base = { kind: "drain" as const, subject: "planned reboot", pid: null, mb: 0 };
  const alerts: Omit<Alert, "since">[] = [{ ...base, id: DRAIN_ALERT, message: `The drain for the planned reboot at ${when} started: new jobs wait. ${runs}` }];
  if (count === 0) {
    alerts.push({
      ...base,
      id: DRAIN_READY_ALERT,
      message: `Ready for the reboot: no job runs. New jobs wait for the reboot at ${when}. headroom does not reboot the computer: Mark does it.`,
    });
  }
  return alerts;
}

/**
 * This function gives the next time of a local clock "HH:MM" after a time, in ms since the epoch. It is the same day when
 * the clock comes later, else the next day. It throws a `RangeError` for a text that is not a clock.
 */
export function nextClock(text: string, after: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (match === null || hours > 23 || minutes > 59) throw new RangeError(`${text} is not a clock: give HH:MM, for example 02:30`);
  const date = new Date(after);
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() <= after) date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** The file of the resume plan (H13) and the time of its last write. */
export interface ResumePlanFile {
  readonly path: string;
  /** The time of the last write, in ms since the epoch. */
  readonly at: number;
}

/** The reboot budget at one time (H34): `Status.reboot` and `headroom reboot-plan`. */
export interface RebootBudget {
  readonly at: number;
  readonly advice: RebootAdvice;
  /** The non-paged pool, then the paged pool. */
  readonly pools: readonly PoolBudget[];
  /** The reboot state of Windows, or `null` on a platform with no registry or when the read failed. */
  readonly windows: WindowsReboot | null;
  /** The start of the computer, or `null` when the sampler does not give it. */
  readonly bootedAt: number | null;
  readonly uptimeMinutes: number | null;
  /** The planned drain, or `null` without a drain. */
  readonly drain: DrainStatus | null;
  /** The file of the resume plan, or `null` before its first write or without a file. */
  readonly resumePlan: ResumePlanFile | null;
}

/** The inputs of `rebootBudget()`. */
export interface BudgetInput {
  readonly at: number;
  readonly pools: readonly PoolBudget[];
  readonly windows: WindowsReboot | null;
  readonly bootedAt: number | null;
  readonly drain: DrainStatus | null;
  readonly resumePlan: ResumePlanFile | null;
  readonly clock?: ((at: number) => string) | undefined;
}

/** This function gives the reboot budget from its reads. */
export function rebootBudget(input: BudgetInput): RebootBudget {
  const { at, pools, windows, bootedAt, drain, resumePlan } = input;
  return {
    at,
    advice: rebootAdvice(pools, windows, { clock: input.clock }),
    pools,
    windows,
    bootedAt,
    uptimeMinutes: bootedAt === null ? null : Math.max(0, Math.round((at - bootedAt) / 60_000)),
    drain,
    resumePlan,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** This function writes a date and a local clock: "22 Oct 21:10". */
function dayText(at: number, clock: (at: number) => string): string {
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS[date.getMonth()] ?? ""} ${clock(at)}`;
}

/** This function writes one pool for `headroom reboot-plan`: "non-paged 4.6 GB (alert level 3.0 GB, +120 MB in the last hour)". */
function poolText(pool: PoolBudget): string {
  const parts = [`alert level ${gb(pool.alertMb)}`];
  if (pool.growthMbPerHour !== null) parts.push(`${pool.growthMbPerHour >= 0 ? "+" : ""}${Math.round(pool.growthMbPerHour)} MB in the last hour`);
  if (pool.forecast !== null) parts.push(`at its alert level in ${spanText(pool.forecast.minutes)}`);
  return `${pool.id === "pool:nonpaged" ? "non-paged" : "paged"} ${gb(pool.usedMb)} (${parts.join(", ")})`;
}

/** This function gives the lines of `headroom reboot-plan` for a person. */
export function rebootLines(budget: RebootBudget, clock: (at: number) => string = localClock): string[] {
  const lines = [`Reboot: ${budget.advice.text}`, `Kernel pools: ${budget.pools.map(poolText).join(", ")}.`];
  const windows = budget.windows;
  lines.push(
    windows === null
      ? "Windows: headroom cannot read the reboot state of Windows."
      : windows.pending
        ? `Windows: an update waits for a reboot (${windows.sources.join(", ")}).`
        : "Windows: no update waits for a reboot.",
  );
  if (budget.bootedAt !== null && budget.uptimeMinutes !== null) lines.push(`Uptime: ${spanText(budget.uptimeMinutes)}, since ${dayText(budget.bootedAt, clock)}.`);
  lines.push(budget.drain === null ? "Drain: none. `headroom drain --at 02:30` plans one." : `Drain: ${drainLine(budget.drain, clock) ?? ""}`);
  const plan = budget.resumePlan;
  lines.push(
    plan === null
      ? "Resume plan: none yet. `headroom resume-plan` writes it, and a drain writes it at its start."
      : `Resume plan: ${plan.path}, written ${spanText(Math.max(0, Math.round((budget.at - plan.at) / 60_000)))} ago (${dayText(plan.at, clock)}). A drain writes it again at its start.`,
  );
  return lines;
}
