/**
 * The holder of a lease: the Claude Code session that starts a job.
 *
 * Claude Code gives each command the variables `CLAUDE_PID` and `CLAUDE_CODE_SESSION_ID`. They name the
 * session also when a shell between the session and the job stopped. A stopped shell breaks the process tree.
 */

import { sameStart, startedFirst, type ProcessLink, type SessionInfo, type SessionRef } from "@headroom/core";

/** This function gives the start of a live process, or `undefined` when the process does not run. */
export type StartOf = (pid: number) => number | undefined;

/**
 * This function finds the session file that the variables of Claude Code name, or gives `undefined`. The session ID comes
 * first, because a process ID can be in use again after its process ends.
 *
 * With `startOf`, the session must also run: its process must be live, with the start of its session file. A session file
 * with no start matches each start. A `CLAUDE_PID` whose session file has another session ID than `CLAUDE_CODE_SESSION_ID`
 * is a process ID that is in use again, so it gives `undefined`.
 */
function envSession(env: Readonly<Record<string, string | undefined>>, sessions: readonly SessionInfo[], startOf?: StartOf): SessionInfo | undefined {
  const runs = (session: SessionInfo): boolean => {
    if (startOf === undefined) return true;
    const start = startOf(session.pid);
    return start !== undefined && sameStart(start, session.startedAt);
  };
  const id = env["CLAUDE_CODE_SESSION_ID"];
  if (id) {
    const byId = sessions.find((each) => each.sessionId === id);
    if (byId !== undefined) return runs(byId) ? byId : undefined;
  }
  const pid = Number(env["CLAUDE_PID"]);
  const byPid = Number.isInteger(pid) && pid > 0 ? sessions.find((each) => each.pid === pid) : undefined;
  if (byPid === undefined || !runs(byPid)) return undefined;
  if (startOf !== undefined && id && byPid.sessionId !== "" && byPid.sessionId !== id) return undefined;
  return byPid;
}

/** This function finds the session that the variables of Claude Code name, or gives `undefined`. */
export function sessionFromEnv(env: Readonly<Record<string, string | undefined>>, sessions: readonly SessionInfo[]): string | undefined {
  return envSession(env, sessions)?.name || undefined;
}

/**
 * This function finds the session that the variables of Claude Code name, with the ID of its session file (H183), or gives
 * `undefined`. `headroom reap` compares the ID with the session of a process. With `startOf`, the process of the session
 * must run with the start of its session file.
 */
export function sessionRefFromEnv(env: Readonly<Record<string, string | undefined>>, sessions: readonly SessionInfo[], startOf?: StartOf): SessionRef | undefined {
  const session = envSession(env, sessions, startOf);
  return session === undefined || session.name === "" ? undefined : { name: session.name, id: session.sessionId };
}

/**
 * This function finds the session of a process by a walk up the process tree (H183), or gives `undefined`. Each parent must
 * start at or before its child (H29), so a process ID that is in use again stops the walk. An unknown start also stops
 * the walk. The process of the session must have the start of its session file.
 */
export function sessionRefFromTree(selfPid: number, processes: readonly ProcessLink[], sessions: readonly SessionInfo[]): SessionRef | undefined {
  const byPid = new Map(processes.map((info) => [info.pid, info]));
  const byProcess = new Map(sessions.map((session) => [session.pid, session]));
  const seen = new Set<number>();
  let at = byPid.get(selfPid);
  while (at !== undefined && !seen.has(at.pid)) {
    seen.add(at.pid);
    const session = byProcess.get(at.pid);
    if (session !== undefined && session.name !== "" && sameStart(at.startedAt, session.startedAt)) return { name: session.name, id: session.sessionId };
    const parent = byPid.get(at.ppid);
    at = parent !== undefined && startedFirst(parent, at) ? parent : undefined;
  }
  return undefined;
}
