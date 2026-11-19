/**
 * `headroom report leases [--days 7] [--json]` (H78): how well the leases ask for the memory that their jobs use.
 *
 * The report opens the store read-only in the CLI process. Thus it does not need the daemon, and it does not write.
 * It gives four measures:
 *
 * - the share of the leases with a measured or fitted amount
 * - the sum of the requests over the sum of the peaks
 * - the share of the leases with a peak over their request
 * - the 90th percentile of the wait of the install leases
 *
 * It gives them for the leases as they ran, and for a walk-forward replay. The replay uses the rule of before H78 (the
 * base), and the ladder of H78 over a grid of amount rules.
 *
 * A lease of an older client has no key. For the report only, the kind of such a lease comes from its job text, with the
 * mapper of the client (`kindOf`). Its other key fields are unknown, so the rungs `key`, `repo` and `fit` need the keys
 * of the leases from H78 on.
 */

import { DatabaseSync } from "node:sqlite";
import {
  chooseRule,
  holdsGates,
  holdsOver,
  JOB_KINDS,
  RATIO_GATE,
  keyedLeases,
  LEGACY_RULE,
  measureRows,
  PEAK_RULE,
  replayFloor,
  replayLeases,
  RUNGS,
  type AmountMeasures,
  type AmountRule,
  type FloorReplay,
  type FloorRow,
  type JobKey,
  type JobKind,
  type KeyedLease,
  type ReplayRow,
} from "@headroom/core";
import { quantile } from "@mark1russell7/rigor-statistics";
import { filterOf, kindOf, normalizeCommand } from "./job-key.ts";

/** The amount of `--mem auto` at the rung `none`, in MB. The CLI uses the same value. */
export const AUTO_DEFAULT_MB = 1024;

/** The measures of the leases as they ran. */
export interface RanMeasures {
  /** The count of the leases that a request started in the window. */
  readonly leases: number;
  /** The count of the leases with a memory request and a peak. The ratio and the over share count only them. */
  readonly measured: number;
  /** The share of those leases that asked the default of 1024 MB. */
  readonly defaultShare: number | null;
  readonly ratio: number | null;
  readonly overShare: number | null;
  /** The 90th percentile of the wait from the request to the grant, in minutes, of the leases with a grant. */
  readonly waitP90Min: number | null;
  /** The share of the leases with a key (a client from H78 on). */
  readonly keyedShare: number;
  /** The share of the keyed leases with a measured or fitted amount at the request, or `null` with no keyed lease. */
  readonly keyedMeasuredShare: number | null;
}

/** The measures of a replay. */
export interface ReplaySide {
  readonly name: string;
  readonly rule: AmountRule;
  readonly ladder: boolean;
  readonly measures: AmountMeasures | null;
  /** The gates that the rule holds: both, the over gate only, the ratio gate only, or none. */
  readonly holds: "both" | "over" | "ratio" | "none";
}

/** The data of `headroom report leases`. */
export interface LeaseReport {
  readonly days: number;
  readonly since: number;
  readonly until: number;
  readonly ran: { readonly all: RanMeasures; readonly byKind: Readonly<Record<string, RanMeasures>> };
  /** The rule of before H78: the rung `job` and the 90th percentile and 25% more. */
  readonly base: ReplaySide;
  /** The ladder of H78 with the rule of `PEAK_RULE`. */
  readonly current: ReplaySide;
  /**
   * The ladder with the rule of the grid that the gates chose: of the rules that hold both gates, the lowest ratio. With no
   * such rule, the lowest ratio of the rules that hold the over gate. `null` when no rule holds the over gate.
   */
  readonly chosen: ReplaySide | null;
  /** The measures of the current rule by rung and by kind. */
  readonly byRung: Readonly<Record<string, AmountMeasures>>;
  readonly byKind: Readonly<Record<string, AmountMeasures>>;
  /** Each rule of the grid on the ladder. */
  readonly grid: readonly ReplaySide[];
  /**
   * The walk-forward replay of the floor of H215 over the window. It has the leases with a stated amount below the floor,
   * and the leases that started below the floor with a reason. A report of an older
   * version has none.
   */
  readonly floor?: FloorReplay | undefined;
}

/** This function gives the name of an amount rule, for example `p90×1.2+64MB floor128`. */
export function ruleName(rule: AmountRule): string {
  const base = rule.quantile === 1 ? "max" : `p${Math.round(rule.quantile * 100)}`;
  const factor = rule.factor === 1 ? "" : `×${rule.factor}`;
  const spread = rule.spread === 0 ? "" : `+${rule.spread}sd`;
  const add = rule.addMb === 0 ? "" : `+${rule.addMb}MB`;
  const floor = rule.floorMb === LEGACY_RULE.floorMb ? "" : ` floor${rule.floorMb}`;
  return `${base}${factor}${spread}${add}${floor}`;
}

