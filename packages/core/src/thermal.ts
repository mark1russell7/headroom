/**
 * The heat and the speed limits of the CPU (H35). When heat or a power limit slows the CPU, timing tests and benchmarks
 * give wrong numbers. Such jobs wait for a cool CPU, and headroom tells which owners make the heat.
 *
 * - Measure: PDH reads the counters in the query of the Energy Meter, with one collection for each read of the processes.
 * - The rule: a limit over 10% of the speed, or a passive limit of a thermal zone, for 30 seconds is a throttle.
 * - Attribute: while the CPU is throttled, the 3 owners with the most cores, with their power and their leased jobs.
 * - Alert `heat`: a warning after 5 minutes of throttle. It ends after 2 minutes with no throttle.
 * - Admit: the condition `cool` holds after 2 minutes with no throttle. `--timing` waits for it.
 *
 * This file has the pure functions and the trail. `windows-power.ts` has the reads.
 */

import type { Lease } from "./broker.ts";
import { COOL_MS, localClock } from "./conditions.ts";
import type { OwnerCores } from "./counters.ts";
import { minutesText, powerOwners, wattsText } from "./power.ts";
import type { OwnerKind } from "./types.ts";

/** A performance limit below this percent is a throttle: the limit takes more than 10% of the speed. */
export const THROTTLE_SPEED = 90;
/** A limit must hold for this time before the CPU counts as throttled. Short limits are normal. */
export const THROTTLE_HOLD_MS = 30_000;
/** A thermal zone at this temperature or more is hot. The processor of this laptop has a limit of 100 °C. */
export const HOT_CELSIUS = 98;
/** The trail keeps the reads of this time, as the trail of the CPU (H23). */
export const THERMAL_KEEP_MS: number = 11 * 60_000;
/** A read older than this gives no state, for example after the reads stop. */
export const THERMAL_STALE_MS = 60_000;

/** One value of a counter with instances, for example the temperature of one thermal zone. */
export interface CounterItem {
  readonly name: string;
  readonly value: number;
}

/** The values of the counters of H35 at one collection. A counter that the computer does not have is `null`. */
export interface ThermalCounters {
  /** `\Processor Information(_Total)\% Performance Limit`. */
  readonly performanceLimit: number | null;
  /** `\Processor Information(_Total)\% Processor Performance`. */
  readonly performance: number | null;
  /** `\Processor Information(_Total)\Processor Frequency`, in MHz. */
  readonly frequency: number | null;
  /** `\Thermal Zone Information(*)\Temperature`, in kelvin. */
  readonly temperature: readonly CounterItem[] | null;
  /** `\Thermal Zone Information(*)\% Passive Limit`. */
  readonly passiveLimit: readonly CounterItem[] | null;
  /** `\Thermal Zone Information(*)\Throttle Reasons`. */
  readonly throttleReasons: readonly CounterItem[] | null;
}

/** One thermal zone at one read. */
export interface ThermalZone {
  /** The name of the zone, for example `\_TZ.THM0`. */
  readonly name: string;
  /** The temperature in °C with one decimal, or `null` without a valid value. */
  readonly celsius: number | null;
  /** The part of the speed that the zone permits, in percent. 100 is no limit. */
  readonly passiveLimit: number | null;
  /** The throttle reasons of Windows as a bit mask. 0 is no reason. */
  readonly throttleReasons: number | null;
}

/** One read of the speed and the heat of the CPU (H35). A counter that the computer does not have is `null`. */
export interface ThermalRead {
  /** The speed that the CPU can give, in percent of its nominal speed. 100 is no limit. A power or heat limit lowers it. */
  readonly performanceLimit: number | null;
  /** The speed of the CPU, in percent of its nominal speed. A boost goes above 100. */
  readonly performance: number | null;
  /** The nominal frequency of the CPU, in MHz. */
  readonly nominalMhz: number | null;
  readonly zones: readonly ThermalZone[];
}

