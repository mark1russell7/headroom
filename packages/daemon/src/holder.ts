/**
 * The holder of a lease: the Claude Code session that starts a job.
 *
 * Claude Code gives each command the variables `CLAUDE_PID` and `CLAUDE_CODE_SESSION_ID`. They name the
 * session also when a shell between the session and the job stopped. A stopped shell breaks the process tree.
 */

import type { SessionInfo } from "@headroom/core";

/** This function finds the session that the variables of Claude Code name, or gives `undefined`. */
export function sessionFromEnv(env: Readonly<Record<string, string | undefined>>, sessions: readonly SessionInfo[]): string | undefined {
  const pid = Number(env["CLAUDE_PID"]);
  const id = env["CLAUDE_CODE_SESSION_ID"];
  const session = sessions.find((each) => each.pid === pid) ?? (id ? sessions.find((each) => each.sessionId === id) : undefined);
  return session?.name || undefined;
}
