/**
 * The jobs that start many processes (H47). A burst of process starts can stop the start of a browser with 0xC0000142.
 * The memory and the desktop heap can have room at that time. Thus a spawn-heavy job and a browser test do not run at
 * the same time.
 *
 * - Measure: the job object of `headroom run` counts the processes of its job. The client reports the count every 30
 *   seconds and at the release. The lease keeps its peak starts in one minute over a window of 30 seconds.
 * - Learn: a job name is spawn-heavy when the peak of its past runs is above the limit. The rule is the rule of
 *   `--mem auto`: the 90th percentile of the last 20 runs, the runs of the same holder first.
 * - Promote: a job that is not spawn-heavy becomes spawn-heavy when its own peak goes above the limit.
 * - Admit: a spawn-heavy lease and a lease with the slot `browser` do not run at the same time, in each order.
 */

import type { Lease } from "./broker.ts";
import { countText } from "./starts.ts";

/** The slot of the browser tests. `headroom run` adds it by itself to a command that runs browser tests. */
export const BROWSER_SLOT = "browser";

/** The default limit of a spawn-heavy job: its peak starts in one minute. `headroom config spawn-heavy <n>` changes it. */
export const SPAWN_HEAVY_DEFAULT = 600;

/** The shortest window of a rate of starts. A shorter window counts as this long, so a short burst at the start of a job gives no false peak. */
export const SPAWN_WINDOW_MS = 30_000;

/** The count of past runs that the learned peak uses, as `--mem auto` does. */
export const SPAWN_RUNS = 20;

const MINUTE_MS = 60_000;

/**
 * Where the spawn class of a lease comes from: `history` (the past runs of the job name), `declared` (`--spawn-heavy`),
 * `opted-out` (`--no-spawn-heavy`) or `live` (the peak of the job itself went above the limit).
 */
export type SpawnSource = "history" | "declared" | "opted-out" | "live";

/** The spawn class of a lease (H47). */
export interface SpawnClass {
  /** True: the job starts many processes, so no browser test runs beside it. */
  readonly heavy: boolean;
  readonly source: SpawnSource;
  /**
   * The peak starts in one minute that decided the class. For `history`, it is the learned peak of the past runs. For
   * `live`, it is the peak of this run when it went above the limit. It is `null` without a measurement.
   */
  readonly perMinute: number | null;
  /** The count of past runs that the learned peak uses. */
  readonly runs: number;
}

/** This function gives the 90th percentile of a list, as `--mem auto` uses it. Up to 10 values, it is the highest value. It gives `null` for an empty list. */
export function percentile90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? null;
}

/**
 * This function gives the starts in one minute over the last window of the reports of a job: `[at, processes]`, the
 * oldest first. The window starts at the newest report that is 30 seconds or more older than the last report. A window
 * shorter than 30 seconds counts as 30 seconds. With fewer than two reports, the function gives `null`.
 */
export function windowRate(points: readonly (readonly [at: number, processes: number])[], windowMs: number = SPAWN_WINDOW_MS): number | null {
  const last = points.at(-1);
  if (last === undefined || points.length < 2) return null;
  const base = points.findLast((point) => point[0] <= last[0] - windowMs) ?? points[0];
  if (base === undefined || base === last) return null;
  return (Math.max(0, last[1] - base[1]) * MINUTE_MS) / Math.max(last[0] - base[0], windowMs);
}

/** This function gives the average starts in one minute of a run: its processes over its run time. A run shorter than 30 seconds counts as 30 seconds. */
export function averageRate(processes: number, ranMs: number): number {
  return (processes * MINUTE_MS) / Math.max(ranMs, SPAWN_WINDOW_MS);
}

/**
 * This function gives the spawn class of a new lease from the peaks of the past runs of its job. The job is spawn-heavy
 * when the learned peak is above the limit. `override` is the option of the run: true for `--spawn-heavy`, false for `--no-spawn-heavy`.
 */
export function learnSpawn(peaks: readonly number[], limit: number, override?: boolean): SpawnClass {
  const learned = percentile90(peaks);
  const perMinute = learned === null ? null : Math.round(learned);
  const runs = peaks.length;
  if (override === true) return { heavy: true, source: "declared", perMinute, runs };
  if (override === false) return { heavy: false, source: "opted-out", perMinute, runs };
  return { heavy: perMinute !== null && perMinute > limit, source: "history", perMinute, runs };
}