/** The speed and the heat of the CPU at one time, with the throttle rule (H35). */
export interface ThermalState extends ThermalRead {
  /** The time of the read. */
  readonly at: number;
  /** The speed that the limits permit: the lower of the performance limit and the passive limits, in percent. */
  readonly speed: number | null;
  /** The frequency of the CPU in MHz: the nominal frequency times the performance. */
  readonly mhz: number | null;
  /** The hottest thermal zone, or `null` with no zone. */
  readonly hottest: ThermalZone | null;
  /** True: a limit is on at the last read. */
  readonly limited: boolean;
  /** True: the limit held for 30 seconds or more. */
  readonly throttled: boolean;
  /** The start of the limit, or `null` with no limit. */
  readonly since: number | null;
  /** The last read with a throttle in the trail, or `null`. */
  readonly lastThrottledAt: number | null;
  /** True: no throttle in the last 2 minutes. The condition `cool` reads it. */
  readonly cool: boolean;
  /** True: a zone is at 98 °C or more, or a zone sets a passive limit. */
  readonly hot: boolean;
  /** The cause of the limit for a person, for example "a power or heat limit", or `null` with no limit. */
  readonly cause: string | null;
}

/** One owner that makes the heat: its cores over the last minute, its power as an estimate, and its leased jobs. */
export interface HeatOwner {
  readonly owner: string;
  readonly kind: OwnerKind;
  readonly cores: number;
  /** The power in W, as an estimate from the CPU power, or `null` without an Energy Meter (H30). */
  readonly watts: number | null;
  /** The leased jobs of the owner. */
  readonly jobs: readonly string[];
}

/** The state of `Status.thermal`: the state, and the owners with the most cores while the CPU is throttled. */
export interface ThermalStatus extends ThermalState {
  /** The 3 owners with the most cores while the CPU is throttled. With no throttle, the list is empty. */
  readonly owners: readonly HeatOwner[];
}

/** One point of the trail of the speed. */
export interface ThermalPoint {
  readonly at: number;
  /** The speed that the limits permit, in percent, or `null` without a counter of a limit. */
  readonly speed: number | null;
  /** True: a limit was on at this read. */
  readonly limited: boolean;
  /** True: the limit held for 30 seconds or more at this read. */
  readonly throttled: boolean;
}

const tenth = (value: number): number => Math.round(value * 10) / 10;

/** This function gives a finite number, or `null`. */
const finite = (value: number | null): number | null => (value !== null && Number.isFinite(value) ? value : null);

/** This function gives a temperature in °C from kelvin. A value of 0 or less, or of 1000 or more, is not valid. */
function celsiusOf(kelvin: number): number | null {
  return Number.isFinite(kelvin) && kelvin > 0 && kelvin < 1000 ? tenth(kelvin - 273.15) : null;
}

/**
 * This function gives a read from the counters of one collection. It joins the counters of each thermal zone by name. It
 * gives `null` when no counter has a value.
 */
export function parseThermal(counters: ThermalCounters): ThermalRead | null {
  const zones = new Map<string, { celsius: number | null; passiveLimit: number | null; throttleReasons: number | null }>();
  const zone = (name: string): { celsius: number | null; passiveLimit: number | null; throttleReasons: number | null } => {
    let found = zones.get(name);
    if (found === undefined) {
      found = { celsius: null, passiveLimit: null, throttleReasons: null };
      zones.set(name, found);
    }
    return found;
  };
  for (const item of counters.temperature ?? []) zone(item.name).celsius = celsiusOf(item.value);
  for (const item of counters.passiveLimit ?? []) zone(item.name).passiveLimit = Number.isFinite(item.value) ? tenth(item.value) : null;
  for (const item of counters.throttleReasons ?? []) zone(item.name).throttleReasons = Number.isFinite(item.value) ? Math.round(item.value) : null;
  const limit = finite(counters.performanceLimit);
  const performance = finite(counters.performance);
  const frequency = finite(counters.frequency);
  const read: ThermalRead = {
    performanceLimit: limit === null ? null : tenth(limit),
    performance: performance === null ? null : tenth(performance),
    nominalMhz: frequency === null || frequency <= 0 ? null : Math.round(frequency),
    zones: [...zones].map(([name, each]) => ({ name, ...each })),
  };
  const empty = read.performanceLimit === null && read.performance === null && read.nominalMhz === null && read.zones.length === 0;
  return empty ? null : read;
}