/**
 * The grid of amount rules of the replay. It has quantiles with factors, and the 90th percentile with a spread term,
 * with added MB and with a lower floor. Each rule rounds up to 64 MB.
 */
export const RULE_GRID: readonly AmountRule[] = [
  ...[0.5, 0.75, 0.9, 1].flatMap((quantile) => [1, 1.1, 1.25, 1.5].map((factor) => ({ ...LEGACY_RULE, quantile, factor }))),
  ...[0.5, 1, 1.5, 2].map((spread) => ({ ...LEGACY_RULE, factor: 1, spread })),
  ...[0.5, 1].map((spread) => ({ ...LEGACY_RULE, factor: 1.1, spread })),
  ...[1, 1.1, 1.2, 1.25].flatMap((factor) => [32, 64, 96, 128].map((addMb) => ({ ...LEGACY_RULE, factor, addMb }))),
  ...[1.1, 1.2, 1.25].flatMap((factor) => [0, 64, 96].map((addMb) => ({ ...LEGACY_RULE, factor, addMb, floorMb: 128 }))),
];

/** This function gives the key of a lease for the replay. It is the key of its row, or a key from the job text of a lease of an older client. */
export function replayKey(lease: KeyedLease): JobKey {
  return (
    lease.keyed?.key ?? { kind: kindOf(lease.job), repo: null, lock: null, filter: filterOf(lease.job), warm: null, packages: null, command: normalizeCommand(lease.job) }
  );
}

/** This function gives the measures of the leases as they ran. */
export function ranMeasures(leases: readonly KeyedLease[]): RanMeasures {
  const measured = leases.filter((lease) => lease.memoryMb !== null && lease.peakMb !== null);
  const share = (list: readonly KeyedLease[], test: (lease: KeyedLease) => boolean): number | null => (list.length === 0 ? null : list.filter(test).length / list.length);
  const peaks = measured.reduce((sum, lease) => sum + (lease.peakMb ?? 0), 0);
  const requests = measured.reduce((sum, lease) => sum + (lease.memoryMb ?? 0), 0);
  const waits = leases.filter((lease) => lease.grantedAt !== null).map((lease) => ((lease.grantedAt ?? 0) - lease.requestedAt) / 60_000);
  const keyed = leases.filter((lease) => lease.keyed !== null);
  return {
    leases: leases.length,
    measured: measured.length,
    defaultShare: share(measured, (lease) => lease.memoryMb === AUTO_DEFAULT_MB),
    ratio: peaks > 0 ? requests / peaks : null,
    overShare: share(measured, (lease) => (lease.peakMb ?? 0) > (lease.memoryMb ?? 0)),
    waitP90Min: waits.length === 0 ? null : quantile(waits, 0.9, "higher"),
    keyedShare: leases.length === 0 ? 0 : keyed.length / leases.length,
    keyedMeasuredShare: share(keyed, (lease) => ["job", "key", "repo", "fit"].includes(lease.keyed?.rung ?? "none")),
  };
}

/** This function groups a list by a key. */
function groupBy<T>(list: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of list) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

/**
 * This function makes the report of the leases from the store (H78). `leases` holds each lease of the store, so the
 * replay sees the runs before the window. The window is the `days` before `until`.
 */
