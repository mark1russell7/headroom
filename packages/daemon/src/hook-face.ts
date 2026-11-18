/**
 * The face of the hook (H194): `POST /hooks/pre-tool-use` on the listener of the daemon. The plugin of headroom calls it
 * as an HTTP hook of Claude Code before each Bash or PowerShell call, so the hook starts no process (before H194, each
 * call started bash.exe and node.exe for the hook).
 *
 * - The route answers only on 127.0.0.1 or localhost, and only a request with the header `x-headroom-client: hook`.
 *   A web page cannot send that header to another origin without a CORS preflight, and the daemon answers no preflight.
 * - The body is the PreToolUse event of Claude Code. The answer is the JSON output of the hook. `{}` lets the call go
 *   on. A refusal has `hookSpecificOutput.permissionDecision` = `deny` and the form under a lease.
 * - A failure of the request (no daemon, a time-out, an error status) lets the tool call go on. Claude Code treats a
 *   failed HTTP hook as a non-blocking error, and the plugin sets no `onFailure`. Each such call shows a hook error line.
 * - The route has no token, because the URL and the headers of the hook are the same for each session. Thus each process
 *   of this computer can read the free memory and the reasons of the waiting leases in a refusal. On a computer of one user,
 *   that is acceptable: the dashboard on the same port shows more.
 * - The gate of long native paths (H203) comes first. A command that runs node in a folder with a native image path over
 *   the limit gets a refusal. This applies also under `headroom run` and with a lot of free memory. See `native-paths.ts`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { hostNameOf, isLoopbackHost } from "@procedures/client";
import type { HostFaceFactory } from "@procedures/peer";
import { denied, hookOutput, type Status } from "./hook-rating.ts";

/** The path of the route of the hook. */
export const HOOK_PATH = "/hooks/pre-tool-use";
/** The header that each request of the hook carries, and its value. */
export const HOOK_HEADER = "x-headroom-client";
export const HOOK_CLIENT = "hook";
/** The largest event that the route reads: a command with a long here-document is still far below it. */
export const HOOK_BODY_LIMIT: number = 8 * 1024 * 1024;

export interface HookFaceOptions {
  /** The status of the daemon: the free memory and the leases. `null` or an error lets each command go on. */
  readonly status: () => Status | null;
  /** The largest body that the route reads. The default is {@link HOOK_BODY_LIMIT}. */
  readonly bodyLimit?: number | undefined;
  /**
   * The gate of long native paths (H203): the refusal of a command line in its folder, or `null`. A failure lets the
   * command go on. With no gate, each command goes on. The session ID of the event goes to the log of refusals.
   */
  readonly native?: ((command: string, cwd: string | null, sessionId: string | null) => Promise<string | null>) | undefined;
}

function answer(res: ServerResponse, code: number, body: string, type: string): void {
  res.statusCode = code;
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

/**
 * This function reads the body of a request, or gives `null` when the body passes the limit. The function reads a body over
 * the limit to its end and keeps none of it. Thus the answer 413 reaches the client.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else chunks = [];
    });
    req.on("end", () => resolve(size > limit ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** This function gives the verdict for the body of one request: the status code and the JSON text of the answer. */
export function hookAnswer(body: string, status: () => Status | null): { readonly code: number; readonly json: string } {
  let event: unknown;
  try {
    event = JSON.parse(body === "" ? "{}" : body);
  } catch {
    return { code: 400, json: JSON.stringify({ error: "headroom: the body of the hook is not JSON." }) };
  }
  const safeStatus = (): Status | null => {
    try {
      return status();
    } catch {
      return null;
    }
  };
  return { code: 200, json: JSON.stringify(hookOutput(event, safeStatus)) };
}

/**
 * This function gives the verdict for the body of one request, with the gate of long native paths (H203) before the rating
 * of memory. A failure of the gate lets the command go on.
 */
export async function hookVerdict(
  body: string,
  options: Pick<HookFaceOptions, "status" | "native">,
): Promise<{ readonly code: number; readonly json: string }> {
  const rated = hookAnswer(body, options.status);
  if (rated.code !== 200 || options.native === undefined) return rated;
  const event = JSON.parse(body === "" ? "{}" : body) as { tool_input?: { command?: unknown }; cwd?: unknown; session_id?: unknown } | null;
  const command = event?.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") return rated;
  const cwd = typeof event?.cwd === "string" && event.cwd !== "" ? event.cwd : null;
  const sessionId = typeof event?.session_id === "string" && event.session_id !== "" ? event.session_id : null;
  const gate = options.native;
  // A gate that throws, also before its promise, lets the command go on.
  const refusal = await Promise.resolve()
    .then(() => gate(command, cwd, sessionId))
    .catch(() => null);
  return refusal === null ? rated : { code: 200, json: JSON.stringify(denied(refusal)) };
}

/** This function gives the face of the hook for the host of the daemon. */
export function hookFace(options: HookFaceOptions): HostFaceFactory {
  return () => ({
    handler: (req: IncomingMessage, res: ServerResponse): boolean => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== HOOK_PATH) return false;
      if (!isLoopbackHost(hostNameOf(req.headers.host))) {
        answer(res, 403, "headroom: the hook answers only on 127.0.0.1 or localhost.\n", "text/plain; charset=utf-8");
        return true;
      }
      if (req.headers[HOOK_HEADER] !== HOOK_CLIENT) {
        answer(res, 403, `headroom: the hook needs the header ${HOOK_HEADER}: ${HOOK_CLIENT}.\n`, "text/plain; charset=utf-8");
        return true;
      }
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        answer(res, 405, "headroom: the hook takes only POST.\n", "text/plain; charset=utf-8");
        return true;
      }
      readBody(req, options.bodyLimit ?? HOOK_BODY_LIMIT).then(
        async (body) => {
          if (body === null) {
            answer(res, 413, JSON.stringify({ error: "headroom: the event of the hook is too large." }), "application/json");
            return;
          }
          const { code, json } = await hookVerdict(body, options);
          answer(res, code, json, "application/json");
        },
        () => {
          if (!res.headersSent) answer(res, 400, JSON.stringify({ error: "headroom: the body of the hook did not arrive." }), "application/json");
        },
      );
      return true;
    },
    endpoint: { type: "hook", scheme: "http", path: HOOK_PATH },
  });
}
