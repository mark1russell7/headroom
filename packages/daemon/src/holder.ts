/**
 * The holder of a lease: the Claude Code session that starts a job.
 *
 * Claude Code gives each command the variables `CLAUDE_PID` and `CLAUDE_CODE_SESSION_ID`. They name the
 * session also when a shell between the session and the job stopped. A stopped shell breaks the process tree.
 */

import type { SessionInfo, SessionRef } from "@headroom/core";

/** This function finds the session file that the variables of Claude Code name, or gives `undefined`. */
function envSession(env: Readonly<Record<string, string | undefined>>, sessions: readonly SessionInfo[]): SessionInfo | undefined {
  const pid = Number(env["CLAUDE_PID"]);
  const id = env["CLAUDE_CODE_SESSION_ID"];
  return sessions.find((each) => each.pid === pid) ?? (id ? sessions.find((each) => each.sessionId === id) : undefined);
}

/** This function finds the session that the variables of Claude Code name, or gives `undefined`. */
export function sessionFromEnv(env: Readonly<Record<string, string | undefined>>, sessions: readonly SessionInfo[]): string | undefined {
  return envSession(env, sessions)?.name || undefined;
}

/**
 * This function finds the session that the variables of Claude Code name, with the ID of its session file (H183), or gives
 * `undefined`. `headroom reap` compares the ID with the session of a process.
 */
export function sessionRefFromEnv(env: Readonly<Record<string, string | undefined>>, sessions: readonly SessionInfo[]): SessionRef | undefined {
  const session = envSession(env, sessions);
  return session === undefined || session.name === "" ? undefined : { name: session.name, id: session.sessionId };
}