export function leaseReport(leases: readonly KeyedLease[], days: number, until: number): LeaseReport {
  const since = until - days * 86_400_000;
  const window = leases.filter((lease) => lease.requestedAt >= since && lease.requestedAt <= until);
  const kindOfLease = (lease: KeyedLease): JobKind => replayKey(lease).kind;
  const byKindRan = groupBy(window, kindOfLease);
  // The replay counts the leases with a memory request and a peak, as the measures of the leases as they ran.
  const counted = new Set(window.filter((lease) => lease.memoryMb !== null && lease.peakMb !== null).map((lease) => lease.id));
  const history = leases.filter((lease) => lease.requestedAt <= until);
  const replay = (name: string, rule: AmountRule, ladder: boolean): { side: ReplaySide; rows: ReplayRow[] } => {
    const rows = replayLeases(history, { rule, ladder, defaultMb: AUTO_DEFAULT_MB, since, keyOf: replayKey }).filter((row) => counted.has(row.id));
    const measures = measureRows(rows);
    const holds =
      measures === null ? "none" : holdsGates(measures) ? "both" : holdsOver(measures) ? "over" : measures.ratio <= RATIO_GATE ? "ratio" : "none";
    return { side: { name, rule, ladder, measures, holds }, rows };
  };
  const base = replay(`base: rung job, ${ruleName(LEGACY_RULE)}`, LEGACY_RULE, false);
  const current = replay(`ladder, ${ruleName(PEAK_RULE)} (PEAK_RULE)`, PEAK_RULE, true);
  const grid = RULE_GRID.map((rule) => replay(`ladder, ${ruleName(rule)}`, rule, true).side);
  const picked = chooseRule(grid.flatMap((side) => (side.measures === null ? [] : [{ name: side.name, rule: side.rule, measures: side.measures }])));
  const measuresBy = (rows: readonly ReplayRow[], keyOf: (row: ReplayRow) => string, order: readonly string[]): Record<string, AmountMeasures> => {
    const groups = groupBy(rows, keyOf);
    return Object.fromEntries(order.flatMap((key) => {
      const measures = measureRows(groups.get(key) ?? []);
      return measures === null ? [] : [[key, measures]];
    }));
  };
  return {
    days,
    since,
    until,
    ran: {
      all: ranMeasures(window),
      byKind: Object.fromEntries(JOB_KINDS.flatMap((kind) => (byKindRan.has(kind) ? [[kind, ranMeasures(byKindRan.get(kind) ?? [])]] : []))),
    },
    base: base.side,
    current: current.side,
    chosen: picked === null ? null : (grid.find((side) => side.name === picked.name) ?? null),
    byRung: measuresBy(current.rows, (row) => row.rung, RUNGS),
    byKind: measuresBy(current.rows, (row) => row.kind ?? "other", JOB_KINDS),
    grid,
    floor: replayFloor(history, since),
  };
}

/** This function reads the report from a store file. It opens the file read-only. */
export function readLeaseReport(path: string, days: number, until: number): LeaseReport {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return leaseReport(keyedLeases(db, 0), days, until);
  } finally {
    db.close();
  }
}

/** This function gives a share as a percent with one decimal, or `no read`. */
function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "no read" : `${(value * 100).toFixed(1)}%`;
}

/** This function gives a ratio with two decimals, or `no read`. */
function times(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "no read" : `${value.toFixed(2)}×`;
}

/** This function gives minutes with two decimals, or `no read`. */
function minutes(value: number | null | undefined): string {
  return value === null || value === undefined ? "no read" : `${value.toFixed(2)} min`;
}

/** This function gives the rows of a table with columns of one width each. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((cell, at) => Math.max(cell.length, ...rows.map((row) => (row[at] ?? "").length)));
  const line = (row: readonly string[]): string => `  ${row.map((cell, at) => (at === 0 ? cell.padEnd(widths[at] ?? 0) : cell.padStart(widths[at] ?? 0))).join("  ")}`.trimEnd();
  return [line(header), ...rows.map(line)];
}

/** This function gives the cells of the measures of a replay. */
function measureCells(measures: AmountMeasures | null): string[] {
  return measures === null
    ? ["0", "no read", "no read", "no read", "no read", "no read", "no read"]
    : [
        String(measures.leases),
        percent(measures.defaultShare),
        percent(measures.measuredShare),
        percent(measures.kindShare),
        times(measures.ratio),
        percent(measures.overShare),
        percent(measures.overHigh),
      ];
}

/** The header of the measures of a replay. */
const MEASURE_HEADER = ["leases", "default", "measured", "kind", "request/peak", "over", "over 95%"] as const;

/** The text of the gates that a rule holds. */
const GATE_WORDS = { both: "both", over: "over only", ratio: "ratio only", none: "none" } as const;