/** This function gives the speed that the limits permit: the lower of the performance limit and the passive limits, at most 100. */
export function speedOf(read: ThermalRead): number | null {
  const limits = [read.performanceLimit, ...read.zones.map((zone) => zone.passiveLimit)].filter((value): value is number => value !== null);
  return limits.length === 0 ? null : Math.min(100, ...limits);
}

/** The first zone with a passive limit under 100, or `undefined`. */
const passiveZone = (read: ThermalRead): ThermalZone | undefined => read.zones.find((zone) => zone.passiveLimit !== null && zone.passiveLimit < 100);

/** This function tells if a limit is on: a performance limit under 90%, or a passive limit under 100% in a zone. */
export function isLimited(read: ThermalRead): boolean {
  return (read.performanceLimit !== null && read.performanceLimit < THROTTLE_SPEED) || passiveZone(read) !== undefined;
}

/** This function gives the cause of a limit for a person, or `null` with no limit. A passive limit names its zone. */
export function causeOf(read: ThermalRead): string | null {
  const zone = passiveZone(read);
  if (zone !== undefined) return `a heat limit of the thermal zone ${zone.name}`;
  return isLimited(read) ? "a power or heat limit" : null;
}

/** This function gives the hottest zone with a temperature, else the first zone, or `null` with no zone. */
export function hottestZone(read: ThermalRead): ThermalZone | null {
  let hottest: ThermalZone | null = null;
  for (const zone of read.zones) if (zone.celsius !== null && (hottest?.celsius == null || zone.celsius > hottest.celsius)) hottest = zone;
  return hottest ?? read.zones[0] ?? null;
}

/**
 * The trail of the speed (H35): the reads of the last 11 minutes, as the trail of the CPU. Each read of the processes adds
 * one point. The trail gives the throttle rule, the condition `cool` and the heat alert. A sleep empties it.
 */
export class ThermalTracker {
  #trail: ThermalPoint[] = [];
  #last: { readonly at: number; readonly read: ThermalRead } | null = null;
  /** The start of the limit that holds at the last read, or `null`. A long limit keeps its start past the trail. */
  #limitedSince: number | null = null;

