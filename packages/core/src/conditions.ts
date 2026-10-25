/**
 * The conditions of a job (H31). A condition is a fact of the computer, not an amount. Examples: the laptop is plugged
 * in, or the usage window of Claude has room. `headroom run --when ac -- pnpm bench` waits for it.
 *
 * - The registry: each condition has a name, an optional value, a test of the facts and a waiting reason in STE.
 * - Admit: a lease waits until each of its conditions holds and its amounts fit. A power event runs the admission at once.
 * - The battery policy: on battery below a floor, a new heavy lease waits. `--battery-ok` starts it.
 * - `--timing`: a timing-sensitive job waits for AC power, because timing numbers on battery are wrong.
 * - A granted lease continues when a condition stops. The lease records the time, and `headroom status` shows it.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Lease } from "./broker.ts";
import type { PresenceState } from "./presence.ts";
import { BROWSER_SLOT, isSpawnHeavy } from "./spawn.ts";
import { countText } from "./starts.ts";
import { MEMORY } from "./types.ts";

/** The usage of the five-hour window of Claude, from the usage file of the fleet. */
export type UsageFacts =
  | {
      readonly state: "ok";
      readonly path: string;
      /** The used part of the window, from 0 to 1. */
      readonly ratio: number;
      /** The end of the window, in ms since the epoch, or `null` when the file does not give it. */
      readonly resetsAt: number | null;
      /** The time of the data: the field `updatedAt`, else the time of the last write of the file. */
      readonly updatedAt: number;
    }
  | { readonly state: "missing"; readonly path: string }
  | { readonly state: "unreadable"; readonly path: string; readonly error: string };

/** The facts that the conditions test. Each test is a pure function of these facts. */
export interface ConditionFacts {
  /** The time of the test, in ms since the epoch. */
  readonly now: number;
  /** True on AC power, false on battery. A computer with no battery read gives `null`, and it counts as on AC power. */
  readonly ac: boolean | null;
  /** The charge of the battery, from 0 to 100, or `null` on a computer with no battery. */
  readonly percent: number | null;
  /** The usage of the five-hour window. The engine reads the file only when a test reads this field. */
  readonly usage: UsageFacts;
  /**
   * The process starts of the computer in one minute, over the last 2 minutes (H29). It is exact on Windows. It is `null`
   * before two reads of the processes.
   */
  readonly starts: number | null;
  /**
   * The state of Mark at the laptop (H33): `present`, `busy` or `away`. It is `null` on a computer with no read of the
   * presence, and then the condition `away` holds.
   */
  readonly presence: PresenceState | null;
}

/** The operator of a condition with a value. */
export type ConditionOp = ">=" | "<";

/** The value of a condition, for example the percent of `battery>=50`. */
export interface ConditionValue {
  readonly op: ConditionOp;
  readonly min: number;
  readonly max: number;
  /** A value for the examples of the errors. */
  readonly example: number;
}

/** One condition of the registry. */
export interface Condition {
  readonly name: string;
  /** The fact, for the list of the known conditions: "the laptop is plugged in". */
  readonly about: string;
  /** The value of the condition. A condition without it takes no value. */
  readonly value?: ConditionValue | undefined;
  /** This function tells if the condition holds. `value` is `null` for a condition without a value. */
  test(facts: ConditionFacts, value: number | null): boolean;
  /** This function gives the waiting reason, for example "waits until the laptop is plugged in". */
  reason(facts: ConditionFacts, value: number | null): string;
  /** This function gives the facts that stop the condition, for a granted lease: "on battery". */
  state(facts: ConditionFacts, value: number | null): string;
}

/** A condition of a lease, as `--when` gives it. */
export interface ConditionSpec {
  readonly name: string;
  /** The value, or `null` for a condition without a value. */
  readonly value: number | null;
  /** The condition as text: `ac` or `battery>=50`. */
  readonly text: string;
}

/** The conditions of a lease (H31), as the store keeps them. */
export interface LeaseConditions {
  /** The conditions of `--when`, as text: `ac`, `battery>=50`, `usage<80`. */
  readonly when: readonly string[];
  /** `--timing`: the job measures time, so it waits for each condition of `TIMING_CONDITIONS`. */
  readonly timing?: boolean | undefined;
  /** `--battery-ok`: a heavy job starts also on a low battery. */
  readonly batteryOk?: boolean | undefined;
  /** `--during-drain` (H34): the job starts also in a planned drain for a reboot. */
  readonly duringDrain?: boolean | undefined;
  /** `--ignore-presence` (H33): a heavy job does not wait while Mark is busy, and gets no efficiency mode for Mark. */
  readonly ignorePresence?: boolean | undefined;
}

