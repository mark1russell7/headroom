/**
 * The cap on the process starts of the computer at the grant of a lease, with a slow start after a boot (H197).
 *
 * All 5 bugchecks of 2026-11-15 to 2026-11-17 came when the 10-minute start rate of the computer was in its highest 8 %.
 * The memory, the commit, the nonpaged pool and the count of processes were at chance at the same times. A risk in
 * proportion to the square of the rate fits the 5 cases best. Thus the broker keeps the start rate under a cap:
 *
 * - The rate: the measured starts of the computer in the last 2 minutes (the window of `starts<N`), plus the expected rate
 *   of the new lease. Each lease of that window also adds the part of its expected rate that the window does not hold yet.
 * - The expected rate of a lease: the learned peak of the past runs of its job (H47). A job with no runs counts as the
 *   90th percentile of the real peaks of the first runs of other jobs. A job with `--no-spawn-heavy` counts its learned
 *   peak, or 0. A job with `--spawn-heavy` and no runs counts as the spawn-heavy limit.
 * - A light job, at most 1 % of the cap, does not wait: under the square law it adds at most 2 % to the risk.
 * - A lease that waits longer than the head wait of H178 (10 minutes) stops counting its own rate. It then starts when
 *   the computer and the new leases are under the cap, so no job waits for ever.
 * - A job that runs is not slowed or stopped. The cap does not change a setting of the system.
 *
 * The cap is data: a list of steps by the time since the boot. The first value comes from the start log (see
 * `START_CAP_DEFAULT`).
 */

import type { Lease } from "./broker.ts";
import { countText } from "./starts.ts";

/** One step of the cap: from `afterMs` after the boot, at most `perMinute` process starts in one minute. */
export interface StartCapStep {
  readonly afterMs: number;
  readonly perMinute: number;
}

/** The cap: steps by the time since the boot, the first at 0. An empty list turns the cap off. */
export type StartCap = readonly StartCapStep[];

const MINUTE_MS = 60_000;

/**
 * The default cap, from the start log of 2026-11-17 (1,050 grants, 5 hours) and the samples of the week before:
 *
 * - 3,500 a minute after the first hour. A replay of the gate on the grants of the log tried each cap in steps of 500.
 *   It gave the share of held leases and their waits. 3,500 is the lowest cap at which light and middle jobs waited under
 *   2 minutes at p99: 65 and 85 seconds. At that cap, 6.6 % of the grants waited. At 3,000, the p99 wait was 235 seconds.
 * - 1,822 a minute in the first hour after a boot: the median 2-minute rate of the log. Two of the 5 bugchecks came 27
 *   and 69 minutes after a boot. After a start of the daemon, the grants came back to their steady rate in 50 to 55 minutes.
 *
 * Derive the values again when the start log has 7 days.
 */
export const START_CAP_DEFAULT: StartCap = [
  { afterMs: 0, perMinute: 1822 },
  { afterMs: 60 * MINUTE_MS, perMinute: 3500 },
];

/** The most steps of a cap. */
export const START_CAP_STEPS_MAX = 12;

/** A light job adds at most this share of the cap, and does not wait for it. */
export const START_CAP_LIGHT_SHARE = 0.01;

/** The count of the last first runs that give the expected rate of a job with no runs. */
export const FIRST_RUNS = 200;

/**
 * This function gives the cap at a time after the boot: the value of the last step that started. It gives `null` for an
 * empty cap (off). A time before 0, from a clock that went back, gives the first step.
 */
export function capAt(cap: StartCap, sinceBootMs: number): number | null {
  let value: number | null = null;
  for (const step of cap) {
    if (value === null || step.afterMs <= sinceBootMs) value = step.perMinute;
    else break;
  }
  return value;
}

/**
 * This function checks a cap and gives it back. It refuses a list with more than 12 steps, or a first step that does not
 * start at 0. It refuses a time that is not a whole number of ms above the time of the step before. It also refuses a
 * value that is not a whole number above 0. An empty list is the cap off.
 */
