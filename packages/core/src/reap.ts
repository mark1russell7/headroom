/**
 * The orphans that a session stops (H183).
 *
 * A reader program of a session can stay after its parent ends. One `grep.exe` read the transcript of a session. Its parent
 * ended, and it held 1.5 GB of private memory for 3.5 hours. No session knew that the process was its process.
 *
 * - `headroom reap` lists each process whose parent is proven gone (H182), with its memory, its age, its session and its
 *   command line.
 * - `headroom reap <pid>` stops a process of the session that asks. For a process of another session, it records a request
 *   and shows it as an alert. A process of a session that ended needs the owner of the machine.
 * - The shadow log records each process that an automatic rule stops in a later version. No rule stops a process in this
 *   version. The setting `reapAuto` exists for that later mode, and it is off.
 */

import { spanText } from "./forecast.ts";
import { commandText, type ProcessRecord } from "./orphans.ts";
import { isOrphan, processKey, programName, type SessionRef } from "./owners.ts";
import { sameStart } from "./peer.ts";
import type { ProcessInfo, SessionInfo } from "./types.ts";
import { diskSize } from "./units.ts";

/** The programs of the reader class (H183): they read files and keep what they read in memory. */
export const READER_PROGRAMS: ReadonlySet<string> = new Set(["grep", "rg", "sort", "findstr", "cat"]);
/** The private memory, in MB, above which a reader is in the shadow log (H183). */
export const SHADOW_MIN_MB = 500;
/** The time, in ms, for which a reader holds more than `SHADOW_MIN_MB` before it is in the shadow log (H183). */
export const SHADOW_MIN_MS: number = 30 * 60_000;
/** The time, in ms, for which the store keeps the rows of the shadow log and of the reap log (H183). */
export const REAP_KEEP_MS: number = 30 * 24 * 3_600_000;
/** The time, in ms, for which the alert of a reap request stays active (H183). The alert ends before when the process ends. */
export const REAP_NOTICE_MS: number = 24 * 3_600_000;
/** The longest command line in the text of a reap request, in characters (H183). */
export const REAP_COMMAND_MAX = 200;

/**
 * The kind of the standard output of a process (H183). A process that writes to a `file` is a writer. `unknown` means
 * that the sampler cannot read the kind, for example on Windows.
 */
export type StdoutKind = "file" | "pipe" | "terminal" | "null" | "socket" | "unknown";

/** One process whose parent is proven gone, for `headroom reap` (H183). */
export interface ReapCandidate {
  readonly pid: number;
  /** The start of the process from its record, in milliseconds since the epoch, or 0 when the read has no start. */
  readonly created: number;
  readonly name: string;
  readonly privateMb: number;
  /** The time since the start of the process, in ms, or `null` when the read has no start. */
  readonly ageMs: number | null;
  /** The owner from the record, without the label of an orphan. */
  readonly owner: string;
  /** The session from the record (H182), or `null` when no session started the process. */
  readonly session: string | null;
  readonly sessionId: string | null;
  /** The command line from the record, or `null` for a protected process. */
  readonly command: string | null;
}

/** One process that the automatic rule stops in a later version: a match of one sample (H183). */
export interface ShadowMatch extends ReapCandidate {
  /** The time of the first sample at which the process held more than `SHADOW_MIN_MB`. */
  readonly aboveSince: number;
  readonly stdout: StdoutKind;
}

/** One row of the shadow log (H183): one process over all the samples at which it matched the rule. */
export interface ShadowRow extends Omit<ShadowMatch, "ageMs"> {
  /** The first sample and the last sample at which the process matched the rule. */
  readonly firstAt: number;
  readonly lastAt: number;
  /** The count of the samples at which the process matched the rule. */
  readonly samples: number;
  /** The most private memory of the process at a sample that matched, in MB. */
  readonly peakMb: number;
}

/** The view of `headroom reap --shadow` (H183). */
export interface ShadowView {
  /** The setting `reapAuto`. In this version it stops no process. */
  readonly auto: boolean;
  readonly minMb: number;
  readonly minMs: number;
  readonly readers: readonly string[];
  /**
   * True when the sampler read the kind of the standard output of each row. When it is false, the writer rule did not
   * read the standard output of all the rows: the sampler has no such read, or the read of a row failed (`unknown`).
   */
  readonly stdoutKnown: boolean;
  /** The rows, the newest last match first. */
  readonly rows: readonly ShadowRow[];
}

/**
 * The step of `headroom reap <pid>` (H183):
 *
 * - `stop`: the process belongs to the session that asks.
 * - `ask`: the process belongs to another session that runs. headroom records a request to that session.
 * - `needs-owner`: no running session owns the process. It needs the owner of the machine.
 */
