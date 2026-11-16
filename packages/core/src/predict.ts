/**
 * The prediction of the memory and the run time of a job (H78), from the past runs that match the key of the job.
 *
 * Before H78, the name of a job was its only key: `--job` or the command text. In the 7 days before 2026-11-15, only
 * 50.5% of the leases had an earlier run of the same name with a peak. A lease of a new name asked 1024 MB, and the
 * median peak was 270 to 519 MB. From H78, the client sends a typed key (`JobKey`) with each request. The core matches
 * only the fields of the key: it parses no command. The prediction goes down a ladder of rungs and takes the first rung
 * with runs:
 *
 * - `job`: the same job text and repo, the runs of the holder first (the rule before H78)
 * - `key`: the same kind, repo, lockfile, filter and warm state
 * - `repo`: the same kind, repo, filter and warm state (the lockfile changed)
 * - `fit`: the same kind and warm state over each repo, a fit of the log of the peak on the log of the packages
 * - `kind`: the last runs of the same kind
 * - `none`: no run, so the client uses its default
 *
 * Each function of this file is pure. The reads come from the store in the daemon, and from a replay of the store in
 * `headroom report leases`. Thus the backtest and the daemon use the same rule.
 */

import { leastSquares, quantile, sd } from "@mark1russell7/rigor-statistics";

/** The kinds of a job. The client finds the kind from the command. The core only compares it. */
export const JOB_KINDS = ["install", "test", "typecheck", "build", "lint", "browser", "other"] as const;

/** The kind of a job, for example `test`. */
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * The typed key of a job (H78). The client makes it from the command and its folder, and sends it with the request.
 * A field that the client does not know is `null`.
 */
export interface JobKey {
  /** The kind of the command, for example `install` or `test`. */
  readonly kind: JobKind;
  /** The name of the repository, from the git top folder above the folder of the command. */
  readonly repo: string | null;
  /** The first 16 hex characters of the SHA-256 of the lockfile of the repository. */
  readonly lock: string | null;
  /** The package filter: the sorted `--filter` values, or the folder of the package relative to the repository. */
  readonly filter: string | null;
  /** True when `node_modules` exists next to the lockfile. */
  readonly warm: boolean | null;
  /** The count of the entries in the packages section of the lockfile. */
  readonly packages: number | null;
  /** The command text without absolute paths, temp names and hex ids. */
  readonly command: string;
}

/** The rungs of the ladder, in their order. */
export const RUNGS = ["job", "key", "repo", "fit", "kind", "none"] as const;

/** A rung of the ladder. */
export type Rung = (typeof RUNGS)[number];

/** The count of the last peaks at the rungs `job`, `key` and `repo`. */
export const PEAK_RUNS = 20;
/** The count of the last peaks at the rung `kind`. */
export const KIND_RUNS = 50;
/** The count of the last runs that the fit reads. */
export const FIT_RUNS = 500;
/** The fewest runs with a count of packages that the fit needs. */
export const FIT_MIN_RUNS = 10;

/** One past run for the fit: the count of packages of its key and its peak memory. */
export interface SizedPeak {
  readonly packages: number;
  readonly peakMb: number;
}

/**
 * The reads of the memory ladder. Each read gives the peaks in MB of the last runs, the newest first. The predictor
 * calls a read only when each rung before it has no run.
 */
export interface PeakReads {
  /** The runs of the same job text and repo by the holder. */
  own(): readonly number[];
  /** The runs of the same job text and repo. */
  job(): readonly number[];
  /** The runs of the same kind, repo, lockfile, filter and warm state. */
  key(): readonly number[];
  /** The runs of the same kind, repo, filter and warm state. */
  repo(): readonly number[];
  /** The runs of the same kind and warm state over each repo, with a count of packages. */
  sized(): readonly SizedPeak[];
  /** The runs of the same kind. */
  kind(): readonly number[];
}