  /** This function adds one read. A failed read, or a computer with no counters, gives `null`, and the trail stays as it is. */
  add(at: number, read: ThermalRead | null): void {
    if (read === null) return;
    const limited = isLimited(read);
    this.#limitedSince = limited ? (this.#limitedSince ?? at) : null;
    const throttled = this.#limitedSince !== null && at - this.#limitedSince >= THROTTLE_HOLD_MS;
    while (this.#trail.length > 0 && at - (this.#trail[0]?.at ?? at) >= THERMAL_KEEP_MS) this.#trail.shift();
    this.#trail.push({ at, speed: speedOf(read), limited, throttled });
    this.#last = { at, read };
  }

  /** This function starts the trail again after a sleep, so a limit does not span the sleep. */
  gap(): void {
    this.#trail = [];
    this.#limitedSince = null;
  }

  /** The points of the last 11 minutes, the oldest first. */
  get trail(): readonly ThermalPoint[] {
    return this.#trail;
  }

  /** This function gives the state at a time, or `null` with no read in the last minute. */
  state(now: number): ThermalState | null {
    const last = this.#last;
    if (last === null || now - last.at > THERMAL_STALE_MS) return null;
    const read = last.read;
    let lastThrottledAt: number | null = null;
    for (const point of this.#trail) if (point.throttled) lastThrottledAt = point.at;
    const point = this.#trail.at(-1);
    const limited = point?.limited ?? false;
    const throttled = point?.throttled ?? false;
    const hottest = hottestZone(read);
    return {
      ...read,
      at: last.at,
      speed: speedOf(read),
      mhz: read.nominalMhz === null || read.performance === null ? null : Math.round((read.nominalMhz * read.performance) / 100),
      hottest,
      limited,
      throttled,
      since: limited ? this.#limitedSince : null,
      lastThrottledAt,
      cool: !throttled && (lastThrottledAt === null || now - lastThrottledAt >= COOL_MS),
      hot: (hottest?.celsius ?? Number.NEGATIVE_INFINITY) >= HOT_CELSIUS || passiveZone(read) !== undefined,
      cause: causeOf(read),
    };
  }
}

/**
 * This function gives the owners with the most cores, with their power as an estimate and their leased jobs. The power of
 * an owner is the CPU power times its part of the cores (H30). Thus the order by power is the order by cores.
 */
export function heatOwners(
  cores: readonly OwnerCores[] | undefined,
  cpuW: number | null,
  leases: readonly Lease[],
  ownerOf: ReadonlyMap<number, string>,
  limit = 3,
): HeatOwner[] {
  const watts = new Map(powerOwners(cores, cpuW).map((each) => [each.owner, each.watts]));
  const jobs = new Map<string, string[]>();
  for (const lease of leases) {
    // The process of `headroom run` holds each leased job, so its owner is the owner of the job.
    const owner = lease.state === "granted" && lease.pid !== null ? ownerOf.get(lease.pid) : undefined;
    if (owner !== undefined) jobs.set(owner, [...(jobs.get(owner) ?? []), lease.job.slice(0, 40)]);
  }
  return (cores ?? [])
    .filter((each) => each.cores >= 0.05)
    .slice(0, limit)
    .map((each) => {
      const power = watts.get(each.owner);
      return { owner: each.owner, kind: each.kind, cores: tenth(each.cores), watts: power === undefined ? null : tenth(power), jobs: jobs.get(each.owner) ?? [] };
    });
}

/** This function writes the owners: "session:graph 6.1 cores, 3.1 W (leased: vitest)". The power is an estimate. */
export function heatOwnersText(owners: readonly HeatOwner[]): string {
  return owners
    .map((each) => {
      const watts = each.watts === null ? "" : `, ${wattsText(each.watts)}`;
      const jobs = each.jobs.length === 0 ? "" : ` (leased: ${each.jobs.join(", ")})`;
      return `${each.owner} ${each.cores.toFixed(1)} ${each.cores === 1 ? "core" : "cores"}${watts}${jobs}`;
    })
    .join(", ");
}

/** This function writes a temperature: "97.0 °C". */
export function celsiusText(celsius: number): string {
  return `${celsius.toFixed(1)} °C`;
}

/** This function writes a frequency in GHz: "4.1 GHz". */
export function ghzText(mhz: number): string {
  return `${(mhz / 1000).toFixed(1)} GHz`;
}

/** The limits of the heat alert, from `AlertRules`. */
export interface HeatLimits {
  /** The throttle must hold for this time before the alert starts. */
  readonly heatForMs: number;
  /** An active alert ends after this time with no throttle. */
  readonly heatClearMs: number;
}

/**
 * This function tells if the heat alert holds at a time (H35). The alert starts when the limit held for `heatForMs`. An
 * active alert stays until `heatClearMs` with no throttle, so a short break does not end it.
 */
export function heatHolds(state: ThermalState | undefined, now: number, active: boolean, limits: HeatLimits): boolean {
  if (state === undefined) return false;
  if (state.throttled && state.since !== null && now - state.since >= limits.heatForMs) return true;
  if (!active) return false;
  return state.throttled || (state.lastThrottledAt !== null && now - state.lastThrottledAt < limits.heatClearMs);
}

/** This function writes the speed of a limited CPU: "62% of its speed". */
const speedPhrase = (state: ThermalState): string => `${Math.round(state.speed ?? 100)}% of its speed`;

/**
 * This function gives the message of the heat alert, for example "The CPU runs at 62% of its speed for 5 min: a power or heat
 * limit. Most CPU: session:graph 6.1 cores (leased: vitest)."
 */
export function heatMessage(state: ThermalState, owners: readonly HeatOwner[], now: number, limits: HeatLimits): string {
  const most = owners.length === 0 ? "" : ` Most CPU: ${heatOwnersText(owners)}.${owners.some((each) => each.watts !== null) ? " The power is an estimate." : ""}`;
  const zone = state.hottest?.celsius == null ? "" : ` The zone ${state.hottest.name} is at ${celsiusText(state.hottest.celsius)}.`;
  if (!state.throttled) {
    const at = state.lastThrottledAt === null ? "" : ` at ${localClock(state.lastThrottledAt)}`;
    return `The throttle of the CPU stopped${at}. The alert ends after ${minutesText(limits.heatClearMs / 60_000)} with no throttle.`;
  }
  const minutes = state.since === null ? "" : ` for ${minutesText((now - state.since) / 60_000)}`;
  return `The CPU runs at ${speedPhrase(state)}${minutes}: ${state.cause ?? "a power or heat limit"}.${zone}${most} Timing numbers are wrong on a slow CPU, so jobs with --timing wait.`;
}

/**
 * This function gives the line of `headroom status`, or `null` when the CPU is not throttled and not hot. Examples:
 * "Heat: the CPU runs at 62% of its speed since 14:02: a power or heat limit." and "Heat: 98.4 °C in the zone \_TZ.THM0."
 */
export function thermalLine(thermal: ThermalStatus | null | undefined, clock: (at: number) => string = localClock): string | null {
  if (thermal == null || (!thermal.throttled && !thermal.hot)) return null;
  const zone = thermal.hottest;
  const heat = zone?.celsius == null ? "" : ` ${celsiusText(zone.celsius)} in the zone ${zone.name}.`;
  if (thermal.limited) {
    const since = thermal.since === null ? "" : ` since ${clock(thermal.since)}`;
    const most = thermal.owners.length === 0 ? "" : ` Most CPU: ${heatOwnersText(thermal.owners)}.`;
    const wait = thermal.throttled ? " Jobs with --timing or --when cool wait." : "";
    return `Heat: the CPU runs at ${speedPhrase(thermal)}${since}: ${thermal.cause ?? "a power or heat limit"}.${heat}${most}${wait}`;
  }
  const speed = thermal.mhz === null ? "" : ` (${ghzText(thermal.mhz)})`;
  return `Heat:${heat === "" ? " a thermal zone is hot." : heat} The CPU runs at full speed${speed}.`;
}

/** This function writes a percent of the nominal speed, or "no counter". */
const percentRead = (value: number | null): string => (value === null ? "no counter" : `${value}% of the nominal speed`);

/** This function gives the lines of `headroom thermal`: the reads, the state, the condition `cool` and the owners. */
export function thermalLines(thermal: ThermalStatus | null | undefined, clock: (at: number) => string = localClock): string[] {
  if (thermal == null) return ["No counter of the speed or the heat of the CPU on this computer, or no read in the last minute."];
  const lines = [`Read at ${clock(thermal.at)}.`];
  const limit = thermal.performanceLimit;
  lines.push(`Speed limit: ${percentRead(limit)}${limit !== null && limit >= 100 ? " (no limit)" : ""}.`);
  const speed = thermal.mhz === null ? "" : `, ${ghzText(thermal.mhz)}`;
  const nominal = thermal.nominalMhz === null ? "" : ` (nominal ${ghzText(thermal.nominalMhz)})`;
  lines.push(`Speed: ${percentRead(thermal.performance)}${speed}${nominal}.`);
  if (thermal.zones.length === 0) lines.push("Thermal zones: none.");
  for (const zone of thermal.zones) {
    const heat = zone.celsius === null ? "no temperature" : celsiusText(zone.celsius);
    const passive = zone.passiveLimit === null ? "no counter" : `${zone.passiveLimit}%`;
    lines.push(`Zone ${zone.name}: ${heat}, passive limit ${passive}, throttle reasons ${zone.throttleReasons ?? "no counter"}.`);
  }
  const since = thermal.since === null ? "" : ` since ${clock(thermal.since)}`;
  const state = thermal.throttled
    ? `throttled${since}: ${thermal.cause ?? "a power or heat limit"}`
    : thermal.limited
      ? `a limit${since}: ${thermal.cause ?? "a power or heat limit"}. It is a throttle after 30 seconds`
      : thermal.hot
        ? "hot, at full speed"
        : "full speed";
  lines.push(`State: ${state}.`);
  const last = thermal.lastThrottledAt === null ? "" : ` The last throttle was at ${clock(thermal.lastThrottledAt)}.`;
  lines.push(`Cool: ${thermal.cool ? "yes, no throttle in the last 2 minutes" : "no, jobs with --timing or --when cool wait"}.${last}`);
  if (thermal.owners.length > 0) lines.push(`Most CPU: ${heatOwnersText(thermal.owners)}. The power is an estimate.`);
  return lines;
}
