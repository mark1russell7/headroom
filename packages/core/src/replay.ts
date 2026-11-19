/**
 * The walk-forward replay of the memory rule (H78). For each lease of a window, the replay gives the amount that a rule
 * asks for at the request. It uses only the runs that ended before the request. Then it compares the amount with the
 * peak of the lease. `headroom report leases` uses it to compare the rule of before H78 with the ladder, and to choose
 * the amount rule of the ladder.
 *
 * The replay is pure. It reads the leases of `keyedLeases`, and it uses `predictMemory`. The client gives the key of
 * each lease. It is the key of its row, or a key from the job text of a lease of an older client. The core does not
 * parse the job text.
 */

import { quantile, wilson } from "@mark1russell7/rigor-statistics";
import { FIT_RUNS, KIND_RUNS, PEAK_RUNS, predictMemory, type AmountRule, type JobKey, type JobKind, type Rung, type SizedPeak } from "./predict.ts";
import { PEAK_FLOOR_FACTOR, peakFloor, signatureText, type MeasuredRun } from "./peak-floor.ts";
import type { KeyedLease } from "./store.ts";

/** The gate of the share of the runs with a peak over their request. The upper end of its 95% Wilson interval must hold it. */
export const OVER_GATE = 0.05;
/** The gate of the sum of the requests over the sum of the peaks. */
export const RATIO_GATE = 1.5;

/** The options of a replay. */
export interface ReplayOptions {
  /** The amount rule. */
  readonly rule: AmountRule;
  /** True: the ladder of H78 with the key of each lease. False: the rule before H78, with the rung `job` only. */
  readonly ladder: boolean;
  /** The amount of a lease at the rung `none`, in MB. */
  readonly defaultMb: number;
  /** The start of the window: the replay gives a row for each lease with a peak that a request started at or after it. */
  readonly since: number;
  /** The key of a lease, or `null` for no key. */
  readonly keyOf: (lease: KeyedLease) => JobKey | null;
}

/** One lease of a replay: the amount of the rule at its request and its peak. */
export interface ReplayRow {
  readonly id: string;
  /** The kind of the key of the lease, or `null` with no key. */
  readonly kind: JobKind | null;
  readonly rung: Rung;
  readonly runs: number;
  readonly requestMb: number;
  readonly peakMb: number;
}

/** A past run in an index of the replay: its peak and the repo of its key. */
interface Run {
  readonly peakMb: number;
  readonly repo: string | null;
}

/** This function gives the last `limit` values of a list, the newest first. The lists of the replay keep the oldest first. */
function newest<T>(list: readonly T[] | undefined, limit: number): T[] {
  return list === undefined ? [] : list.slice(-limit).reverse();
}

/** This function adds a value to the list of a key of a map. */
function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** The text of the fields of a key that a rung matches. */
function scopeText(key: JobKey, scope: "key" | "repo"): string {
  return JSON.stringify([key.kind, key.repo, key.filter, key.warm, ...(scope === "key" ? [key.lock] : [])]);
}

/**
 * This function replays a rule over the leases (H78). The leases are in the order of their requests, as `keyedLeases`
 * gives them. Before each request of the window, the replay adds each run that ended before it to its indexes.
 */