/**
 * The rule that gives an amount from the peaks of a rung:
 * `quantile × factor + spread × sd + addMb`, rounded up to `stepMb`, and at least `floorMb`.
 */
export interface AmountRule {
  /** The quantile of the peaks, from 0 to 1. The method is `higher`, so the quantile is a peak of the list. */
  readonly quantile: number;
  /** The factor on the quantile. */
  readonly factor: number;
  /** The factor on the sample standard deviation of the peaks. One peak has a spread of 0. */
  readonly spread: number;
  /** The MB that the rule adds. */
  readonly addMb: number;
  /** The lowest amount in MB. */
  readonly floorMb: number;
  /** The step of the amount in MB. */
  readonly stepMb: number;
}

/**
 * The rule of `--mem auto` before H78: the 90th percentile and 25% more, rounded up to 64 MB, at least 256 MB.
 * The backtest of H78 compares each new rule with it.
 */
export const LEGACY_RULE: AmountRule = { quantile: 0.9, factor: 1.25, spread: 0, addMb: 0, floorMb: 256, stepMb: 64 };

/**
 * The rule of `--mem auto` from H78: the 90th percentile, 10% more and 128 MB more. The walk-forward replay of
 * `headroom report leases` chose it from its grid on the 7 days before 2026-11-16 (6932 leases). No rule of the grid
 * held both gates: at the over gate (the upper end of the 95% interval at most 5%), the lowest ratio was 2.06. Thus the
 * replay took the rule with the lowest ratio of the rules that held the over gate. It gave 4.3% over (4.8% at the upper
 * end) and a ratio of 2.06. `LEGACY_RULE` on the same ladder gave 5.5% over (6.0%) and 1.99. The pull request of H78
 * gives the table. A later replay with the keys of the new leases can choose again.
 */
export const PEAK_RULE: AmountRule = { quantile: 0.9, factor: 1.1, spread: 0, addMb: 128, floorMb: 256, stepMb: 64 };

/** The prediction of the memory of a job. */
export interface MemoryPrediction {
  /** The amount in MB, or `null` at the rung `none`. */
  readonly mb: number | null;
  /** The rung that gave the amount. */
  readonly rung: Rung;
  /** The count of the runs that gave the amount. */
  readonly runs: number;
  /** The highest peak of those runs in MB, or `null` at the rung `none`. */
  readonly peakMb: number | null;
}

/** This function rounds an amount up to the step of a rule, and gives at least its floor. */
function rounded(mb: number, rule: AmountRule): number {
  return Math.max(rule.floorMb, Math.ceil(mb / rule.stepMb) * rule.stepMb);
}

/** This function gives the amount of a rule for the peaks of a rung, or `null` for no peak. */
export function amountOf(peaks: readonly number[], rule: AmountRule = PEAK_RULE): number | null {
  if (peaks.length === 0) return null;
  const base = quantile(peaks, rule.quantile, "higher");
  const spread = peaks.length >= 2 && rule.spread !== 0 ? sd(peaks) : 0;
  return rounded(base * rule.factor + rule.spread * spread + rule.addMb, rule);
}

/** The result of a fit of the peaks of a kind on the count of packages. */
export interface PackagesFit {
  /** The amount in MB for the count of packages: the line of the fit plus the 90th percentile of the residuals. */
  readonly mb: number;
  /** The intercept and the slope of the log of the peak on the log of the packages. */
  readonly intercept: number;
  readonly slope: number;
  /** The count of the runs of the fit. */
  readonly runs: number;
}

/**
 * This function fits the log of the peak on the log of the count of packages, by least squares. It gives the amount
 * for `packages`: the line plus the 90th percentile of the residuals. The count of packages is held in the range of the
 * runs, so the fit does not extrapolate. It gives `null` with fewer than `FIT_MIN_RUNS` runs, or when the counts of
 * packages are all equal and the fit has no slope.
 */