/**
 * This function gives the new spawn class of a lease after a new peak, or the class that it has. A job that is not
 * spawn-heavy becomes spawn-heavy when its peak goes above the limit. A job with `--no-spawn-heavy` stays normal.
 */
export function promote(spawn: SpawnClass | undefined, peak: number, limit: number): SpawnClass | undefined {
  if (spawn?.heavy === true || spawn?.source === "opted-out" || !(peak > limit)) return spawn;
  return { heavy: true, source: "live", perMinute: Math.round(peak), runs: spawn?.runs ?? 0 };
}

/** This function tells if a lease holds the slot `browser`. */
export function isBrowserLease(lease: Lease): boolean {
  return (lease.amounts[BROWSER_SLOT] ?? 0) > 0;
}

/** This function tells if a lease is spawn-heavy. */
export function isSpawnHeavy(lease: Lease): boolean {
  return lease.spawn?.heavy === true;
}

/** The end of each waiting reason of the spawn rule. The prefix of each reason is not "waits for memory", so the plugin hook does not count it. */
export const SPAWN_WAIT_END = "and browsers can fail to start beside it";

/** This function tells if a waiting reason comes from the spawn rule. */
export function isSpawnWait(reason: string | null): boolean {
  return reason?.endsWith(SPAWN_WAIT_END) === true;
}

/** This function gives the rate of a spawn class as text: "about 1,870 a minute in past runs". `own` adds where the rate comes from. */
function rateText(spawn: SpawnClass | undefined, own: boolean): string {
  if (spawn === undefined || spawn.source === "declared" || spawn.perMinute === null) return "declared with --spawn-heavy";
  const from = !own ? "" : spawn.source === "live" ? " in this run" : " in past runs";
  return `about ${countText(spawn.perMinute)} a minute${from}`;
}

/**
 * This function tells why a lease cannot run beside another lease under the spawn rule, or gives `null`. The other lease
 * is granted, or it waits before the lease in the queue. Two spawn-heavy leases can run together.
 */
export function spawnConflict(lease: Lease, other: Lease): string | null {
  if (lease.id === other.id) return null;
  const first = other.state === "waiting" ? "run first and end" : "end";
  if (isSpawnHeavy(lease) && isBrowserLease(other)) {
    return `waits for the browser tests of ${other.holder} (${other.job}) to ${first}: this job starts many processes (${rateText(lease.spawn, true)}), ${SPAWN_WAIT_END}`;
  }
  if (isBrowserLease(lease) && isSpawnHeavy(other)) {
    // A job whose name starts with "memory" gives a prefix that is not "waits for memory".
    const job = /^memory\b/i.test(other.job) ? `the job ${other.job}` : other.job;
    return `waits for ${job} of ${other.holder} to ${first}: it starts many processes (${rateText(other.spawn, false)}), ${SPAWN_WAIT_END}`;
  }
  return null;
}

/**
 * This function gives the class of a job as text for `headroom job`, for example "spawn-heavy (about 1,870 a minute in
 * past runs)" or "normal (no past runs)".
 */
export function spawnClassText(spawn: SpawnClass): string {
  const name = spawn.heavy ? "spawn-heavy" : "normal";
  if (spawn.source === "declared") return `${name} (--spawn-heavy)`;
  if (spawn.source === "opted-out") return `${name} (--no-spawn-heavy)`;
  if (spawn.perMinute === null) return `${name} (no past runs)`;
  return `${name} (${rateText(spawn, true)})`;
}

/**
 * This function gives the line of `headroom status` for the granted spawn-heavy leases, for example "Spawn-heavy now:
 * test-churn (server-stack), 1,870 a minute.". It gives `null` when no spawn-heavy lease runs.
 */
export function spawnLine(leases: readonly Lease[]): string | null {
  const heavy = leases.filter((lease) => lease.state === "granted" && isSpawnHeavy(lease));
  if (heavy.length === 0) return null;
  const each = heavy.map((lease) => {
    const rate = Math.max(lease.peakStartsPerMin ?? 0, lease.spawn?.perMinute ?? 0);
    return `${lease.job.slice(0, 40)} (${lease.holder})${rate > 0 ? `, ${countText(rate)} a minute` : ""}`;
  });
  return `Spawn-heavy now: ${each.join(" | ")}. Browser tests wait until ${heavy.length === 1 ? "it ends" : "they end"}.`;
}
