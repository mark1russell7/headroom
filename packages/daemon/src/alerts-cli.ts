/**
 * The setting `alerts` of `headroom config` (H179): the alert limits that differ from the defaults.
 *
 * `headroom config alerts` shows the differences. `headroom config alerts <name> <number>` sets one limit, and
 * `headroom config alerts <name> --clear` gives one limit its default. `headroom config alerts --clear` gives all the
 * defaults. The names are the names of `AlertRules`, for example `availableCriticalMb`. The daemon checks each number.
 */

import { DEFAULT_ALERT_RULES, type AlertRules, type AlertRulesChange } from "@headroom/core";

export const ALERTS_USAGE =
  "Usage: headroom config alerts, headroom config alerts <name> <number>, headroom config alerts <name> --clear, or headroom config alerts --clear";

/** This function gives the lines of the setting `alerts` for `headroom config`: each limit that differs, with its default. */
export function alertsLines(alerts: Readonly<Partial<AlertRules>>): string[] {
  const entries = Object.entries(alerts);
  if (entries.length === 0) return ["alerts: (the defaults)"];
  const lines = entries.map(([name, value]) => `  ${name.padEnd(24)} ${value} (default ${DEFAULT_ALERT_RULES[name as keyof AlertRules] ?? "none"})`);
  return ["alerts:", ...lines];
}

/**
 * This function gives the change of `headroom config alerts`. A name and a number set one limit. A name with `--clear`
 * gives one limit its default. `--clear` alone gives `null`, which removes all the differences. With no name and no
 * `--clear` it gives `"show"`. Other arguments give `undefined`.
 */
export function alertsChange(name: string | undefined, value: string | undefined, clear: boolean): AlertRulesChange | null | "show" | undefined {
  if (name === undefined) return clear ? null : "show";
  if (value === undefined) return clear ? { [name]: null } : undefined;
  if (clear || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? { [name]: number } : undefined;
}
