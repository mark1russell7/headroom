/**
 * The window of the history commands (H201): `headroom history` and `headroom memory`. A window starts at a time, or a
 * count of minutes before its end. Its end time is not in the window, and by default the window has no end.
 *
 * `headroom memory` gives the 1-minute memory samples of a window: the available memory, the commit charge and the commit
 * limit. With --json, a script reads the samples from the command, so it does not read the database of headroom.
 */

import { parseArgs } from "node:util";
import { errorMessage } from "@mark1russell7/text";
import { gb, type History, type HistoryPart, type MemoryRow, type Sleep } from "@headroom/core";
import type { Connection } from "./client.ts";

const WINDOW_USAGE = "[--minutes <n> | --since <time>] [--until <time>] [--step <minutes>] [--json]";
export const HISTORY_USAGE: string = `headroom history ${WINDOW_USAGE}`;
export const MEMORY_USAGE: string = `headroom memory ${WINDOW_USAGE}`;

/** The options of a window, for parseArgs. */
export const WINDOW_OPTIONS = {
  minutes: { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  step: { type: "string" },
  json: { type: "boolean" },
} as const;

/** The longest window in minutes: the store keeps the samples of 7 days. */
const MAX_MINUTES = 10_080;
/** The longest step in minutes. */
const MAX_STEP = 1440;
/** The length of a window with no start option. */
const DEFAULT_MINUTES = 60;

/** A window of the history: the input of the procedure resources.history. The times are milliseconds since the epoch. */
export interface HistoryWindow {
  readonly since: number;
  /** The end, not in the window. With no end, the window has the samples up to the call. */
  readonly until?: number;
  /** The minutes in each row. A step above 1 averages the samples of each step. */
  readonly step: number;
}

/** The values of the window options. */
export interface WindowValues {
  readonly minutes?: string | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly step?: string | undefined;
}

/** This function reads a window from its options at the time `now`. For a wrong option, it gives the text of the error. */
export function historyWindow(values: WindowValues, now: number): HistoryWindow | string {
  const whole = (name: string, text: string | undefined, max: number): number | string | undefined => {
    if (text === undefined) return undefined;
    const value = Number(text);
    return /^\d+$/.test(text) && value >= 1 && value <= max ? value : `--${name} takes a whole number from 1 to ${max}, not "${text}".`;
  };
  const time = (name: string, text: string | undefined): number | string | undefined => {
    if (text === undefined) return undefined;
    const value = Date.parse(text);
    return Number.isFinite(value) ? value : `--${name} takes a time such as 2026-11-18T04:00Z, not "${text}".`;
  };
  const minutes = whole("minutes", values.minutes, MAX_MINUTES);
  const step = whole("step", values.step, MAX_STEP);
  const since = time("since", values.since);
  const until = time("until", values.until);
  for (const each of [minutes, step, since, until]) if (typeof each === "string") return each;
  if (minutes !== undefined && since !== undefined) return "--minutes and --since both give the start. Give only one of them.";
  const end = (until as number | undefined) ?? now;
  const start = (since as number | undefined) ?? end - ((minutes as number | undefined) ?? DEFAULT_MINUTES) * 60_000;
  if (start >= end) return `The start ${new Date(start).toISOString()} is not before the end ${new Date(end).toISOString()}.`;
  return { since: start, ...(until === undefined ? {} : { until: until as number }), step: (step as number | undefined) ?? 1 };
}

/** The outputs of a command. The tests replace them. */
export interface HistoryOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const CONSOLE: HistoryOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };

/** The JSON of `headroom memory --json`. */
export interface MemorySamples {
  /** The start of the window, in milliseconds since the epoch. */
  readonly since: number;
  /** The end of the window, not in the window. Null: the window has no end. */
  readonly until: number | null;
  /** The minutes in each sample. A step above 1 averages the samples of each step. */
  readonly step: number;
  /** The samples, the oldest first. */
  readonly samples: readonly MemoryRow[];
  /** The sleeps of the computer in the window, the oldest first. No sample is in a sleep. */
  readonly sleeps: readonly Sleep[];
}

/** The parts of the history that `headroom memory` reads. */
const MEMORY_PARTS: readonly HistoryPart[] = ["memory", "sleeps"];

/** This function writes a time as UTC text: "04:00", or "11-18 04:00" when the window has more than one UTC date. */
function clockOf(at: number, withDate: boolean): string {
  const text = new Date(at).toISOString();
  return withDate ? `${text.slice(5, 10)} ${text.slice(11, 16)}` : text.slice(11, 16);
}

/** This function gives the lines of the memory samples of a window. */
export function memoryLines(report: MemorySamples, now: number): string[] {
  const end = report.until ?? now;
  const withDate = new Date(report.since).toISOString().slice(0, 10) !== new Date(end - 1).toISOString().slice(0, 10);
  const span = `from ${new Date(report.since).toISOString().slice(0, 16).replace("T", " ")} to ${report.until === null ? "now" : new Date(end).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  if (report.samples.length === 0) return [`No memory sample is in the window ${span}.`];
  const each = report.step === 1 ? "of 1 minute" : `of ${report.step} minutes, each the average of its samples`;
  const lines = [`The memory samples ${span} (${report.samples.length} samples ${each}):`];
  for (const row of report.samples) {
    lines.push(`  ${clockOf(row.at, withDate)}  available ${gb(row.availableMb).padStart(8)}  committed ${gb(row.commitMb).padStart(8)} of ${gb(row.commitLimitMb)}`);
  }
  for (const [from, to] of report.sleeps) lines.push(`The computer slept from ${clockOf(from, withDate)} to ${clockOf(to, withDate)} UTC.`);
  return lines;
}

/** The `headroom memory` command. Its exit code is 0 with the samples, 1 with no daemon or an old daemon, and 2 for a wrong option. */
export async function memoryCommand(argv: readonly string[], connection: Connection | null, output: HistoryOutput = CONSOLE, now: () => number = Date.now): Promise<number> {
  let values: WindowValues & { readonly json?: boolean | undefined };
  try {
    ({ values } = parseArgs({ args: [...argv], options: WINDOW_OPTIONS, allowPositionals: false }));
  } catch (error) {
    output.err(`${errorMessage(error)}\nUsage: ${MEMORY_USAGE}`);
    return 2;
  }
  const at = now();
  const window = historyWindow(values, at);
  if (typeof window === "string") {
    output.err(`${window}\nUsage: ${MEMORY_USAGE}`);
    return 2;
  }
  if (connection === null) {
    output.err("headroom does not run.");
    return 1;
  }
  const history = await connection.call<History>(["resources", "history"], { ...window, parts: MEMORY_PARTS });
  // A daemon of before H201 does not read the parts and the times, so it gives the owners of its last 60 minutes.
  if (history.owners.length > 0) {
    output.err("The daemon is older than this command, so it does not read the window. Restart it with headroom service restart.");
    return 1;
  }
  const report: MemorySamples = { since: window.since, until: window.until ?? null, step: window.step, samples: history.memory, sleeps: history.sleeps };
  if (values.json) output.out(JSON.stringify(report, null, 2));
  else for (const line of memoryLines(report, at)) output.out(line);
  return 0;
}
