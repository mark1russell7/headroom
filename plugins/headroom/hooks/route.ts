/**
 * The forwarder of the old command hook (H194). It repairs the sessions that started before plugin 0.2.0.
 *
 * - Plugin 0.2.0 replaced the command hook `node ${CLAUDE_PLUGIN_ROOT}/hooks/route.ts` with an HTTP hook. A session keeps the
 *   hooks of its start. So a session that started before it still starts this file at each Bash or PowerShell call.
 * - The file posts the hook input to `POST /hooks/pre-tool-use` of the daemon and writes the answer.
 * - A daemon from before H194 has no such route (404). Then the file rates the command with the one copy of the rating
 *   (`packages/daemon/src/hook-rating.ts`), from the status of the daemon, as the old hook did.
 * - Each failure ends with no output and the exit code 0, so the tool call goes on with no error text.
 *
 * This file is a shortcut. It ends when each running session has the HTTP hook, at the next start of each session after
 * the release of plugin 0.2.0. Node starts this file directly, so it uses only the types that Node can remove.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The longest wait for the daemon, as the old hook. A session does not wait more. */
const TIMEOUT_MS = 1000;

/** The status of the daemon that the rating reads. */
interface Status {
  readonly free?: { readonly memory?: number };
  readonly leases?: readonly { readonly state: string; readonly reason?: string | null }[];
}

/** The part of the rating module that this file uses. */
interface Rating {
  readonly hookOutput: (event: unknown, status: () => Status | null) => object;
  readonly isHeavy: (command: string) => boolean;
}

/** This function gives the origin and the token of the daemon from its file, or `null`. */
function daemon(): { readonly origin: string; readonly token: string } | null {
  try {
    const home = process.env["HEADROOM_HOME"] ?? join(homedir(), ".headroom");
    const { endpoint, token } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { endpoint: string; token: string };
    return { origin: new URL(endpoint).origin, token };
  } catch {
    return null;
  }
}

/** This function gives the status of a daemon from before H194, or `null`. */
async function status(origin: string, token: string): Promise<Status | null> {
  try {
    const res = await fetch(`${origin}/api/resources/status`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? ((await res.json()) as Status) : null;
  } catch {
    return null;
  }
}

/** This function writes an answer of the hook. An empty answer writes nothing. */
function answer(output: object): void {
  if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
}

async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const found = daemon();
  if (found === null) return;
  const res = await fetch(`${found.origin}/hooks/pre-tool-use`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-headroom-client": "hook" },
    body: input || "{}",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) {
    answer((await res.json()) as object);
    return;
  }
  if (res.status !== 404) return;
  // A daemon from before H194. The rating is in the checkout of the repository, next to the plugin.
  const rating = (await import(new URL("../../../packages/daemon/src/hook-rating.ts", import.meta.url).href)) as Rating;
  const event = JSON.parse(input || "{}") as { tool_input?: { command?: unknown } };
  if (!rating.isHeavy(String(event.tool_input?.command ?? ""))) return;
  const read = await status(found.origin, found.token);
  answer(rating.hookOutput(event, () => read));
}

main().catch(() => {
  // A failure lets the tool call go on, with no error text.
  process.exitCode = 0;
});