export function fitPackages(runs: readonly SizedPeak[], packages: number, rule: AmountRule = PEAK_RULE): PackagesFit | null {
  const rows = runs.filter((run) => run.packages > 0 && run.peakMb > 0 && Number.isFinite(run.packages) && Number.isFinite(run.peakMb));
  if (rows.length < FIT_MIN_RUNS || !(packages > 0)) return null;
  const x = rows.map((run) => [Math.log(run.packages)]);
  const y = rows.map((run) => Math.log(run.peakMb));
  const fit = leastSquares(x, y);
  const [intercept, slope] = fit.coefficients;
  if (intercept === undefined || slope === undefined || !Number.isFinite(intercept) || !Number.isFinite(slope)) return null;
  const residuals = rows.map((run, at) => (y[at] ?? 0) - (intercept + slope * Math.log(run.packages)));
  const counts = rows.map((run) => run.packages);
  const held = Math.min(Math.max(packages, Math.min(...counts)), Math.max(...counts));
  const mb = Math.exp(intercept + slope * Math.log(held) + quantile(residuals, 0.9, "higher"));
  return { mb: rounded(mb, rule), intercept, slope, runs: rows.length };
}

/**
 * This function predicts the memory of a job (H78). It takes the first rung with runs. Without a key, only the rung
 * `job` can have runs, as before H78. The rungs `key` and `repo` need a repo, and the fit needs a count of packages.
 */
export function predictMemory(reads: PeakReads, key: JobKey | null | undefined, rule: AmountRule = PEAK_RULE): MemoryPrediction {
  const of = (rung: Rung, peaks: readonly number[]): MemoryPrediction | null => {
    const mb = amountOf(peaks, rule);
    return mb === null ? null : { mb, rung, runs: peaks.length, peakMb: Math.round(Math.max(...peaks)) };
  };
  const own = reads.own();
  const found = of("job", own.length > 0 ? own : reads.job());
  if (found !== null) return found;
  if (key !== null && key !== undefined) {
    const keyed = key.repo === null ? null : (of("key", reads.key()) ?? of("repo", reads.repo()));
    if (keyed !== null) return keyed;
    if (key.packages !== null && key.packages > 0) {
      const sized = reads.sized();
      const fit = fitPackages(sized, key.packages, rule);
      if (fit !== null) return { mb: fit.mb, rung: "fit", runs: fit.runs, peakMb: Math.round(Math.max(...sized.map((run) => run.peakMb))) };
    }
    const kind = of("kind", reads.kind());
    if (kind !== null) return kind;
  }
  return { mb: null, rung: "none", runs: 0, peakMb: null };
}

/** The sources of an expected run time, in their order (H178, H184, H78). */
export const RUN_SOURCES = ["own", "job", "key", "repo", "size", "all"] as const;

/** A source of an expected run time. */
export type RunSource = (typeof RUN_SOURCES)[number];

/** The reads of the run-time ladder. Each read gives the run times in ms of the last runs with an exit code, the newest first. */
export type RunReads = Readonly<Record<RunSource, () => readonly number[]>>;

/** The expected run time of a job, and the runs that give it (H178, H184, H78). */
export interface RunEstimate {
  /** The 90th percentile of the run times in ms, or `null` with no run. */
  readonly ms: number | null;
  /** The source of the runs, or `null` with no run. */
  readonly from: RunSource | null;
  /** The count of the runs. */
  readonly runs: number;
}

/**
 * This function gives the expected run time of a job: the 90th percentile of the runs of the first source with a run.
 * Without a key, the sources `key` and `repo` have no runs.
 */
export function predictRunMs(reads: RunReads): RunEstimate {
  for (const from of RUN_SOURCES) {
    const runs = reads[from]();
    if (runs.length > 0) return { ms: quantile(runs, 0.9, "higher"), from, runs: runs.length };
  }
  return { ms: null, from: null, runs: 0 };
}

/** This function tells if a value is a kind of a job. */
export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}