/** This function gives the text of the report. */
export function leaseReportLines(report: LeaseReport): string[] {
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const all = report.ran.all;
  const lines = [
    `headroom report leases: the ${report.days} ${report.days === 1 ? "day" : "days"} from ${day(report.since)} to ${day(report.until)} UTC, ${all.leases} ${all.leases === 1 ? "lease" : "leases"}, ${all.measured} with a memory request and a peak, ${percent(all.keyedShare)} with a key.`,
    "",
    "The leases as they ran (a lease of before H78 has no key, so its kind comes from its job text):",
    ...table(
      ["kind", "leases", "measured", "asked 1024", "request/peak", "over", "wait p90", "keyed", "keyed: measured"],
      [["all", all] as const, ...Object.entries(report.ran.byKind)].map(([kind, ran]) => [
        kind,
        String(ran.leases),
        String(ran.measured),
        percent(ran.defaultShare),
        times(ran.ratio),
        percent(ran.overShare),
        minutes(ran.waitP90Min),
        percent(ran.keyedShare),
        percent(ran.keyedMeasuredShare),
      ]),
    ),
    "",
    "Walk-forward replay: each request sees only the runs that ended before it. Measured or fitted: the rungs job, key, repo and fit.",
    "The gates: the upper end of the 95% Wilson interval of the over share is at most 5% (over 95%), and the request/peak sum is at most 1.5.",
    "The install wait of a replay is no read: the replay does not run the queue.",
    ...table(
      ["rule", ...MEASURE_HEADER, "gates"],
      [report.base, report.current, ...(report.chosen === null ? [] : [{ ...report.chosen, name: `chosen: ${report.chosen.name}` }])].map((side) => [
        side.name,
        ...measureCells(side.measures),
        GATE_WORDS[side.holds],
      ]),
    ),
    `  install wait p90 as the leases ran: ${minutes(report.ran.byKind["install"]?.waitP90Min)}`,
    "",
    "The current rule by rung:",
    ...table(
      ["rung", ...MEASURE_HEADER],
      Object.entries(report.byRung).map(([rung, measures]) => [rung, ...measureCells(measures)]),
    ),
    "",
    "The current rule by kind:",
    ...table(
      ["kind", ...MEASURE_HEADER],
      Object.entries(report.byKind).map(([kind, measures]) => [kind, ...measureCells(measures)]),
    ),
    "",
    "The grid of amount rules on the ladder:",
    ...table(
      ["rule", ...MEASURE_HEADER, "gates"],
      report.grid.map((side) => [side.name, ...measureCells(side.measures), GATE_WORDS[side.holds]]),
    ),
    report.chosen === null
      ? "  No rule of the grid holds the over gate."
      : report.chosen.holds === "both"
        ? `  Of the rules that hold both gates, ${report.chosen.name} has the lowest request/peak sum.`
        : `  No rule of the grid holds both gates. Of the rules that hold the over gate, ${report.chosen.name} has the lowest request/peak sum.`,
    ...(report.floor === undefined ? [] : floorLines(report.floor)),
  ];
  return lines;
}

/** The most rows of each list of the floor section. */
const FLOOR_ROWS = 10;

/** This function gives the cells of a row of the floor section. */
function floorCells(row: FloorRow): string[] {
  const peak = row.peakMb === null ? "no read" : String(Math.round(row.peakMb));
  return [`${row.job.slice(0, 60)} (${row.holder.slice(0, 20)})`, String(Math.round(row.memoryMb)), String(row.floorMb), peak, times(row.peakMb === null ? null : row.peakMb / row.memoryMb)];
}

/**
 * This function gives the floor section of the report (H215). The ratio of a lease is its peak over its amount. A ratio
 * above 1 is a lease that used more than it held.
 */
export function floorLines(floor: FloorReplay): string[] {
  const ratios = floor.refused.flatMap((row) => (row.peakMb === null ? [] : [row.peakMb / row.memoryMb]));
  const over = ratios.filter((ratio) => ratio > 1).length;
  const median = ratios.length === 0 ? null : quantile(ratios, 0.5);
  const header = ["job (holder)", "amount MB", "floor MB", "peak MB", "peak/amount"];
  const list = (rows: readonly FloorRow[]): string[] =>
    rows.length === 0 ? [] : [...table(header, rows.slice(-FLOOR_ROWS).map(floorCells)), ...(rows.length > FLOOR_ROWS ? [`  (the last ${FLOOR_ROWS} of ${rows.length})`] : [])];
  return [
    "",
    "The floor of a command (H215): the peak of its last run times 1.1. A stated amount below the floor gets a refusal.",
    `  ${floor.leases} keyed ${floor.leases === 1 ? "lease" : "leases"} with a memory amount, ${floor.withFloor} with a floor at the request.`,
    `  The rule refuses ${floor.refused.length}. Of those with a peak, ${over} of ${ratios.length} used more than the amount (median peak/amount ${times(median)}).`,
    ...list(floor.refused),
    `  The rule raises ${floor.raised.length} ${floor.raised.length === 1 ? "lease" : "leases"} of --mem auto to the floor.`,
    ...list(floor.raised),
    `  ${floor.below.length} ${floor.below.length === 1 ? "lease" : "leases"} started below the floor with a reason (--below-peak).`,
    ...floor.below.slice(-FLOOR_ROWS).map((row) => `  ${row.job.slice(0, 60)} (${row.holder.slice(0, 20)}): ${Math.round(row.memoryMb)} MB, floor ${row.floorMb} MB. Reason: ${row.reason ?? "none"}`),
  ];
}

/** The usage of `headroom report`. */
export const REPORT_USAGE = "headroom report leases [--days 7] [--json]";
