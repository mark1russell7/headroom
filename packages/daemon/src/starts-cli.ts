/**
 * The `headroom starts` command (H193): it reads the start log from its file, so it needs no daemon.
 *
 * - `headroom starts <pid> [--at <time>] [--json]`: the starts of a pid, each with its program, its command line, its exit,
 *   its parents and the reuse of the pid before it. A crash dump gives the pid and the time.
 * - `headroom starts --top [--hours <n>] [--json]`: the starters with the most starts, by program and by the command line
 *   of the parent. The span is the last hour or the last `n` hours. The fleet cuts the top starters.
 * - `headroom starts --slow [--hours <n>] [--json]` (H199): the spread of the lag and of the commit time over the span,
 *   and each slow step of the writer with its cause. The 1-minute samples of the store tell the state of the system in
 *   the minute of each step.
 *
 * The daemon also calls `writeStartsBeforeStop` after an unclean stop, for example a bugcheck. It keeps the starts of the
 * last 2 minutes before the stop in a JSON file, so they stay after the 24 hours of the log.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  openStartLog,
  parentsOf,
  rankStarters,
  slowStepCause,
  slowStepsBetween,
  START_LOG_SLOW_MS,
  startLogSpan,
  startLogSpreads,
  startsBetween,
  startsOfPid,
  type LoggedStart,
  type RankedStarter,
  type ResourceRow,
  type SlowCause,
  type SlowStep,
  type SlowStepContext,
  type StartLogSpread,
  type StartLogSpreads,
} from "@headroom/core";

export const STARTS_USAGE = "headroom starts <pid> [--at <time>] [--json] | headroom starts --top|--slow [--hours <n>] [--json]";

/** The outputs of the command. The tests replace them. */
export interface StartsOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** The sources of `headroom starts` besides the start log. The tests replace them. */
export interface StartsSources {
  /** The clock: the end of the span of `--slow`. */
  readonly now?: (() => number) | undefined;
  /** The 1-minute samples of the store from `from` to `to`, or `null` when the store cannot be read. */
  readonly samples?: ((from: number, to: number) => readonly ResourceRow[] | null) | undefined;
}

/** The samples that tell the state of the system in the minute of a slow step. */
export const SLOW_SAMPLE_IDS: readonly string[] = ["memory", "commit", "cpu", "procs:traced"];
/** The farthest sample from a slow step that tells its state: the samples come each minute. */
const SAMPLE_NEAR_MS = 90_000;

const CONSOLE: StartsOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };
const HOUR_MS = 3_600_000;
/** The time around `--at` in which a start of the pid counts. */
const NEAR_MS = 600_000;
/** The most starts of a pid in the text. `--json` gives all of them. */
const SHOWN = 5;
const TOP = 20;
/** The longest text of a command line in a line of the ranking. */
const TEXT_CHARS = 160;
/** The time before an unclean stop that `writeStartsBeforeStop` keeps. */
export const BEFORE_STOP_MS = 120_000;

/** This function writes a time in UTC with ms: "2026-11-16 07:10:16.413 UTC". */
function timeText(ms: number): string {
  return `${new Date(ms).toISOString().replace("T", " ").replace("Z", "")} UTC`;
}

/** This function writes an exit code: in hexadecimal when it is an NTSTATUS, for example 0xC0000142. */
function exitCodeText(code: number | null): string {
  if (code === null) return "an unknown exit code";
  return code >= 0x8000_0000 ? `exit code 0x${code.toString(16).toUpperCase()}` : `exit code ${code}`;
}

/** This function cuts a long text to `chars` characters. */
function cut(text: string | null, chars = TEXT_CHARS): string {
  if (text === null) return "(not read)";
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
}

