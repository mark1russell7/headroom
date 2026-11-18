/**
 * The early listener (H206). The daemon binds its port before it opens the store, the sampler and the engine.
 *
 * - Claude Code treats a refused connection of an HTTP hook as a non-blocking error. Each Bash or PowerShell call then
 *   shows a hook error line. The hook fields of Claude Code have no field that keeps a failed HTTP hook quiet. So the
 *   port must answer from the start of the daemon.
 * - Until the procedure host takes the port, the listener answers the hook with no decision, so the tool call goes on.
 *   The first answer to each session also gives the model a note, once: the hook checks no memory until the daemon runs.
 * - Each other request gets the status 503 and the header `retry-after`. The client of the daemon reads 503 as a restart
 *   (`isRestartError`), as for a daemon that stops.
 * - `close()` stops the listener and ends its open connections, so the procedure host can bind the port.
 * - The listener does not keep the process alive. A failure of the start before the procedure host ends the process.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HOOK_BODY_LIMIT, HOOK_CLIENT, HOOK_HEADER, HOOK_PATH } from "./hook-face.ts";

/** The note to each session, once, while the daemon starts. */
export const EARLY_NOTE = "headroom starts. Until it runs, its hook lets each command go on with no check of the free memory.";

/** The listener before the procedure host. */
export interface EarlyListener {
  /** The port of the listener. Port 0 in the options gives a free port. */
  readonly port: number;
  /** The count of the hook calls that the listener answered. */
  readonly answered: () => number;
  /** This function stops the listener and ends its connections. */
  readonly close: () => Promise<void>;
}

/** The options of the early listener. */
export interface EarlyListenerOptions {
  readonly port: number;
  readonly host: string;
}

function send(res: ServerResponse, code: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(body);
}

/** This function gives the answer of the early listener to a hook event: a note for a new session, or no decision. */
export function earlyAnswer(body: string, noted: Set<string>): string {
  let session = "";
  try {
    const event = JSON.parse(body === "" ? "{}" : body) as { session_id?: unknown };
    session = typeof event.session_id === "string" ? event.session_id : "";
  } catch {
    // A body that is not JSON gets no decision, so the tool call goes on.
  }
  if (session === "" || noted.has(session)) return "{}";
  noted.add(session);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: EARLY_NOTE } });
}

/**
 * This function binds the early listener on the port of the daemon. It gives the listener, or the error of the bind, for
 * example when another process has the port.
 */
export function openEarlyListener(options: EarlyListenerOptions): Promise<EarlyListener | Error> {
  const noted = new Set<string>();
  let answered = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== HOOK_PATH || req.headers[HOOK_HEADER] !== HOOK_CLIENT) {
      req.resume();
      send(res, 503, JSON.stringify({ error: "headroom starts. Try again in a few seconds." }), { "retry-after": "2" });
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= HOOK_BODY_LIMIT) chunks.push(chunk);
    });
    req.on("end", () => {
      answered += 1;
      send(res, 200, size > HOOK_BODY_LIMIT ? "{}" : earlyAnswer(Buffer.concat(chunks).toString("utf8"), noted));
    });
    req.on("error", () => send(res, 200, "{}"));
  });
  return new Promise((resolve) => {
    server.once("error", (error) => resolve(error));
    server.listen(options.port, options.host, () => {
      server.unref();
      resolve({
        port: (server.address() as AddressInfo).port,
        answered: () => answered,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