export type ReapStep = "stop" | "ask" | "needs-owner";

/** The action that `headroom reap <pid>` recorded (H183). */
export type ReapAction = "stopped" | "asked" | "needs-owner";

/**
 * The result of `headroom reap <pid>` (H183). The outcomes with no action are:
 *
 * - `not-found`: no process has the ID.
 * - `not-orphan`: the parent of the process is not proven gone.
 * - `session`: the process is the process of a session, or a `claude` program. `headroom reap` does not stop a session.
 * - `ended`: the process ended, or a new process has its ID, before the stop. headroom also stops nothing when it cannot
 *   read the start of the live process, or when the read of the processes has no start of the process.
 * - `failed`: the stop of an own process failed.
 * - `headroom`: the process is the headroom daemon, or the client of an active lease of `headroom run`.
 */
export type ReapOutcome = ReapAction | "not-found" | "not-orphan" | "session" | "headroom" | "ended" | "failed";

/** One row of the reap log (H183): a stop, a request to a session, or a process that needs the owner of the machine. */
export interface ReapEntry {
  readonly at: number;
  readonly pid: number;
  readonly created: number;
  readonly name: string;
  readonly session: string | null;
  readonly sessionId: string | null;
  /** The session that asked, or `null` when the caller is not a session. */
  readonly by: string | null;
  readonly byId: string | null;
  readonly action: ReapAction;
  readonly privateMb: number;
  readonly command: string | null;
  /** The result: `ok`, the error of a stop, or the text of the request. */
  readonly result: string;
}

/** The result of `resources.reap` (H183). */
export interface ReapResult {
  readonly pid: number;
  readonly outcome: ReapOutcome;
  /** The process, when the daemon has it. */
  readonly process: ReapCandidate | null;
  /** The text for the caller. */
  readonly message: string;
  /** The text of the request to the owner, for `asked` and `needs-owner`. */
  readonly notice: string | null;
}

/**
 * This function tells if a program is a Claude Code program (H183): `claude` or `claude.exe`. `headroom reap` does not
 * list or stop such a process, also when a read of the session files misses its session.
 */
export function isSessionProgram(name: string): boolean {
  return programName(name) === "claude";
}

/** This function tells if a program is of the reader class (H183): grep, rg, sort, findstr or cat. */
export function isReader(name: string): boolean {
  return READER_PROGRAMS.has(programName(name));
}

/**
 * This function tells if a command line names the files of a Claude Code session (H183). Such a file is under
 * `.claude/projects` (a transcript `.jsonl` or its folder), or in a `scratchpad` folder under a `claude` folder. The test
 * ignores the case and the type of slash.
 */