/** This function writes the lines of one start, with its parents. */
function startLines(start: LoggedStart, parents: readonly LoggedStart[]): string[] {
  const created = start.createdAt === null ? "" : ` (created ${timeText(start.createdAt)})`;
  const end = start.exit === null ? "No exit is in the log." : `It ended ${timeText(start.exit.at)} with ${exitCodeText(start.exit.exitCode)}.`;
  const lines = [`Process ${start.pid}: in the log at ${timeText(start.at)}${created}. ${end}`, `  Program: ${start.image ?? "(not read)"}`, `  Command: ${start.command ?? "(not read)"}`];
  if (start.adopted) lines.push("  It ran before the trace put it in a job: it is an adoption, not a start.");
  if (start.reuseMs !== null) lines.push(`  The pid was free for ${start.reuseMs.toLocaleString("en-US")} ms: a traced process with this pid ended before this creation.`);
  let indent = "  ";
  for (const parent of parents) {
    lines.push(`${indent}Parent ${parent.pid}: ${parent.image ?? "(not read)"}`, `${indent}  ${cut(parent.command, 400)}`);
    indent += "  ";
  }
  if (parents.length === 0 && start.ppid !== null) {
    const command = start.parentCommand === null ? "" : ` ${cut(start.parentCommand, 400)}`;
    lines.push(`  Parent ${start.ppid}: not in the log.${command}`);
  }
  return lines;
}

/** This function writes a count of adoptions: "1 process that ran before the trace put it in a job". */
function adoptionText(count: number): string {
  return count === 1 ? "1 process that ran before the trace put it in a job" : `${count.toLocaleString("en-US")} processes that ran before the trace put them in a job`;
}

/** This function writes the lines of a ranking. */
function rankLines(title: string, starters: readonly RankedStarter[]): string[] {
  const lines = [title];
  starters.forEach((starter, index) => {
    lines.push(`  ${String(index + 1).padStart(2)}. ${starter.perMinute.toFixed(1).padStart(8)} a minute  ${cut(starter.text ?? "(not read)")}`);
  });
  return lines;
}