export function checkStartCap(value: unknown): StartCap {
  if (!Array.isArray(value)) throw new RangeError("The start cap must be a list of steps, each with afterMs and perMinute");
  if (value.length > START_CAP_STEPS_MAX) throw new RangeError(`The start cap has at most ${START_CAP_STEPS_MAX} steps`);
  const steps: StartCapStep[] = [];
  for (const [index, item] of value.entries()) {
    const step = item as Partial<Record<string, unknown>> | null;
    const afterMs = step?.["afterMs"];
    const perMinute = step?.["perMinute"];
    if (typeof afterMs !== "number" || !Number.isInteger(afterMs) || afterMs < 0) throw new RangeError(`Step ${index + 1} of the start cap: afterMs must be a whole number of ms, 0 or more`);
    if (typeof perMinute !== "number" || !Number.isInteger(perMinute) || perMinute <= 0) throw new RangeError(`Step ${index + 1} of the start cap: perMinute must be a whole number above 0`);
    const last = steps.at(-1);
    if (last === undefined && afterMs !== 0) throw new RangeError("The first step of the start cap must start at 0 ms after the boot");
    if (last !== undefined && afterMs <= last.afterMs) throw new RangeError(`Step ${index + 1} of the start cap must start after step ${index}`);
    steps.push({ afterMs, perMinute });
  }
  return steps;
}

/**
 * This function reads a stored cap. A value that is not a correct cap gives the default, and no value gives the default.
 */
export function startCapOf(value: string | undefined): StartCap {
  if (value === undefined) return START_CAP_DEFAULT;
  try {
    return checkStartCap(JSON.parse(value));
  } catch {
    return START_CAP_DEFAULT;
  }
}

/**
 * This function gives the expected start rate of a lease in one minute: the learned peak of its job (H47). Without a
 * learned peak, a job with `--no-spawn-heavy` counts as 0, and a job with `--spawn-heavy` as the spawn-heavy limit. Each
 * other job counts as `prior`, the rate of a job with no runs.
 */
export function expectedRate(lease: Lease, prior: number, heavyLimit: number): number {
  const spawn = lease.spawn;
  const learned = spawn?.perMinute ?? null;
  if (learned !== null) return Math.max(0, learned);
  if (spawn?.source === "opted-out") return 0;
  if (spawn?.source === "declared") return heavyLimit;
  return prior;
}

/**
 * This function gives the part of the expected rates of the leases of the window that the measured rate does not hold
 * yet. A lease granted `age` ms ago adds its rate times `(window - age) / window`: at a steady rate, the window holds the
 * rest of it.
 */
export function unseenRate(granted: readonly Lease[], now: number, windowMs: number, rate: (lease: Lease) => number): number {
  let sum = 0;
  for (const lease of granted) {
    if (lease.grantedAt === null) continue;
    const age = Math.max(0, now - lease.grantedAt);
    if (age >= windowMs) continue;
    sum += (rate(lease) * (windowMs - age)) / windowMs;
  }
  return sum;
}

/** The facts of the cap at one time. */
export interface StartCapFacts {
  readonly now: number;
  /** The starts of the computer in one minute over the last window. `null` without a read: then no lease waits. */
  readonly machine: number | null;
  /** The time since the boot of the computer. */
  readonly sinceBootMs: number;
  readonly cap: StartCap;
  /** The expected rate of a job with no runs. */
  readonly prior: number;
  /** The limit of a spawn-heavy job (H47). */
  readonly heavyLimit: number;
  /** The window of the measured rate. */
  readonly windowMs: number;
  /** After this wait, a lease stops counting its own rate (the head wait of H178). */
  readonly progressMs: number;
}

/**
 * The cap in the status of the daemon. It has the steps, the time since the boot and the starts of the computer in one
 * minute over the window. It also has the count of the leases that wait for it, and the expected rate of a job with no runs.
 */
export interface StartCapStatus {
  readonly steps: StartCap;
  readonly sinceBootMs: number;
  readonly machine: number | null;
  readonly waiting: number;
  readonly prior: number;
}