export function namesSessionFiles(command: string): boolean {
  const text = command.replaceAll("\\", "/").toLowerCase();
  return text.includes("/.claude/projects") || /\/claude\/(?:[^/\s"']+\/)*scratchpad(?=$|[/\s"'])/.test(text);
}

/**
 * This function tells if a command line writes its output to a file by an argument (H183): `sort -o <file>` or
 * `sort --output=<file>`. A redirect of the shell is not in the command line. The kind of the standard output shows it.
 */
export function writesFile(command: string): boolean {
  const [program = "", ...args] = command.trim().split(/\s+/);
  if (programName(program) !== "sort") return false;
  return args.some((arg) => arg === "-o" || arg.startsWith("--output") || /^-[a-z]*o/.test(arg));
}

/**
 * This function gives the kind of a standard output from the target of the link `/proc/<pid>/fd/1` on Linux (H183). A path
 * that is not a device is a `file`. An empty text is `unknown`.
 */
export function stdoutKindOf(link: string): StdoutKind {
  if (link.startsWith("pipe:")) return "pipe";
  if (link.startsWith("socket:")) return "socket";
  if (link === "/dev/null") return "null";
  if (link.startsWith("/dev/pts/") || link.startsWith("/dev/tty") || link === "/dev/console") return "terminal";
  if (link.startsWith("/dev/") || !link.startsWith("/")) return "unknown";
  return "file";
}

/** This function gives the candidate of a process and its record (H183). */
export function reapCandidate(info: ProcessInfo, record: ProcessRecord, now: number): ReapCandidate {
  return {
    pid: info.pid,
    created: record.created,
    name: info.name,
    privateMb: Math.round(info.privateMb),
    ageMs: info.startedAt === undefined ? null : Math.max(0, now - info.startedAt),
    owner: record.owner,
    session: record.session,
    sessionId: record.sessionId,
    command: record.command,
  };
}

/**
 * This function lists the processes whose parent is proven gone (H183), the most private memory first. A process with no
 * record is not in the list, because no record proves its owner. By default the list has only the processes of a session.
 * `all` also lists the orphans that no session started. The processes of `sessionPids` and a `claude` program are not in
 * the list. The engine gives the processes of the sessions, the daemon and the clients of the active leases.
 */
export function reapCandidates(
  processes: readonly ProcessInfo[],
  recordOf: (info: ProcessInfo) => ProcessRecord | undefined,
  now: number,
  all = false,
  sessionPids: ReadonlySet<number> = new Set(),
): ReapCandidate[] {
  const byPid = new Map(processes.map((info) => [info.pid, info]));
  const children = childIndex(processes);
  const list: ReapCandidate[] = [];
  for (const info of processes) {
    if (info.pid === 0 || sessionPids.has(info.pid) || isSessionProgram(info.name)) continue;
    const record = recordOf(info);
    if (record === undefined || !isOrphan(info, byPid, record)) continue;
    if (!all && record.session === null) continue;
    if (hostsKeptIn(children, info, sessionPids)) continue;
    list.push(reapCandidate(info, record, now));
  }
  return list.sort((a, b) => b.privateMb - a.privateMb);
}

/** This function gives the children of each process ID of a read. */
function childIndex(processes: readonly ProcessInfo[]): ReadonlyMap<number, readonly ProcessInfo[]> {
  const children = new Map<number, ProcessInfo[]>();
  for (const info of processes) {
    if (info.pid === 0 || info.pid === info.ppid) continue;
    const list = children.get(info.ppid);
    if (list === undefined) children.set(info.ppid, [info]);
    else list.push(info);
  }
  return children;
}

/** This function walks down from `target` (see `hostsKept()`). */
function hostsKeptIn(children: ReadonlyMap<number, readonly ProcessInfo[]>, target: ProcessInfo, kept: ReadonlySet<number>): boolean {
  const seen = new Set<number>([target.pid]);
  const stack: ProcessInfo[] = [target];
  for (let parent = stack.pop(); parent !== undefined; parent = stack.pop()) {
    for (const child of children.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      // A child that started before its parent has a reused parent ID: it is not a child. An unknown start proves no
      // order, so the child counts: a false keep is safe, and a false stop is not.
      if (parent.startedAt !== undefined && child.startedAt !== undefined && child.startedAt + 1 < parent.startedAt) continue;
      seen.add(child.pid);
      if (kept.has(child.pid) || isSessionProgram(child.name)) return true;
      stack.push(child);
    }
  }
  return false;
}

/**
 * This function tells if a process that must stay runs below `target` (H183): a process of `kept` (the sessions, the
 * daemon and the clients of the active leases) or a `claude` program. A stop of `target` can end it: for example, a stop
 * of a terminal closes its consoles and the sessions in them. Thus headroom reap does not stop or list such a process.
 */
export function hostsKept(target: ProcessInfo, processes: readonly ProcessInfo[], kept: ReadonlySet<number>): boolean {
  return hostsKeptIn(childIndex(processes), target, kept);
}

/**
 * This function tells if a process belongs to the session of the caller (H183). When the record has the ID of a session,
 * only the same ID of the caller proves it. When only the caller has an ID, the record does not prove the session: a new
 * session can have the name of a session that ended. Only when neither has an ID, the names decide.
 */
export function ownSession(record: Pick<ProcessRecord, "session" | "sessionId">, caller: SessionRef | null): boolean {
  if (caller === null || record.session === null) return false;
  if (record.sessionId !== null) return caller.id !== "" && record.sessionId === caller.id;
  if (caller.id !== "") return false;
  return caller.name !== "" && record.session === caller.name;
}

/**
 * This function tells if a running session is the session of the caller (H183). When the session has an ID, only the same
 * ID of the caller proves it. Else the names decide.
 */
function isCaller(session: SessionInfo, caller: SessionRef): boolean {
  if (session.sessionId !== "") return caller.id !== "" && session.sessionId === caller.id;
  return caller.name !== "" && session.name === caller.name;
}

/**
 * This function finds the running session of a record (H183). A session runs when its session file names a live process
 * with the same start. An unknown start matches each start.
 *
 * When the record and the session file have an ID, the IDs decide. Otherwise the names decide, and the process of the
 * session must have started at or before the process of the record. A session that started later is a new session with
 * the name of a session that ended. A record or a process with no start cannot prove the order, so it has no session.
 */
export function liveSession(
  record: Pick<ProcessRecord, "session" | "sessionId" | "created">,
  sessions: readonly SessionInfo[],
  processes: readonly ProcessInfo[],
): SessionInfo | undefined {
  if (record.session === null) return undefined;
  const byPid = new Map(processes.map((info) => [info.pid, info]));
  return sessions.find((session) => {
    const info = byPid.get(session.pid);
    if (info === undefined || !sameStart(info.startedAt, session.startedAt)) return false;
    if (record.sessionId !== null && session.sessionId !== "") return session.sessionId === record.sessionId;
    return session.name === record.session && record.created > 0 && info.startedAt !== undefined && info.startedAt <= record.created + 1;
  });
}

/**
 * This function gives the step of `headroom reap <pid>` for a proven orphan (H183). `owner` is the running session of the
 * record (`liveSession()`). Only when that session is the session of the caller, the step is a stop.
 */
export function reapStep(record: Pick<ProcessRecord, "session" | "sessionId">, caller: SessionRef | null, owner: SessionInfo | undefined): ReapStep {
  if (owner === undefined) return "needs-owner";
  // A record with no ID cannot prove its session to a caller with an ID: two running sessions can have one name, and a
  // new session can have the name of a session that ended. Then only the owner of the machine stops the process.
  if (record.sessionId === null && caller !== null && caller.id !== "") return "needs-owner";
  if (caller !== null && isCaller(owner, caller) && ownSession(record, caller)) return "stop";
  return "ask";
}

/**
 * This function gives the text of a reap request (H183). The text has the process, its memory, its age and its command
 * line. Then it has the request to its session or to the owner of the machine.
 */
export function reapNotice(process: ReapCandidate, step: Exclude<ReapStep, "stop">, by: SessionRef | null): string {
  const age = process.ageMs === null ? "" : ` It started ${spanText(process.ageMs / 60_000)} ago.`;
  const command = process.command === null ? "" : ` Command: ${commandText(process.command, REAP_COMMAND_MAX)}.`;
  const what = `${process.name} (pid ${process.pid}) holds ${diskSize(process.privateMb)} of private memory, and its parent ended.${age}${command}`;
  const from = by === null ? "A caller with no session" : `The session ${by.name}`;
  if (step === "ask") return `${what} ${from} asks the session ${process.session ?? ""} to stop it with: headroom reap ${process.pid}`;
  const owner =
    process.session === null
      ? "No session started it"
      : process.sessionId === null
        ? `Its record names the session ${process.session} with no ID, and no session can prove that the process is its own`
        : `Its session ${process.session} does not run`;
  return `${what} ${owner}, so it needs the owner of the machine. ${from} asked for the stop.`;
}

/**
 * The tracker of the shadow log (H183). The engine gives it each read of the processes. It keeps, for each reader above
 * `SHADOW_MIN_MB`, the time of the first read above. A read below the line starts the time again.
 *
 * A process matches the rule when all of these are true:
 *
 * - Its parent is proven gone (H182).
 * - Its program is of the reader class.
 * - Its command line names a transcript or a scratchpad folder of a session.
 * - It held more than `SHADOW_MIN_MB` of private memory for more than `SHADOW_MIN_MS`.
 * - It is not a writer: its standard output is not a file, and no argument names an output file.
 */
export class ShadowTracker {
  /** The first read above the line of each reader, by `processKey()`. */
  readonly #above = new Map<string, number>();

  /** This function gives the matches of one read of the processes, and forgets the processes below the line. */
  sample(
    now: number,
    processes: readonly ProcessInfo[],
    recordOf: (info: ProcessInfo) => ProcessRecord | undefined,
    stdoutOf: (pid: number) => StdoutKind,
  ): ShadowMatch[] {
    const byPid = new Map(processes.map((info) => [info.pid, info]));
    const live = new Set<string>();
    const matches: ShadowMatch[] = [];
    for (const info of processes) {
      if (info.pid === 0 || info.privateMb <= SHADOW_MIN_MB || !isReader(info.name)) continue;
      const key = processKey(info);
      live.add(key);
      const aboveSince = this.#above.get(key) ?? now;
      this.#above.set(key, aboveSince);
      if (now - aboveSince <= SHADOW_MIN_MS) continue;
      const record = recordOf(info);
      if (record === undefined || record.command === null || !isOrphan(info, byPid, record)) continue;
      if (!namesSessionFiles(record.command) || writesFile(record.command)) continue;
      // The sampler reads the kind of the standard output only for a process that matches the other parts of the rule.
      const stdout = stdoutOf(info.pid);
      if (stdout === "file") continue;
      matches.push({ ...reapCandidate(info, record, now), aboveSince, stdout });
    }
    for (const key of this.#above.keys()) if (!live.has(key)) this.#above.delete(key);
    return matches;
  }

  /** This function forgets all the times, for example after a sleep of the computer. */
  clear(): void {
    this.#above.clear();
  }
}
