/**
 * The `headroom reap` command (H183): the processes whose parent is proven gone (H182).
 *
 * - `headroom reap [--all] [--json]` lists them, with the private memory, the age, the session and the command line.
 * - `headroom reap <pid> [--json]` stops a process of the session of the caller. For a process of another session, it
 *   records a request and shows it as an alert. It does not stop it.
 * - `headroom reap --shadow [--json]` shows the shadow log: the processes that an automatic rule stops in a later version.
 * - `headroom reap --log [--json]` shows the stops and the requests.
 *
 * headroom has no path that sends a notice to one session. A request goes to the reap log and to `headroom alerts`.
 */

import { parseArgs } from "node:util";
import { commandText, diskSize, ownSession, spanText, type ReapCandidate, type ReapEntry, type ReapResult, type SessionRef, type ShadowView } from "@headroom/core";
import type { Connection } from "./client.ts";

export const REAP_USAGE = "headroom reap [--all] [--json] | headroom reap <pid> [--json] | headroom reap --shadow [--json] | headroom reap --log [--json]";

/** The exit code of `headroom reap <pid>` when no process has the ID. */
export const NO_PROCESS = 3;

/** The longest command line in a line of `headroom reap`, in characters. */
const LINE_COMMAND_MAX = 100;

/** The outputs of the command. The tests replace them. */
export interface ReapOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const CONSOLE: ReapOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };

/** This function writes a time as UTC to the minute: "2026-11-15 10:02Z". */
function when(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/** This function writes the age of a process, or "?" when the read has no start. */
function ageText(ms: number | null): string {
  return ms === null ? "?" : spanText(ms / 60_000);
}

/** This function writes the session of a process, with "(yours)" for a process of the caller. */
function sessionText(each: Pick<ReapCandidate, "session" | "sessionId">, caller: SessionRef | null): string {
  if (each.session === null) return "(no session)";
  return ownSession(each, caller) ? `${each.session} (yours)` : each.session;
}

/** This function gives the lines of the list of `headroom reap` (H183). */
export function reapListLines(list: readonly ReapCandidate[], caller: SessionRef | null, all: boolean): string[] {
  if (list.length === 0) return [all ? "No process has a parent that is proven gone." : "No process of a session has a parent that is proven gone."];
  const lines = [`${list.length} ${list.length === 1 ? "process has" : "processes have"} a parent that is proven gone. headroom reap <pid> stops a process of your session.`];
  lines.push(`  ${"PID".padEnd(8)} ${"PRIVATE".padStart(8)}  ${"AGE".padEnd(12)} ${"SESSION".padEnd(24)} COMMAND`);
  for (const each of list) {
    const command = each.command === null ? each.name : commandText(each.command, LINE_COMMAND_MAX);
    lines.push(`  ${String(each.pid).padEnd(8)} ${diskSize(each.privateMb).padStart(8)}  ${ageText(each.ageMs).padEnd(12)} ${sessionText(each, caller).padEnd(24)} ${command}`);
  }
  return lines;
}

/** This function gives the lines of `headroom reap --shadow` (H183). */
export function shadowLines(view: ShadowView): string[] {
  const lines = [
    `Automatic reap: ${view.auto ? "on" : "off"}. In this version no rule stops a process. The daemon only writes this shadow log.`,
    `The rule: a reader (${view.readers.join(", ")}) whose parent is proven gone, whose command names a transcript or a scratchpad`,
    `folder of a session, and that holds more than ${diskSize(view.minMb)} of private memory for more than ${spanText(view.minMs / 60_000)}. A writer is not in the log.`,
  ];
  if (!view.stdoutKnown) {
    lines.push("The kind of the standard output is not known for each process (stdout unknown). For such a process, the writer test reads only the arguments (sort -o).");
  }
  if (view.rows.length === 0) return [...lines, "The shadow log is empty."];
  lines.push(`${view.rows.length} ${view.rows.length === 1 ? "process" : "processes"} in the shadow log, the newest first:`);
  for (const row of view.rows) {
    const command = row.command === null ? row.name : commandText(row.command, LINE_COMMAND_MAX);
    const span = `${when(row.firstAt)} to ${when(row.lastAt)}`;
    lines.push(`  ${String(row.pid).padEnd(8)} peak ${diskSize(row.peakMb).padStart(8)}  ${row.samples} samples, ${span}  ${sessionText(row, null)}  stdout ${row.stdout}`);
    lines.push(`           ${command}`);
  }
  return lines;
}

/** This function gives the lines of `headroom reap --log` (H183). */
export function reapLogLines(entries: readonly ReapEntry[]): string[] {
  if (entries.length === 0) return ["The reap log is empty."];
  return entries.map((each) => {
    const session = each.session === null ? "no session" : `session ${each.session}`;
    const by = each.by === null ? "a caller with no session" : each.by;
    return `  ${when(each.at)}  ${each.action.padEnd(11)} ${`${each.name} (${each.pid})`.padEnd(22)} ${diskSize(each.privateMb).padStart(8)}  ${session}, by ${by}: ${each.result}`;
  });
}

/** This function gives the exit code of a result of `resources.reap`. */
export function reapExit(result: ReapResult): number {
  if (result.outcome === "not-found") return NO_PROCESS;
  return result.outcome === "stopped" || result.outcome === "asked" || result.outcome === "needs-owner" ? 0 : 1;
}

/**
 * This function runs `headroom reap`. `caller` is the session of the caller, or `null`. It gives 0 for a list, a stop, a
 * request or a record. It gives 3 when no process has the ID. It gives 1 for a process whose parent is not proven gone,
 * and for a process of a session or of headroom. It also gives 1 for a failed stop, or when the daemon does not run. It
 * gives 2 for a wrong use. A process ID has only the digits 0 to 9, so `0x10` and `1e3` are a wrong use.
 */
export async function reapCommand(argv: readonly string[], connection: Connection | null, caller: SessionRef | null, io: ReapOutput = CONSOLE): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch {
    io.err(`Usage: ${REAP_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [target] = positionals;
  const modes = [target !== undefined, values.shadow === true, values.log === true].filter(Boolean).length;
  const pid = target === undefined ? 0 : /^\d+$/.test(target) ? Number(target) : Number.NaN;
  if (positionals.length > 1 || modes > 1 || (target !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) || (values.all === true && modes > 0)) {
    io.err(`Usage: ${REAP_USAGE}`);
    return 2;
  }
  if (!connection) {
    io.err("headroom does not run. Start it with: headroom service install");
    return 1;
  }
  const json = values.json === true;
  if (values.shadow === true) {
    const view = await connection.call<ShadowView>(["resources", "reapShadow"], {});
    for (const line of json ? [JSON.stringify(view, null, 2)] : shadowLines(view)) io.out(line);
    return 0;
  }
  if (values.log === true) {
    const entries = await connection.call<ReapEntry[]>(["resources", "reapLog"], {});
    for (const line of json ? [JSON.stringify(entries, null, 2)] : reapLogLines(entries)) io.out(line);
    return 0;
  }
  if (target === undefined) {
    const all = values.all === true;
    const list = await connection.call<ReapCandidate[]>(["resources", "reapList"], { all });
    for (const line of json ? [JSON.stringify(list, null, 2)] : reapListLines(list, caller, all)) io.out(line);
    return 0;
  }
  const result = await connection.call<ReapResult>(["resources", "reap"], { pid, caller });
  const code = reapExit(result);
  if (json) {
    io.out(JSON.stringify(result, null, 2));
    return code;
  }
  (code === 0 ? io.out : io.err)(result.message);
  if (result.notice !== null) {
    io.out("headroom has no path that sends a notice to one session. It recorded the request in the reap log. The text that it sends:");
    io.out(`  ${result.notice}`);
  }
  return code;
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { all: { type: "boolean" }, shadow: { type: "boolean" }, log: { type: "boolean" }, json: { type: "boolean" } },
  });
}