/** The record of a granted lease that runs without one of its conditions (H31). */
export interface UnmetCondition {
  /** The condition, as text: `ac`. */
  readonly condition: string;
  /** The facts at the start of the record, for a person: "on battery". */
  readonly state: string;
  readonly since: number;
  /** The time when the condition held again, or `null` while it does not hold. */
  readonly until: number | null;
}

/** The error of a wrong condition: an unknown name, a planned name or a wrong value. */
export class ConditionError extends Error {
  readonly code = "BAD_CONDITION";
}

/** The charge below which a new heavy lease waits on battery. `headroom config battery-floor <pct>` changes it. */
export const BATTERY_FLOOR_DEFAULT = 25;

/** A lease with this memory or more, in MB, is heavy for the battery policy. */
export const HEAVY_MEMORY_MB = 2048;

/** The conditions of `--timing`. H35 adds `cool`. */
export const TIMING_CONDITIONS: readonly string[] = ["ac"];

/** The end of the reason of a `--timing` wait. It points to CI, because the numbers of this computer on battery are wrong. */
export const TIMING_REASON = "timing numbers on battery are wrong, so run timing tests in CI";

/** Usage data older than this is stale, so `usage<N` does not hold. The fleet writes the file approximately each hour. */
export const USAGE_FRESH_MS: number = 70 * 60_000;

/** The time that the engine keeps a read of the usage file. */
export const USAGE_CACHE_MS = 30_000;

/** The usage file of the fleet: `~/git/fleet/artifacts/hub/db/usage/current.json`. `headroom config usage-file <path>` changes it. */
export function defaultUsageFile(): string {
  return join(homedir(), "git", "fleet", "artifacts", "hub", "db", "usage", "current.json");
}

/** This function writes a time as the local clock: "02:10". */
export function localClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const percentText = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/** This function writes the state of Mark for a reason: "at the laptop", "busy at the laptop" or "away". */
function presenceText(state: PresenceState | null): string {
  if (state === "present") return "at the laptop";
  return state === "busy" ? "busy at the laptop" : "away";
}

/** This function tells why the usage data does not give a ratio, or gives `null` when it is fresh. */
function usageProblem(facts: ConditionFacts): string | null {
  const usage = facts.usage;
  if (usage.state === "missing") return `waits for the usage data: ${usage.path} is missing`;
  if (usage.state === "unreadable") return `waits for the usage data: ${usage.path} ${usage.error}`;
  const age = facts.now - usage.updatedAt;
  if (age > USAGE_FRESH_MS) return `waits for fresh usage data: the file is ${Math.round(age / 60_000)} minutes old`;
  return null;
}

/** The registry of the conditions. */
export const CONDITIONS: readonly Condition[] = [
  {
    name: "ac",
    about: "the laptop is plugged in",
    test: (facts) => facts.ac !== false,
    reason: () => "waits until the laptop is plugged in",
    state: () => "on battery",
  },
  {
    name: "battery",
    about: "the battery is at N% or more, or the laptop is plugged in",
    value: { op: ">=", min: 0, max: 100, example: 50 },
    test: (facts, value) => facts.ac !== false || facts.percent === null || facts.percent >= (value ?? 0),
    reason: (facts, value) => `waits until the battery is at ${value ?? 0}% or more, or plugged in${facts.percent === null ? "" : ` (now ${facts.percent}%)`}`,
    state: (facts) => (facts.percent === null ? "on battery" : `on battery at ${facts.percent}%`),
  },
  {
    name: "usage",
    about: "the five-hour usage window of Claude is under N%",
    value: { op: "<", min: 1, max: 100, example: 80 },
    test: (facts, value) => {
      if (usageProblem(facts) !== null || facts.usage.state !== "ok") return false;
      // After the reset, the ratio of the old window no longer applies.
      if (facts.usage.resetsAt !== null && facts.now >= facts.usage.resetsAt) return true;
      return facts.usage.ratio * 100 < (value ?? 0);
    },
    reason: (facts, value) => {
      const problem = usageProblem(facts);
      if (problem !== null || facts.usage.state !== "ok") return problem ?? "waits for the usage data";
      const resets = facts.usage.resetsAt === null ? "" : `, resets at ${localClock(facts.usage.resetsAt)}`;
      return `waits until the five-hour usage window is under ${value ?? 0}% (now ${percentText(facts.usage.ratio)}${resets})`;
    },
    state: (facts) => {
      if (usageProblem(facts) !== null || facts.usage.state !== "ok") return "no fresh usage data";
      return `the usage window at ${percentText(facts.usage.ratio)}`;
    },
  },
  {
    name: "starts",
    about: "the computer starts fewer than N processes a minute",
    value: { op: "<", min: 1, max: 100_000, example: 700 },
    // Before two reads of the processes, the rate is not known, so the condition does not hold.
    test: (facts, value) => facts.starts !== null && facts.starts < (value ?? 0),
    reason: (facts, value) =>
      `waits until the computer starts fewer than ${countText(value ?? 0)} processes a minute (${facts.starts === null ? "no count yet" : `now ${countText(facts.starts)}`})`,
    state: (facts) => (facts.starts === null ? "no count of the process starts" : `${countText(facts.starts)} process starts a minute`),
  },
  {
    name: "away",
    about: "Mark is away from the laptop",
    // A computer with no read of the presence has no person to keep room for, so the condition holds.
    test: (facts) => facts.presence === null || facts.presence === "away",
    reason: (facts) => `waits until Mark is away from the laptop (now ${presenceText(facts.presence)})`,
    state: (facts) => `Mark is ${presenceText(facts.presence)}`,
  },
];