export function replayLeases(leases: readonly KeyedLease[], options: ReplayOptions): ReplayRow[] {
  const keys = new Map<string, JobKey | null>();
  const keyOf = (lease: KeyedLease): JobKey | null => {
    if (!keys.has(lease.id)) keys.set(lease.id, options.keyOf(lease));
    return keys.get(lease.id) ?? null;
  };
  const ended = leases
    .filter((lease) => lease.peakMb !== null && lease.endedAt !== null)
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  const byJob = new Map<string, Run[]>();
  const byHolder = new Map<string, Run[]>();
  const byKey = new Map<string, number[]>();
  const byRepo = new Map<string, number[]>();
  const byKind = new Map<string, number[]>();
  const bySize = new Map<string, SizedPeak[]>();
  const add = (lease: KeyedLease): void => {
    const peakMb = lease.peakMb ?? 0;
    const key = keyOf(lease);
    const run = { peakMb, repo: key?.repo ?? null };
    push(byJob, lease.job, run);
    push(byHolder, JSON.stringify([lease.job, lease.holder]), run);
    if (key === null) return;
    push(byKind, key.kind, peakMb);
    if (key.repo !== null) {
      push(byKey, scopeText(key, "key"), peakMb);
      push(byRepo, scopeText(key, "repo"), peakMb);
    }
    if (key.packages !== null && key.packages > 0) push(bySize, JSON.stringify([key.kind, key.warm]), { packages: key.packages, peakMb });
  };
  const rows: ReplayRow[] = [];
  let next = 0;
  for (const lease of leases) {
    if (lease.requestedAt < options.since || lease.peakMb === null) continue;
    while (next < ended.length && (ended[next]?.endedAt ?? 0) < lease.requestedAt) add(ended[next++] as KeyedLease);
    const key = options.ladder ? keyOf(lease) : null;
    const repo = key?.repo ?? null;
    const ofRepo = (runs: readonly Run[] | undefined): number[] =>
      newest((runs ?? []).filter((run) => repo === null || run.repo === null || run.repo === repo), PEAK_RUNS).map((run) => run.peakMb);
    const prediction = predictMemory(
      {
        own: () => ofRepo(byHolder.get(JSON.stringify([lease.job, lease.holder]))),
        job: () => ofRepo(byJob.get(lease.job)),
        key: () => (key === null ? [] : newest(byKey.get(scopeText(key, "key")), PEAK_RUNS)),
        repo: () => (key === null ? [] : newest(byRepo.get(scopeText(key, "repo")), PEAK_RUNS)),
        sized: () => (key === null ? [] : newest(bySize.get(JSON.stringify([key.kind, key.warm])), FIT_RUNS)),
        kind: () => (key === null ? [] : newest(byKind.get(key.kind), KIND_RUNS)),
      },
      key,
      options.rule,
    );
    rows.push({
      id: lease.id,
      kind: keyOf(lease)?.kind ?? null,
      rung: prediction.rung,
      runs: prediction.runs,
      requestMb: prediction.mb ?? options.defaultMb,
      peakMb: lease.peakMb,
    });
  }
  return rows;
}

/** The measures of a set of leases with a request and a peak. */
export interface AmountMeasures {
  /** The count of the leases. */
  readonly leases: number;
  /** The share of the leases at the rung `none`: their request is the default. */
  readonly defaultShare: number;
  /** The share of the leases with a measured or fitted amount: the rungs `job`, `key`, `repo` and `fit`. */
  readonly measuredShare: number;
  /** The share of the leases at the rung `kind`. */
  readonly kindShare: number;
  /** The sum of the requests over the sum of the peaks. */
  readonly ratio: number;
  /** The share of the leases with a peak over their request. */
  readonly overShare: number;
  /** The upper end of the 95% Wilson interval of the over share. */
  readonly overHigh: number;
  /** The 90th percentile of the request over the peak of each lease. */
  readonly ratioP90: number;
}

/** The rungs of a measured or fitted amount. */
const MEASURED: ReadonlySet<Rung> = new Set<Rung>(["job", "key", "repo", "fit"]);

/** This function gives the measures of the rows of a replay, or `null` for no row. */
export function measureRows(rows: readonly ReplayRow[]): AmountMeasures | null {
  if (rows.length === 0) return null;
  const share = (test: (row: ReplayRow) => boolean): number => rows.filter(test).length / rows.length;
  const peaks = rows.reduce((sum, row) => sum + row.peakMb, 0);
  const requests = rows.reduce((sum, row) => sum + row.requestMb, 0);
  return {
    leases: rows.length,
    defaultShare: share((row) => row.rung === "none"),
    measuredShare: share((row) => MEASURED.has(row.rung)),
    kindShare: share((row) => row.rung === "kind"),
    ratio: peaks > 0 ? requests / peaks : Number.POSITIVE_INFINITY,
    overShare: share((row) => row.peakMb > row.requestMb),
    overHigh: wilson(rows.filter((row) => row.peakMb > row.requestMb).length, rows.length).high,
    ratioP90: quantile(
      rows.map((row) => row.requestMb / Math.max(1, row.peakMb)),
      0.9,
      "higher",
    ),
  };
}

/** This function tells if the measures hold the over gate of H78. The gate holds when the upper end of the 95% interval of the over share is at most 5%. */
export function holdsOver(measures: AmountMeasures): boolean {
  return measures.overHigh <= OVER_GATE;
}

/** This function tells if the measures hold both gates of H78: the over gate, and a ratio of at most 1.5. */
export function holdsGates(measures: AmountMeasures): boolean {
  return holdsOver(measures) && measures.ratio <= RATIO_GATE;
}

/** A rule of the grid and its measures. */
export interface RuleResult {
  readonly name: string;
  readonly rule: AmountRule;
  readonly measures: AmountMeasures;
}

