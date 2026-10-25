/**
 * The `headroom cancel <id> | --job <name> [--holder <h>] [--all] [--json]` command: it takes a waiting lease off the queue.
 *
 * A session can leave a queued job of `headroom run` behind, for example after its subagent ended. With this command, the
 * job does not start, and its waiting client exits with code 75. A granted lease does not change: `headroom release` ends it.
 */

import { parseArgs } from "node:util";
import { MIN_ID_PREFIX, type CancelResult, type Lease } from "@headroom/core";
import type { Connection } from "./client.ts";
import { NO_JOB } from "./job-cli.ts";

export const CANCEL_USAGE = "headroom cancel <id> | --job <name> [--holder <h>] [--all] [--json]";

/** The exit code of `headroom cancel` when more than one waiting job matches, or when the match runs. */
export const NOT_CANCELLED = 1;

/** The outputs of the command. The tests replace them. */
export interface CancelOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const CONSOLE: CancelOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };

/** This function writes a lease in one line: "pnpm test (3f2a9c1e) of graph". */
function leaseText(lease: Lease): string {
  return `${lease.job} (${lease.id.slice(0, 8)}) of ${lease.holder}`;
}

/**
 * This function runs `headroom cancel`. `by` is who cancels: the holder of the caller, or "cli". It gives 0 when a waiting
 * lease left the queue, or when the match ended already. It gives 3 when no lease matches. It gives 1 for more than one
 * waiting match, for a running match, or when the daemon does not run. It gives 2 for a wrong use.
 */
export async function cancelCommand(argv: readonly string[], connection: Connection | null, by: string, io: CancelOutput = CONSOLE): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { job: { type: "string" }, holder: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } },
  });
  const [id] = positionals;
  if (positionals.length > 1 || (id === undefined) === (values.job === undefined)) {
    io.err(`Usage: ${CANCEL_USAGE}`);
    return 2;
  }
  if (id !== undefined && id.length < MIN_ID_PREFIX) {
    io.err(`headroom: give the lease id or its first ${MIN_ID_PREFIX} characters or more, not ${id}.`);
    return 2;
  }
  if (!connection) {
    io.err("headroom does not run. Start it with: headroom service install");
    return 1;
  }
  const query = id === undefined ? { job: values.job } : { id };
  const holder = values.holder === undefined ? {} : { holder: values.holder };
  const result = await connection.call<CancelResult>(["resources", "cancel"], { ...query, ...holder, all: values.all === true, by });
  const code = exitOf(result);
  if (values.json === true) {
    io.out(JSON.stringify(result, null, 2));
    return code;
  }
  const what = `"${id ?? values.job ?? ""}"${values.holder === undefined ? "" : ` of the holder ${values.holder}`}`;
  for (const line of cancelLines(result, what)) (line.error ? io.err : io.out)(line.text);
  return code;
}

/** The exit code of `headroom run` when its job did not start: its wait ended, its lease ended, or `headroom cancel` took it. */
export const NOT_STARTED = 75;

/**
 * This function gives the line of `headroom run` for a lease that ended before its job started. After `headroom cancel`,
 * it names who cancelled. A daemon of an older version gives no name.
 */
export function notStartedLine(job: string, lease: Lease): string {
  if (lease.state === "cancelled" && lease.cancelledBy !== undefined) return `headroom: ${job} was cancelled by ${lease.cancelledBy} before it started. Nothing ran.`;
  return `headroom: the lease ended before the job started: ${lease.reason ?? lease.state}`;
}

/** This function gives the exit code of a result of `resources.cancel`. */
export function exitOf(result: CancelResult): number {
  if (result.cancelled.length > 0) return 0;
  if (result.matches.length === 0) return NO_JOB;
  const active = result.matches.filter((lease) => lease.state === "waiting" || lease.state === "granted");
  return active.length === 0 ? 0 : NOT_CANCELLED;
}

/** This function gives the lines of a result of `resources.cancel`. `what` names the query, for example "\"pnpm test\"". */
export function cancelLines(result: CancelResult, what: string): { readonly text: string; readonly error: boolean }[] {
  const lines: { text: string; error: boolean }[] = [];
  const running = result.matches.filter((lease) => lease.state === "granted");
  const runs = (lease: Lease): string =>
    `headroom: ${leaseText(lease)} runs, so headroom cancel does not take it. headroom release ${lease.id} ends its lease, but the job does not stop.`;
  if (result.cancelled.length > 0) {
    for (const lease of result.cancelled) {
      lines.push({ text: `Cancelled ${leaseText(lease)}. It did not start, and its headroom run exits with code 75.`, error: false });
    }
    for (const lease of running) lines.push({ text: runs(lease), error: true });
    return lines;
  }
  if (result.matches.length === 0) return [{ text: `headroom: no waiting job matches ${what}.`, error: true }];
  const waiting = result.matches.filter((lease) => lease.state === "waiting");
  if (waiting.length > 1) {
    lines.push({ text: `headroom: ${waiting.length} waiting jobs match ${what}, so none is cancelled. Give the id of one, or --all to cancel each:`, error: true });
    for (const lease of waiting) lines.push({ text: `  ${lease.id}  ${leaseText(lease)}, ${lease.reason ?? "waiting"}`, error: true });
    return lines;
  }
  if (running.length > 0) return running.map((lease) => ({ text: runs(lease), error: true }));
  const [ended] = result.matches;
  if (ended === undefined) return lines;
  const reason = ended.reason === null ? "" : ` (${ended.reason})`;
  return [{ text: `${leaseText(ended)} ended already: ${ended.state}${reason}. Nothing waits.`, error: false }];
}