/** The planned conditions, with the item that adds each one. */
export const PLANNED_CONDITIONS: Readonly<Record<string, { readonly item: string; readonly about: string }>> = {
  cool: { item: "H35", about: "the processors are cool" },
  unmetered: { item: "H39", about: "the network is not metered" },
  night: { item: "H42", about: "the quiet hours" },
};

/** This function gives the condition of a name, or `undefined` for a name that is not in the registry. */
export function conditionOf(name: string): Condition | undefined {
  return CONDITIONS.find((each) => each.name === name);
}

/** This function writes the form of a condition: `ac` or `battery>=N`. */
function formOf(condition: Condition): string {
  return condition.value === undefined ? condition.name : `${condition.name}${condition.value.op}N`;
}

/** This function lists the known and the planned conditions, for an error. */
export function knownConditionsText(): string {
  const known = CONDITIONS.map((each) => `${formOf(each)} (${each.about})`).join(", ");
  const planned = Object.entries(PLANNED_CONDITIONS).map(([name, each]) => `${name} (${each.item})`).join(", ");
  return `The known conditions: ${known}. Planned: ${planned}.`;
}

const SPEC = /^([a-z][a-z-]*)(?:(>=|<=|>|<|=)(\S*))?$/;

/** This function reads one condition, for example `ac` or `battery>=50`. It throws a `ConditionError` for a wrong condition. */
export function parseCondition(input: string): ConditionSpec {
  const text = input.trim().toLowerCase().replace(/\s+/g, "");
  const match = SPEC.exec(text);
  const name = match?.[1];
  if (match === null || name === undefined) throw new ConditionError(`"${input.trim()}" is not a condition. ${knownConditionsText()}`);
  const condition = conditionOf(name);
  if (condition === undefined) {
    const planned = PLANNED_CONDITIONS[name];
    if (planned !== undefined) throw new ConditionError(`"${name}" is a planned condition: ${planned.item} adds it. ${knownConditionsText()}`);
    throw new ConditionError(`"${name}" is not a known condition. ${knownConditionsText()}`);
  }
  const [, , op, raw] = match;
  const value = condition.value;
  if (value === undefined) {
    if (op !== undefined) throw new ConditionError(`${name} takes no value: write ${name}`);
    return { name, value: null, text: name };
  }
  const example = `${name}${value.op}${value.example}`;
  if (op === undefined) throw new ConditionError(`${name} needs a value, for example ${example}`);
  if (op !== value.op) throw new ConditionError(`${name} takes ${value.op}, for example ${example}`);
  const number = raw === undefined || !/^\d+$/.test(raw) ? Number.NaN : Number(raw);
  if (!(number >= value.min && number <= value.max)) throw new ConditionError(`${text}: the value must be a whole number from ${value.min} to ${value.max}, for example ${example}`);
  return { name, value: number, text: `${name}${value.op}${number}` };
}

/**
 * This function reads the conditions of `--when`. Each value can have a list with commas: `ac,usage<80`. It removes a
 * condition that comes twice. It throws a `ConditionError` for a wrong condition.
 */
export function parseWhen(values: readonly string[]): ConditionSpec[] {
  const specs = new Map<string, ConditionSpec>();
  for (const part of values.flatMap((value) => value.split(","))) {
    if (part.trim() === "") continue;
    const spec = parseCondition(part);
    specs.set(spec.text, spec);
  }
  return [...specs.values()];
}