/** This function runs `headroom starts`. `path` is the file of the start log. */
export function startsCommand(args: readonly string[], path: string, output: StartsOutput = CONSOLE, sources: StartsSources = {}): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { top: { type: "boolean" }, slow: { type: "boolean" }, hours: { type: "string" }, at: { type: "string" }, json: { type: "boolean" } },
    });
  } catch (error) {
    output.err(`${error instanceof Error ? error.message : String(error)}\nUsage: ${STARTS_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const top = values.top === true;
  const slow = values.slow === true;
  const hours = values.hours === undefined ? 1 : Number(values.hours);
  const pid = positionals.length === 1 ? Number(positionals[0]) : Number.NaN;
  const at = values.at === undefined ? null : Date.parse(values.at);
  const spanned = top || slow;
  const usable = top && slow ? false : spanned ? positionals.length === 0 && hours > 0 && hours <= 24 && values.at === undefined : Number.isInteger(pid) && pid > 0 && values.hours === undefined && (at === null || !Number.isNaN(at));
  if (!usable) {
    output.err(`Usage: ${STARTS_USAGE}`);
    return 2;
  }
  if (!existsSync(path)) {
    output.err(`The start log is not there: ${path}. The daemon writes it while the start trace runs (headroom config start-trace).`);
    return 1;
  }
  const db = openStartLog(path);
  try {
    if (slow) return slowCommand(db, hours, values.json === true, output, sources);
    if (top) {
      const ranking = rankStarters(db, hours * HOUR_MS, TOP);
      if (values.json === true) {
        output.out(JSON.stringify(ranking, null, 2));
        return 0;
      }
      if (ranking === null) {
        output.out(`The start log has no start: ${path}.`);
        return 0;
      }
      const span = `${timeText(ranking.from).slice(0, 16)} to ${timeText(ranking.to).slice(11)}`;
      const reused = ranking.starts > 0 ? Math.round((ranking.reusedUnder60s / ranking.starts) * 1000) / 10 : 0;
      const fast = ranking.starts > 0 ? Math.round((ranking.reusedUnder1s / ranking.starts) * 1000) / 10 : 0;
      output.out(
        [
          `The starters of the last ${hours} h (${span}): ${ranking.starts.toLocaleString("en-US")} starts in the log, ${ranking.perMinute.toFixed(1)} a minute.`,
          ...rankLines("By program:", ranking.images),
          ...rankLines("By the command line of the parent:", ranking.parents),
          `Pid reuse: ${reused} % of the starts got a pid that a traced process left less than 60 s before, ${fast} % less than 1 s before.`,
          ...(ranking.adopted > 0 ? [`The ranking does not count ${adoptionText(ranking.adopted)}.`] : []),
          "The log has only the processes of the start trace. headroom status gives the part of all the starts that the trace covers.",
        ].join("\n"),
      );
      return 0;
    }
    let starts = startsOfPid(db, pid, 50);
    if (at !== null) {
      const distance = (start: LoggedStart): number => Math.abs((start.createdAt ?? start.at) - at);
      starts = starts.filter((start) => distance(start) <= NEAR_MS).sort((a, b) => distance(a) - distance(b));
    }
    const found = starts.map((start) => ({ ...start, parents: parentsOf(db, start) }));
    if (values.json === true) {
      output.out(JSON.stringify(found, null, 2));
      return 0;
    }
    if (found.length === 0) {
      const span = startLogSpan(db);
      const range = span.from === null || span.to === null ? "no rows" : `${timeText(span.from)} to ${timeText(span.to)}`;
      output.out(`No start of process ${pid}${at === null ? "" : ` near ${timeText(at)}`} is in the start log (${range}). The log has only the processes of the start trace.`);
      return 0;
    }
    const lines = found.slice(0, SHOWN).flatMap((start) => startLines(start, start.parents));
    if (found.length > SHOWN) lines.push(`${found.length - SHOWN} older starts of the pid are in the log. --json gives all of them.`);
    output.out(lines.join("\n"));
    return 0;
  } finally {
    db.close();
  }
}

type StartLogDb = ReturnType<typeof openStartLog>;

/** A slow step of the writer with its cause, and the state of the system in its minute (H199). */
export interface ExplainedSlowStep extends SlowStep {
  readonly cause: SlowCause;
  readonly context: SlowStepContext | null;
}

/** The most slow steps in the text of `--slow`. `--json` gives all of them. */
const SLOW_SHOWN = 50;

/**
 * This function gives the state of the system at a time: the nearest sample of each instance, at most 90 s away. It
 * gives `null` when no sample is near.
 */
export function contextAt(samples: readonly ResourceRow[], at: number): SlowStepContext | null {
  const nearest = new Map<string, ResourceRow>();
  for (const row of samples) {
    const distance = Math.abs(row.at - at);
    if (distance > SAMPLE_NEAR_MS) continue;
    const before = nearest.get(row.id);
    if (before === undefined || distance < Math.abs(before.at - at)) nearest.set(row.id, row);
  }
  if (nearest.size === 0) return null;
  const cpu = nearest.get("cpu");
  return {
    memoryFreeMb: nearest.get("memory")?.free ?? null,
    commitFreeMb: nearest.get("commit")?.free ?? null,
    coresUsed: cpu?.used ?? null,
    cores: cpu?.capacity ?? null,
    tracedPerMinute: nearest.get("procs:traced")?.used ?? null,
  };
}

/** This function writes a time in ms: with one decimal under 10 ms, else with the separators of thousands. */
function spreadMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms).toLocaleString("en-US")} ms`;
}

/** This function writes a spread: "61 ms at the median, 240 ms at p99 and 2,327 ms at most (12,400 starts)". */
function spreadText(spread: StartLogSpread, unit: string): string {
  return `${spreadMs(spread.p50)} at the median, ${spreadMs(spread.p99)} at p99 and ${spreadMs(spread.max)} at most (${spread.count.toLocaleString("en-US")} ${unit})`;
}

/** This function writes the lines of the spreads of a span. */
function spreadLines(spreads: StartLogSpreads, from: number): string[] {
  if (spreads.lag === null && spreads.write === null) return ["  The log has no histogram of this span. The writer writes the histograms of each 10 minutes."];
  const lines: string[] = [];
  if (spreads.lag !== null) lines.push(`  The time from the creation of a new process to its row on the disk: ${spreadText(spreads.lag, "starts")}.`);
  if (spreads.write !== null) lines.push(`  The time of a commit: ${spreadText(spreads.write, "commits")}.`);
  if (spreads.from !== null && spreads.from > from + 600_000) lines.push(`  The histograms start at ${timeText(spreads.from)}: the log has no older histogram.`);
  return lines;
}

/** This function writes the line of a slow step. */
function slowLine(step: ExplainedSlowStep): string {
  const lag = step.lagMs === null ? "" : `, lag ${step.lagMs.toLocaleString("en-US")} ms`;
  return `  ${timeText(step.at)}  ${step.kind} ${spreadMs(step.ms)}${lag}: ${step.cause.text}`;
}

/** This function runs `headroom starts --slow` (H199): the spreads of the span, and each slow step with its cause. */
function slowCommand(db: StartLogDb, hours: number, json: boolean, output: StartsOutput, sources: StartsSources): number {
  const to = (sources.now ?? Date.now)();
  const from = to - hours * HOUR_MS;
  const spreads = startLogSpreads(db, from, to);
  const steps = slowStepsBetween(db, from, to);
  const samples = steps.length === 0 ? [] : (sources.samples?.(from - SAMPLE_NEAR_MS, to + SAMPLE_NEAR_MS) ?? null);
  const explained: ExplainedSlowStep[] = steps.map((step) => {
    const context = samples === null ? null : contextAt(samples, step.at);
    return { ...step, cause: slowStepCause(step, context), context };
  });
  if (json) {
    output.out(JSON.stringify({ from, to, spreads, steps: explained }, null, 2));
    return 0;
  }
  const span = `${timeText(from).slice(0, 16)} to ${timeText(to).slice(11, 16)} UTC`;
  const lines = [`The start log over the last ${hours} h (${span}):`, ...spreadLines(spreads, from)];
  if (explained.length === 0) lines.push(`No step of the writer was slow (above ${START_LOG_SLOW_MS} ms).`);
  else {
    const what = explained.length === 1 ? "1 step of the writer was slow" : `${explained.length.toLocaleString("en-US")} steps of the writer were slow`;
    lines.push(`${what} (above ${START_LOG_SLOW_MS} ms, or a commit with a lag above it):`, ...explained.slice(-SLOW_SHOWN).map(slowLine));
    if (explained.length > SLOW_SHOWN) lines.push(`  ${explained.length - SLOW_SHOWN} older slow steps are in the span. --json gives all of them.`);
    if (samples === null) lines.push("The samples of the store were not read, so the state of the system in each minute is not known.");
  }
  output.out(lines.join("\n"));
  return 0;
}

/**
 * This function keeps the starts of the last 2 minutes before an unclean stop in a JSON file of `folder`. The log
 * deletes them after 24 hours. `before` is the start of the new daemon: each older row is from the daemon that
 * stopped. It gives the file and the count of starts, or `null` when the log has no start.
 */
export function writeStartsBeforeStop(path: string, folder: string, before: number): { readonly file: string; readonly starts: number } | null {
  if (!existsSync(path)) return null;
  const db = openStartLog(path);
  try {
    const last = (db.prepare("SELECT max(at) AS at FROM starts WHERE at < ?").get(before) as { at: number | null }).at;
    if (last === null) return null;
    const starts = startsBetween(db, last - BEFORE_STOP_MS, last);
    const file = join(folder, `starts-before-${new Date(last).toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, `${JSON.stringify({ from: last - BEFORE_STOP_MS, to: last, starts }, null, 2)}\n`);
    return { file, starts: starts.length };
  } finally {
    db.close();
  }
}