/** The start of the reason of a lease that waits for the cap. */
export const START_CAP_WAIT_START = "waits for the start cap";

/** The parts of the sum of the cap at the grant of a lease, or `null` when the cap does not apply. */
export interface StartCapSum {
  readonly cap: number;
  readonly machine: number;
  readonly unseen: number;
  /** The own rate that the sum counts: 0 after the head wait. */
  readonly own: number;
  readonly total: number;
  /** True in a step before the last step. */
  readonly slowStart: boolean;
}

/**
 * This function gives the sum of the cap at the grant of a lease. It gives `null` when the cap is off, without a read of
 * the computer, and for a light job.
 */
export function startCapSum(lease: Lease, granted: readonly Lease[], facts: StartCapFacts): StartCapSum | null {
  const cap = capAt(facts.cap, facts.sinceBootMs);
  if (cap === null || facts.machine === null) return null;
  const rate = (each: Lease): number => expectedRate(each, facts.prior, facts.heavyLimit);
  const expected = rate(lease);
  if (expected <= cap * START_CAP_LIGHT_SHARE) return null;
  const own = facts.now - lease.requestedAt > facts.progressMs ? 0 : Math.min(expected, cap);
  const unseen = unseenRate(
    granted.filter((each) => each.id !== lease.id),
    facts.now,
    facts.windowMs,
    rate,
  );
  const last = facts.cap.at(-1);
  const slowStart = last !== undefined && facts.sinceBootMs < last.afterMs;
  return { cap, machine: facts.machine, unseen, own, total: facts.machine + unseen + own, slowStart };
}

/**
 * This function tells why a lease waits for the cap, or gives `null` when the sum stays at or under the cap. For
 * example: "waits for the start cap: the computer starts 3,100 a minute, new jobs add 400 and this job adds 600. The sum
 * of 4,100 is above the cap of 3,500."
 */
export function startCapConflict(lease: Lease, granted: readonly Lease[], facts: StartCapFacts): string | null {
  const sum = startCapSum(lease, granted, facts);
  if (sum === null || sum.total <= sum.cap) return null;
  const parts = [`the computer starts ${countText(Math.round(sum.machine))} a minute`];
  if (sum.unseen >= 1) parts.push(`new jobs add ${countText(Math.round(sum.unseen))}`);
  parts.push(sum.own > 0 ? `this job adds ${countText(Math.round(sum.own))}` : "this job waited past the head wait and counts as 0");
  const last = parts.pop() as string;
  const start = parts.length === 0 ? last : `${parts.join(", ")} and ${last}`;
  const slow = sum.slowStart ? ` in the slow start, ${Math.floor(facts.sinceBootMs / MINUTE_MS)} minutes after the boot` : "";
  return `${START_CAP_WAIT_START}: ${start}. The sum of ${countText(Math.round(sum.total))} is above the cap of ${countText(sum.cap)}${slow}.`;
}

/**
 * This function gives the line of `headroom status` for the cap, for example "Start cap: 3,500 a minute. The computer
 * starts 2,246 a minute. 2 leases wait for it.". It gives `null` when the cap is off.
 */
export function startCapLine(cap: StartCap, sinceBootMs: number, machine: number | null, waiting: number): string | null {
  const value = capAt(cap, sinceBootMs);
  if (value === null) return null;
  const last = cap.at(-1) as StartCapStep;
  const slow = sinceBootMs < last.afterMs ? ` in the slow start, ${countText(last.perMinute)} from ${Math.ceil(last.afterMs / MINUTE_MS)} minutes after the boot` : "";
  const now = machine === null ? " The computer has no read of its starts yet." : ` The computer starts ${countText(machine)} a minute.`;
  const wait = waiting === 0 ? "" : ` ${countText(waiting)} ${waiting === 1 ? "lease waits" : "leases wait"} for it.`;
  return `Start cap: ${countText(value)} a minute${slow}.${now}${wait}`;
}
