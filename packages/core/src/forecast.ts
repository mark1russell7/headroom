/**
 * The forecasts of headroom (H32): the time until a resource instance reaches a limit, from its history.
 *
 * A fit takes the points of one instance over the last 60 minutes, after the last gap. The slope is the Theil–Sen
 * slope: the median of the slopes of all the pairs of points. Thus one outlier does not move the line. The confidence is
 * Kendall's tau of the points in the direction of the slope. It is the part of the pairs that move with the trend, less
 * the part that moves against it. The functions are pure. They have no clock, so the tests use fixed points.
 *
 * The fit gives no trend in these cases:
 *
 * - Fewer than 10 points, or less than 30 minutes of points after the last gap.
 * - A slope of 0, or a confidence below 0.5 (a noisy line).
 * - A newer half of the window that is flat or moves against the trend (a single step, or a trend that stopped).
 *
 * A forecast to a target also gives nothing in these cases:
 *
 * - The trend moves away from the target.
 * - The instance is already at or past the target.
 * - The target is more than 30 days away.
 */

import { minutesText } from "./power.ts";
import type { ResourceKind, ResourceStatus, Unit } from "./resources.ts";
import { diskSize, gb } from "./units.ts";

/** One point of the history of a resource instance: the time, the used part and the free part, in the unit of its kind. */
export type ResourcePoint = readonly [at: number, used: number | null, free: number | null];

/** The part of an instance that a fit or a target examines. */
export type Part = "used" | "free";

/** The name of a target: the level of the alert at the target, or `empty` for a full drive or an empty battery. */
export type TargetName = "warning" | "critical" | "empty";

/** One target of a forecast: an amount of the used part or of the free part, in the unit of the kind. */
export interface ForecastTarget {
  readonly on: Part;
  readonly amount: number;
  readonly name: TargetName;
}

/** The time until an instance reaches a target. */
export interface Forecast {
  /** The minutes from the time of the forecast to the target. */
  readonly minutes: number;
  /** The time of the target, in milliseconds since the epoch. */
  readonly at: number;
  readonly target: ForecastTarget;
  /** The change of the part of the target in one hour, in the unit of the kind. A loss of free space is negative. */
  readonly rate: number;
  /** The confidence, from 0 to 1. A fit gives Kendall's tau of its points. The estimate of Windows gives 1. */
  readonly confidence: number;
  /** `fit`: a fit of the history. `windows`: the time left of the battery that Windows estimates, with no fit. */
  readonly source: "fit" | "windows";
}

/** The trend of one part of an instance: the result of a fit. */
export interface Trend {
  readonly on: Part;
  /** The change in one hour, in the unit of the kind, with no rounding. */
  readonly rate: number;
  /** Kendall's tau of the points in the direction of the slope, from 0.5 to 1. */
  readonly confidence: number;
  /** The time and the value of the last point of the fit. */
  readonly at: number;
  readonly value: number;
  /** The count of points and the time between the first point and the last point. */
  readonly points: number;
  readonly spanMs: number;
}

/** The options of a fit. Each field has a default. */
export interface FitOptions {
  /** The window of the fit, before the last point. The default is 60 minutes. */
  readonly windowMs?: number | undefined;
  /** The fit uses only the points at or after this time: the last wake or the start of the computer. */
  readonly since?: number | undefined;
  /** A step between two points longer than this is a gap: a sleep, or a stop of the daemon. The default is 5 minutes. */
  readonly gapMs?: number | undefined;
  /** With fewer points than this after the last gap, the fit gives no trend. The default is 10. */
  readonly minPoints?: number | undefined;
  /** With a shorter span of points after the last gap, the fit gives no trend. The default is 30 minutes. */
  readonly minSpanMs?: number | undefined;
  /** With a lower confidence, the fit gives no trend. The default is 0.5. */
  readonly minConfidence?: number | undefined;
}

const HOUR_MS = 3_600_000;
/** The window of a fit. */
export const FORECAST_WINDOW_MS: number = 60 * 60_000;
/** A longer step between two points is a gap. The daemon writes one point each minute. */
export const FORECAST_GAP_MS: number = 5 * 60_000;
export const FORECAST_MIN_POINTS = 10;
export const FORECAST_MIN_SPAN_MS: number = 30 * 60_000;
export const FORECAST_MIN_CONFIDENCE = 0.5;
/** A target further away than this gives no forecast. One hour of history tells little about next month. */
export const FORECAST_MAX_MS: number = 30 * 24 * HOUR_MS;