/**
 * This function gives the conditions of a new lease, or `undefined` for a lease with none. It throws a `ConditionError`
 * for a wrong condition.
 */
export function leaseConditions(
  when: readonly string[] | undefined,
  timing: boolean | undefined,
  batteryOk: boolean | undefined,
  duringDrain?: boolean | undefined,
  ignorePresence?: boolean | undefined,
): LeaseConditions | undefined {
  const specs = parseWhen(when ?? []);
  if (specs.length === 0 && timing !== true && batteryOk !== true && duringDrain !== true && ignorePresence !== true) return undefined;
  return {
    when: specs.map((spec) => spec.text),
    ...(timing === true ? { timing: true } : {}),
    ...(batteryOk === true ? { batteryOk: true } : {}),
    ...(duringDrain === true ? { duringDrain: true } : {}),
    ...(ignorePresence === true ? { ignorePresence: true } : {}),
  };
}

/** This function tells why a lease is heavy for the battery policy, or gives `null` for a lease that is not heavy. */
export function heavyWhy(lease: Lease): string | null {
  const memory = lease.amounts[MEMORY] ?? 0;
  if (memory >= HEAVY_MEMORY_MB) return `it asks for ${(memory / 1024).toFixed(1)} GB of memory`;
  if ((lease.amounts[BROWSER_SLOT] ?? 0) > 0) return "it runs browser tests";
  if (isSpawnHeavy(lease)) return "it starts many processes";
  return null;
}

/** Where a check of a lease comes from: `--when`, `--timing` or the battery floor. */
export type CheckSource = "when" | "timing" | "floor";

/** One condition that a lease waits for, with its source. */
export interface ConditionCheck {
  readonly spec: ConditionSpec;
  readonly source: CheckSource;
}

/**
 * This function gives the conditions that a lease waits for. They are its `--when` conditions and the conditions of
 * `--timing`. A heavy lease without `--battery-ok` also gets the battery floor. `floor` is the floor in percent, or `null` for none.
 */
export function checksOf(lease: Lease, floor: number | null): ConditionCheck[] {
  const conditions = lease.conditions;
  const checks: ConditionCheck[] = (conditions?.when ?? []).flatMap((text) => {
    try {
      return [{ spec: parseCondition(text), source: "when" as const }];
    } catch {
      // A condition that a newer version stored and that this version does not know does not stop the lease.
      return [];
    }
  });
  if (conditions?.timing === true) {
    for (const name of TIMING_CONDITIONS) {
      const index = checks.findIndex((check) => check.spec.text === name);
      const check: ConditionCheck = { spec: parseCondition(name), source: "timing" };
      if (index < 0) checks.push(check);
      else checks[index] = check;
    }
  }
  if (floor !== null && floor > 0 && conditions?.batteryOk !== true && heavyWhy(lease) !== null) {
    checks.push({ spec: { name: "battery", value: floor, text: `battery>=${floor}` }, source: "floor" });
  }
  return checks;
}

/** This function gives the reason of one check that does not hold. A `--timing` check and the battery floor add why. */
function checkReason(check: ConditionCheck, condition: Condition, facts: ConditionFacts, lease: Lease): string {
  const reason = condition.reason(facts, check.spec.value);
  if (check.source === "timing") return `${reason} (--timing): ${TIMING_REASON}`;
  if (check.source === "floor") return `${reason}: this job is heavy (${heavyWhy(lease) ?? "a heavy job"}). --battery-ok starts it on a low battery`;
  return reason;
}

/**
 * This function tells why a waiting lease waits for a condition, or gives `null` when each condition holds. The reason
 * starts with "waits until" or "waits for", and not with "waits for memory". The hook of the plugin counts only memory waits.
 */
export function conditionWait(lease: Lease, facts: ConditionFacts, floor: number | null): string | null {
  for (const check of checksOf(lease, floor)) {
    const condition = conditionOf(check.spec.name);
    if (condition === undefined || condition.test(facts, check.spec.value)) continue;
    return checkReason(check, condition, facts, lease);
  }
  return null;
}

/**
 * This function gives the first condition of a granted lease that does not hold, with its facts, or `null`. Only the
 * conditions of `--when` and `--timing` count: the battery floor is a rule for the start of a job.
 */
export function unmetCheck(lease: Lease, facts: ConditionFacts): { readonly condition: string; readonly state: string } | null {
  for (const check of checksOf(lease, null)) {
    const condition = conditionOf(check.spec.name);
    if (condition === undefined || condition.test(facts, check.spec.value)) continue;
    return { condition: check.spec.text, state: condition.state(facts, check.spec.value) };
  }
  return null;
}

