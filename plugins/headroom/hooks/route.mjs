// @ts-check
/**
 * The hook of headroom (H8): a PreToolUse hook for the Bash and PowerShell tools of Claude Code.
 *
 * - A heavy command (tests, builds, Playwright, Docker builds, recursive pnpm) that does not run under
 *   `headroom run` goes on only when the memory has room for it.
 * - When the memory is tight, the hook refuses the command and tells the session the form under a
 *   lease: `headroom run --mem auto -- <command>`. The session sends that form, and the permission
 *   rules of the user apply to it as to each command. The hook never approves a command itself.
 * - When the daemon does not answer, or the command is light, the hook writes nothing: the command goes on.
 *
 * It uses no package, and it gives up after 1 second, so a session does not wait for it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The commands that need a lease: the test runners, the builds, the browsers and the container builds. */
export const HEAVY = [
  /\b(?:pnpm|npm|yarn|bun)\s+(?:-[\w-]+\s+)*(?:run\s+)?(?:test|tests|build|e2e|typecheck|check|coverage)\b/,
  /\b(?:pnpm|npm|yarn)\s+(?:-r|--recursive|-ws|--workspaces)\b/,
  /\bvitest\b(?!\s+--version)/,
  /\bjest\b/,
  /\bplaywright\s+test\b/,
  /\btsc\s+(?:-b|--build)\b/,
  /\bturbo\s+run\b/,
  /\bnx\s+(?:run-many|affected)\b/,
  /\bdocker\s+(?:build|buildx\s+build|compose\s+(?:up|build))\b/,
  /\bcargo\s+(?:build|test)\b/,
  /\bgo\s+test\b/,
  /\bpytest\b/,
];

/** Below this amount free for a lease, in MB, the hook asks for a lease. */
export const TIGHT_MB = 4096;

/**
 * This function puts `headroom run --mem auto --` in front of the heavy part of a command line. The shell divides
 * a line at `&&`, `||`, `;` and `|`, so the prefix goes at the start of the part with the heavy command, after
 * its variables (`CI=1 pnpm test`). Thus `cd app && pnpm test` gives `cd app && headroom run --mem auto -- pnpm test`.
 * @param {string} command
 */
export function leased(command) {
  const separator = /&&|\|\||;|\|/g;
  let start = 0;
  for (const match of [...command.matchAll(separator), null]) {
    const end = match ? (match.index ?? 0) : command.length;
    const part = command.slice(start, end);
    if (HEAVY.some((pattern) => pattern.test(part))) {
      const lead = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/.exec(part)?.[0] ?? "";
      const at = start + lead.length;
      return `${command.slice(0, at)}headroom run --mem auto -- ${command.slice(at)}`;
    }
    if (match) start = end + match[0].length;
  }
  return `headroom run --mem auto -- ${command}`;
}

/**
 * This function decides about one command. It gives the reason to refuse the command, or `null` to let it go on.
 * @param {string} command
 * @param {{ free: { memory?: number }, leases: { state: string }[] } | null} status
 */
export function decide(command, status) {
  if (!command || /\bheadroom(?:\.cmd)?\s+run\b/.test(command)) return null;
  if (!HEAVY.some((pattern) => pattern.test(command))) return null;
  if (!status) return null;
  const free = Math.max(0, Math.round(status.free?.memory ?? 0));
  const waiting = (status.leases ?? []).filter((lease) => lease.state === "waiting").length;
  if (free >= TIGHT_MB && waiting === 0) return null;
  const why = waiting > 0 ? `${waiting} job${waiting === 1 ? "" : "s"} already wait for memory` : `only ${free} MB is free for a lease`;
  return (
    `headroom: this is a heavy command, and ${why}. Run it under a lease, so it waits for room and does not push ` +
    `other sessions out of memory. Send it again as: ${leased(command)}`
  );
}

/** This function reads the status of the daemon, or gives `null` when no daemon answers in time. */
async function status() {
  try {
    const home = process.env["HEADROOM_HOME"] ?? join(homedir(), ".headroom");
    const { endpoint, token } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
    const res = await fetch(`${new URL(endpoint).origin}/api/resources/status`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
      signal: AbortSignal.timeout(1000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  /** @type {{ tool_name?: string, tool_input?: { command?: string } }} */
  const event = JSON.parse(input || "{}");
  const command = String(event.tool_input?.command ?? "");
  // A light command goes on at once, with no request to the daemon.
  if (!HEAVY.some((pattern) => pattern.test(command)) || /\bheadroom(?:\.cmd)?\s+run\b/.test(command)) return;
  const reason = decide(command, await status());
  if (!reason) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }),
  );
}

if (import.meta.main) await main().catch(() => undefined);