/** One value of a part at one time. */
interface Value {
  readonly t: number;
  readonly v: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** This function gives the values of a part in the window of the last point, after the last gap, the oldest first. */
function segment(points: readonly ResourcePoint[], on: Part, options: FitOptions): Value[] {
  const index = on === "used" ? 1 : 2;
  const since = options.since ?? Number.NEGATIVE_INFINITY;
  const values: Value[] = [];
  for (const each of points) {
    const v = each[index];
    if (v !== null && Number.isFinite(v) && each[0] >= since) values.push({ t: each[0], v });
  }
  values.sort((a, b) => a.t - b.t);
  const last = values.at(-1);
  if (last === undefined) return [];
  const windowMs = options.windowMs ?? FORECAST_WINDOW_MS;
  const gapMs = options.gapMs ?? FORECAST_GAP_MS;
  let start = values.length - 1;
  for (;;) {
    const previous = values[start - 1];
    const current = values[start];
    if (previous === undefined || current === undefined || current.t - previous.t > gapMs || last.t - previous.t > windowMs) break;
    start -= 1;
  }
  return values.slice(start);
}

/** This function gives the Theil–Sen slope of the values, per millisecond, and Kendall's tau of the pairs. */
function theilSen(values: readonly Value[]): { readonly slope: number; readonly tau: number } {
  const slopes: number[] = [];
  let up = 0;
  let down = 0;
  for (let i = 0; i < values.length; i += 1) {
    const a = values[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < values.length; j += 1) {
      const b = values[j];
      if (b === undefined || b.t === a.t) continue;
      const slope = (b.v - a.v) / (b.t - a.t);
      slopes.push(slope);
      if (slope > 0) up += 1;
      else if (slope < 0) down += 1;
    }
  }
  if (slopes.length === 0) return { slope: 0, tau: 0 };
  slopes.sort((a, b) => a - b);
  const middle = slopes.length >> 1;
  const slope = slopes.length % 2 === 1 ? (slopes[middle] ?? 0) : ((slopes[middle - 1] ?? 0) + (slopes[middle] ?? 0)) / 2;
  return { slope, tau: (up - down) / slopes.length };
}

/**
 * This function fits a trend to one part of the points of an instance, or gives `null` when the points show no trend.
 * The comment of this module gives the rules.
 */
export function fitTrend(points: readonly ResourcePoint[], on: Part, options: FitOptions = {}): Trend | null {
  const values = segment(points, on, options);
  const first = values[0];
  const last = values.at(-1);
  if (first === undefined || last === undefined) return null;
  const spanMs = last.t - first.t;
  if (values.length < (options.minPoints ?? FORECAST_MIN_POINTS) || spanMs < (options.minSpanMs ?? FORECAST_MIN_SPAN_MS)) return null;
  const { slope, tau } = theilSen(values);
  if (slope === 0) return null;
  const confidence = Math.sign(slope) * tau;
  if (confidence < (options.minConfidence ?? FORECAST_MIN_CONFIDENCE)) return null;
  // A single step or a trend that stopped leaves the newer half flat.
  const middle = first.t + spanMs / 2;
  const newer = theilSen(values.filter((each) => each.t >= middle)).slope;
  if (Math.sign(newer) !== Math.sign(slope)) return null;
  return { on, rate: slope * HOUR_MS, confidence: round2(confidence), at: last.t, value: last.v, points: values.length, spanMs };
}

/**
 * This function gives the time until a trend reaches a target, or `null`. The start is the value at `now` when the caller
 * gives it, else the last point of the fit. A free part moves down to its target, and a used part moves up to its target.
 */
export function forecastFrom(trend: Trend, target: ForecastTarget, now: number, value?: number | null): Forecast | null {
  if (target.on !== trend.on) return null;
  const known = value !== undefined && value !== null;
  const level = known ? value : trend.value;
  const from = known ? now : trend.at;
  const toward = target.on === "free" ? -1 : 1;
  if (Math.sign(trend.rate) !== toward) return null;
  const distance = (target.amount - level) * toward;
  if (!(distance > 0)) return null;
  const at = Math.round(from + (distance / Math.abs(trend.rate)) * HOUR_MS);
  if (at - now > FORECAST_MAX_MS) return null;
  return { minutes: Math.max(0, Math.round((at - now) / 60_000)), at, target, rate: round2(trend.rate), confidence: trend.confidence, source: "fit" };
}

/**
 * This function gives the time until the points of one instance reach a target, or `null`. It fits the part of the
 * target, and starts at the last point. `now` is the time of the forecast: the default is the time of the last point.
 */
export function forecast(points: readonly ResourcePoint[], target: ForecastTarget, options: FitOptions & { readonly now?: number | undefined } = {}): Forecast | null {
  const trend = fitTrend(points, target.on, options);
  return trend === null ? null : forecastFrom(trend, target, options.now ?? trend.at);
}

/** This function gives the time of a forecast for a person: "45 min", "3 h 10 min", or "9 days" from 48 hours. */
export function spanText(minutes: number): string {
  return minutes >= 48 * 60 ? `${Math.round(minutes / 1440)} days` : minutesText(minutes);
}

/** This function gives a rate in one hour for a person, with no sign: "4.1 GB an hour", or "0.9 GB a day" for a slow rate. */
export function rateText(rate: number, unit: Unit): string {
  const perHour = Math.abs(rate);
  if (unit === "MB") return perHour >= 100 ? `${diskSize(perHour)} an hour` : `${diskSize(perHour * 24)} a day`;
  if (unit === "count") return perHour >= 10 ? `${Math.round(perHour)} an hour` : `${Math.round(perHour * 24)} a day`;
  // A charge in Wh that changes in one hour is a power in W.
  if (unit === "Wh") return `${perHour.toFixed(1)} W`;
  return `${round2(perHour)} ${unit} an hour`;
}

/** The fields of a resource status that the text of a forecast reads. */
export type ForecastEntry = Pick<ResourceStatus, "id" | "kind" | "unit" | "capacity" | "forecast">;

/** The names of the instances for a person. A drive gets "Drive C:". */
const SUBJECTS: Readonly<Record<string, string>> = {
  memory: "Memory",
  commit: "Commit charge",
  "pool:nonpaged": "Non-paged pool",
  "pool:paged": "Paged pool",
  "ports:tcp": "TCP ports",
  battery: "Battery",
};

/** This function gives the name of an instance for a person. */
function subjectOf(id: string, kind: ResourceKind): string {
  return kind === "disk" ? `Drive ${id.slice("disk:".length)}` : (SUBJECTS[id] ?? id);
}

/** This function gives the state of an instance at a target for a person: "full", "5 GB free" or "90% of its limit". */
function stateAt(entry: ForecastEntry, target: ForecastTarget): string {
  if (target.name === "empty") return entry.kind === "disk" ? "full" : "empty";
  if (entry.kind === "pool") return `${gb(target.amount)} (its alert level)`;
  if (target.on === "used" && entry.capacity !== null && entry.capacity > 0) {
    const percent = Math.round((target.amount / entry.capacity) * 100);
    return entry.kind === "commit" ? `${percent}% of its limit` : `${percent}% in use`;
  }
  if (entry.unit === "MB") return `${diskSize(target.amount)} ${entry.kind === "memory" ? "available" : target.on}`;
  return `${round2(target.amount)} ${target.on}`;
}

/** This function gives the forecast of an instance in a short phrase, for example "Drive C: 5 GB free in 9 h 10 min", or `null`. */
export function forecastPhrase(entry: ForecastEntry): string | null {
  const forecast = entry.forecast;
  if (forecast === undefined) return null;
  // A Windows drive already ends with a colon: "Drive C: full".
  const subject = subjectOf(entry.id, entry.kind);
  return `${subject}${subject.endsWith(":") ? "" : ":"} ${stateAt(entry, forecast.target)} in ${spanText(forecast.minutes)}`;
}

/**
 * This function gives the forecast of an instance in a sentence, for example "Drive C: full in 9 days (at 0.9 GB a day,
 * confidence 0.82).", or `null` with no forecast.
 */
export function forecastText(entry: ForecastEntry): string | null {
  const phrase = forecastPhrase(entry);
  const forecast = entry.forecast;
  if (phrase === null || forecast === undefined) return null;
  const why = forecast.source === "windows" ? "the estimate of Windows" : `at ${rateText(forecast.rate, entry.unit)}, confidence ${forecast.confidence.toFixed(2)}`;
  return `${phrase} (${why}).`;
}

/**
 * This function gives the line of `headroom status`: the forecasts under the horizon, the nearest first, for example
 * "Forecast (24 h): Drive C: 5 GB free in 9 h 10 min, Battery: empty in 1 h 50 min.". It gives `null` with none.
 */
export function forecastLine(resources: readonly ForecastEntry[], horizonMinutes: number = 24 * 60): string | null {
  const near = resources
    .filter((each) => each.forecast !== undefined && each.forecast.minutes <= horizonMinutes)
    .sort((a, b) => (a.forecast?.minutes ?? 0) - (b.forecast?.minutes ?? 0));
  if (near.length === 0) return null;
  return `Forecast (${spanText(horizonMinutes)}): ${near.map((each) => forecastPhrase(each)).join(", ")}.`;
}