/**
 * This function gives the next record of a granted lease after a check of its conditions, or the record that it has. A
 * condition that stops starts a record. A condition that holds again closes the open record.
 */
export function nextUnmet(lease: Lease, facts: ConditionFacts): UnmetCondition | undefined {
  const current = lease.unmet;
  const failed = unmetCheck(lease, facts);
  if (failed === null) return current === undefined || current.until !== null ? current : { ...current, until: facts.now };
  if (current !== undefined && current.until === null) return current;
  return { condition: failed.condition, state: failed.state, since: facts.now, until: null };
}

const CONDITION_WAIT = /^waits (until |while |for (the|fresh) usage data|for the planned reboot)/;

/**
 * This function tells if a waiting reason comes from a condition, from a planned drain (H34) or from the presence of Mark
 * (H33). A restart for an idle queue does not wait for such a lease.
 */
export function isConditionWait(reason: string | null): boolean {
  return reason !== null && CONDITION_WAIT.test(reason);
}

/**
 * This function tells if a lease waits for room: it waits, and not for a condition. A restart of the daemon waits only for
 * these leases, because a condition can take hours, and the new daemon keeps each lease.
 */
export function waitsForRoom(lease: Pick<Lease, "state" | "reason">): boolean {
  return lease.state === "waiting" && !isConditionWait(lease.reason);
}

/** This function writes the conditions of a lease, for example "when ac, usage<80, --timing", or `null` for a lease with none. */
export function conditionsText(conditions: LeaseConditions | undefined | null): string | null {
  if (conditions === undefined || conditions === null) return null;
  const parts = [
    ...conditions.when,
    ...(conditions.timing === true ? ["--timing"] : []),
    ...(conditions.batteryOk === true ? ["--battery-ok"] : []),
    ...(conditions.duringDrain === true ? ["--during-drain"] : []),
    ...(conditions.ignorePresence === true ? ["--ignore-presence"] : []),
  ];
  return parts.length === 0 ? null : `when ${parts.join(", ")}`;
}

/**
 * This function writes the record of a lease that runs without a condition: "runs without its condition: on battery since
 * 01:20". A closed record gives "ran without its condition ac: on battery from 01:20 to 01:35". `clock` writes a time.
 */
export function unmetText(unmet: UnmetCondition | undefined | null, clock: (at: number) => string = localClock): string | null {
  if (unmet === undefined || unmet === null) return null;
  if (unmet.until === null) return `runs without its condition: ${unmet.state} since ${clock(unmet.since)}`;
  return `ran without its condition ${unmet.condition}: ${unmet.state} from ${clock(unmet.since)} to ${clock(unmet.until)}`;
}

/** This function reads the usage of the five-hour window from the text of the usage file. `mtimeMs` is the time of its last write. */
export function parseUsage(text: string, path: string, mtimeMs: number): UsageFacts {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { state: "unreadable", path, error: "is not valid JSON" };
  }
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const window = record(record(record(data)?.["limits"])?.["five_hour"]);
  const ratio = window?.["ratio"];
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return { state: "unreadable", path, error: "has no limits.five_hour.ratio" };
  const time = (value: unknown): number | null => {
    const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  };
  return { state: "ok", path, ratio, resetsAt: time(window?.["resetsAt"]), updatedAt: time(record(data)?.["updatedAt"]) ?? mtimeMs };
}

/** This function reads the usage file. A file that does not exist is `missing`, and a file that does not open is `unreadable`. */
export function readUsage(path: string): UsageFacts {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    return parseUsage(readFileSync(path, "utf8"), path, mtimeMs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", path };
    return { state: "unreadable", path, error: `does not open (${code ?? (error instanceof Error ? error.message : String(error))})` };
  }
}

/** The reader of the usage file: it keeps each read for 30 seconds, and it has no file watcher. */
export class UsageReader {
  readonly #read: (path: string) => UsageFacts;
  readonly #cacheMs: number;
  #last: { readonly at: number; readonly path: string; readonly facts: UsageFacts } | null = null;

  constructor(read: (path: string) => UsageFacts = readUsage, cacheMs: number = USAGE_CACHE_MS) {
    this.#read = read;
    this.#cacheMs = cacheMs;
  }

  /** This function gives the usage from the file at `path`. A read of the same path in the last 30 seconds gives the kept facts. */
  read(path: string, now: number): UsageFacts {
    const last = this.#last;
    if (last !== null && last.path === path && now - last.at < this.#cacheMs && now >= last.at) return last.facts;
    const facts = this.#read(path);
    this.#last = { at: now, path, facts };
    return facts;
  }
}
