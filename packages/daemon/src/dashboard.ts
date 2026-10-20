/**
 * The dashboard: one page at `/` on the listener of the daemon. The page reads the procedures of the daemon
 * with `fetch`. It draws the memory, the alerts, the owners, the leases, the MCP servers and the pool tags.
 * It has no framework and no build step. The daemon keeps the page as one string of approximately 30 KB.
 *
 * - The page holds the token of the daemon. Only a request with a loopback host gets the page. Thus a site
 *   that tries DNS rebinding gets nothing, and a page of another site cannot read the answer.
 * - The page stops its requests while its tab is hidden.
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { hostNameOf, isLoopbackHost } from "@procedures/client";
import type { HostFaceFactory } from "@procedures/peer";

/** The paths of the page. */
const PATHS: ReadonlySet<string> = new Set(["/", "/index.html"]);

/** The headers of the page: no cache, no frame of another site, and requests only to the daemon. */
const HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

/** This function gives the face of the dashboard for the host of the daemon. */
export function dashboardFace(): HostFaceFactory {
  const page = readFileSync(join(import.meta.dirname, "dashboard.html"), "utf8");
  return (context) => ({
    handler: (req: IncomingMessage, res: ServerResponse): boolean => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!PATHS.has(path) || (req.method !== "GET" && req.method !== "HEAD")) return false;
      if (!isLoopbackHost(hostNameOf(req.headers.host))) {
        res.statusCode = 403;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("headroom: the dashboard answers only on 127.0.0.1 or localhost.\n");
        return true;
      }
      const body = page.replace("%%TOKEN%%", context.policy.token ?? "");
      res.statusCode = 200;
      for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    },
    endpoint: { type: "dashboard", scheme: "http", path: "/" },
  });
}
