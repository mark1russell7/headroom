/**
 * The `headroom job <name|id> [--holder <h>] [--all] [--json]` command (H26): the state of a job of `headroom run`.
 *
 * A job of `headroom run` can run after the shell that started it stops. A session or the fleet sweep uses this command
 * to see if the job is queued, running or exited, and with which exit code.
 */

import { parseArgs } from "node:util";
import { countText, diskSize, spawnClassText, type JobState } from "@headroom/core";
import type { Connection } from "./client.ts";

/** The exit code of `headroom job` when no job matches the query. */
export const NO_JOB = 3;

export const JOB_USAGE = "headroom job <name|id> [--holder <h>] [--all] [--json]";

/** The outputs of the command. The tests replace them. */
export interface JobOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly now: () => number;
}

const CONSOLE: JobOutput = { out: (text) => console.log(text), err: (text) => console.error(text), now: Date.now };

/** This function writes a time span: "40 s", "12 min" or "2 h 5 min". */
export function span(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** This function writes a time as the local clock, with the local date before it when the day is not the day of `now`. */
function clockOf(at: string, now: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = (each: Date): string => `${each.getFullYear()}-${pad(each.getMonth() + 1)}-${pad(each.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return day(date) === day(new Date(now)) ? time : `${day(date)} ${time}`;
}

/**
 * This function gives the line of one job, for example "e2e (3f2a9c1e) of graph: exited with code 1 at 17:42, waited 12
 * min, ran 6 min, normal (no past runs)." It ends with the spawn class of the job (H47).
 */
export function jobLine(state: JobState, now: number): string {
  const parts: string[] = [];
  if (state.state === "queued") {
    parts.push(`queued since ${clockOf(state.queuedAt, now)}`, `waited ${span(state.waitedMs)}${state.reason === null ? "" : ` (${state.reason})`}`);
  } else if (state.state === "running") {
    parts.push(`running since ${clockOf(state.startedAt ?? state.queuedAt, now)}`, `waited ${span(state.waitedMs)}`, `ran ${span(state.ranMs ?? 0)} so far`);
  } else {
    const at = state.endedAt === null ? "" : ` at ${clockOf(state.endedAt, now)}`;
    const how =
      state.exitCode !== null
        ? `exited with code ${state.exitCode}${at}`
        : state.signal !== null
          ? `exited with signal ${state.signal}${at}`
          : `ended${at} with no exit code${state.reason === null ? "" : ` (${state.reason})`}`;
    parts.push(how, `waited ${span(state.waitedMs)}`, state.ranMs === null ? "did not start" : `ran ${span(state.ranMs)}`);
  }
  if (state.peakMb !== null) parts.push(`peak ${diskSize(state.peakMb)}`);
  // H29: the processes that the job started, from its job object. A daemon of an older version gives none.
  if (typeof state.processes === "number") parts.push(`${countText(state.processes)} ${state.processes === 1 ? "process" : "processes"} started`);
  // H47: the peak starts in one minute and the spawn class. A daemon of an older version gives neither.
  if (typeof state.peakStartsPerMin === "number") parts.push(`at most ${countText(state.peakStartsPerMin)} starts a minute`);
  if (state.spawn !== null && state.spawn !== undefined) parts.push(spawnClassText(state.spawn));
  const log = state.log === null ? "" : ` Log: ${state.log}`;
  return `${state.job} (${state.id.slice(0, 8)}) of ${state.holder}: ${parts.join(", ")}.${log}`;
}

/**
 * This function runs `headroom job`. It gives 0 when a job matches, 3 when no job matches, 2 for a wrong use and 1
 * when the daemon does not run. With `--json`, it writes the state of the job, or a list with `--all`.
 */
export async function jobCommand(argv: readonly string[], connection: Connection | null, io: JobOutput = CONSOLE): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { holder: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } },
  });
  const [query] = positionals;
  if (query === undefined || positionals.length > 1) {
    io.err(`Usage: ${JOB_USAGE}`);
    return 2;
  }
  const json = values.json === true;
  const all = values.all === true;
  if (!connection) {
    if (json) io.out(JSON.stringify({ error: "headroom does not run", query }));
    else io.err("headroom does not run. Start it with: headroom service install");
    return 1;
  }
  const jobs = await connection.call<JobState[]>(["resources", "job"], { query, all, ...(values.holder === undefined ? {} : { holder: values.holder }) });
  const [latest] = jobs;
  if (latest === undefined) {
    if (json) io.out(JSON.stringify({ error: "no job", query }, null, 2));
    else io.err(`headroom: no job matches "${query}"${values.holder === undefined ? "" : ` of the holder ${values.holder}`}.`);
    return NO_JOB;
  }
  if (json) io.out(JSON.stringify(all ? jobs : latest, null, 2));
  else for (const each of all ? jobs : [latest]) io.out(jobLine(each, io.now()));
  return 0;
}