/** The rule that a grid chose, and the gates that it holds. */
export interface ChosenRule extends RuleResult {
  /** `both`: it holds both gates. `over`: no rule holds both gates, and it holds the over gate. */
  readonly holds: "both" | "over";
}

/**
 * This function chooses a rule from the results of a grid: of the rules that hold both gates, the rule with the lowest
 * ratio. With no such rule, it chooses the rule with the lowest ratio of the rules that hold the over gate. The reason:
 * a run over its request risks the memory of each other job, and a high ratio only costs waits. With no rule that
 * holds the over gate, it gives `null`.
 */
export function chooseRule(results: readonly RuleResult[]): ChosenRule | null {
  const lowest = (list: readonly RuleResult[]): RuleResult | undefined =>
    [...list].sort((a, b) => a.measures.ratio - b.measures.ratio || a.measures.overShare - b.measures.overShare)[0];
  const both = lowest(results.filter((result) => holdsGates(result.measures)));
  if (both !== undefined) return { ...both, holds: "both" };
  const over = lowest(results.filter((result) => holdsOver(result.measures)));
  return over === undefined ? null : { ...over, holds: "over" };
}

/** One lease of the replay of the floor (H215): its amount, the floor at its request and its peak. */
export interface FloorRow {
  readonly id: string;
  readonly job: string;
  readonly holder: string;
  /** The memory of the lease in MB. */
  readonly memoryMb: number;
  /** The floor of its signature at its request in MB. */
  readonly floorMb: number;
  /** The peak of the lease in MB, or `null` with no peak. */
  readonly peakMb: number | null;
  /** True when the amount is the prediction of `--mem auto` at the request. */
  readonly auto: boolean;
  /** The reason of a lease that started below the floor (`--below-peak`), or `null`. */
  readonly reason: string | null;
}

/** The result of the replay of the floor over a window (H215). */
export interface FloorReplay {
  /** The count of the keyed leases of the window with a memory amount. */
  readonly leases: number;
  /** The count of those leases with a floor at the request: an earlier run of the same command has a peak. */
  readonly withFloor: number;
  /** The leases with a stated amount below the floor. The rule refuses them. */
  readonly refused: readonly FloorRow[];
  /** The leases of `--mem auto` below the floor. The rule raises their amount to the floor. */
  readonly raised: readonly FloorRow[];
  /** The leases that started below the floor with a reason (`--below-peak`). */
  readonly below: readonly FloorRow[];
}

/**
 * This function replays the floor of H215 over the leases of a window. The leases are in the order of their requests, as
 * `keyedLeases` gives them. For each keyed lease with a memory amount, the floor comes from the last run of its signature
 * that ended before its request. A lease is `auto` when its amount is the prediction of the ladder at its request. The
 * store does not keep the option of the run, so this is the closest read.
 */
export function replayFloor(leases: readonly KeyedLease[], since: number, factor: number = PEAK_FLOOR_FACTOR): FloorReplay {
  const ended = leases.filter((lease) => lease.peakMb !== null && lease.endedAt !== null && lease.keyed !== null).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  const last = new Map<string, MeasuredRun>();
  let next = 0;
  let count = 0;
  let withFloor = 0;
  const refused: FloorRow[] = [];
  const raised: FloorRow[] = [];
  const below: FloorRow[] = [];
  for (const lease of leases) {
    while (next < ended.length && (ended[next]?.endedAt ?? 0) < lease.requestedAt) {
      const run = ended[next++] as KeyedLease;
      if (run.keyed === null) continue;
      last.set(signatureText(run.keyed.key), { id: run.id, job: run.job, holder: run.holder, peakMb: run.peakMb ?? 0, endedAt: run.endedAt ?? 0 });
    }
    if (lease.requestedAt < since || lease.keyed === null || lease.memoryMb === null) continue;
    count += 1;
    const floor = peakFloor(last.get(signatureText(lease.keyed.key)) ?? null, factor);
    if (floor === null) continue;
    withFloor += 1;
    const row: FloorRow = {
      id: lease.id,
      job: lease.job,
      holder: lease.holder,
      memoryMb: lease.memoryMb,
      floorMb: floor.floorMb,
      peakMb: lease.peakMb,
      auto: lease.keyed.predictedMb !== null && lease.keyed.predictedMb === lease.memoryMb,
      reason: lease.keyed.belowPeak,
    };
    if (lease.keyed.belowPeak !== null) below.push(row);
    else if (lease.memoryMb < floor.floorMb) (row.auto ? raised : refused).push(row);
  }
  return { leases: count, withFloor, refused, raised, below };
}
