/**
 * The dashboard: one page at `/` on the listener of the daemon. The page reads the procedures of the daemon
 * with `fetch`. It draws the alerts, a bar of the memory and the processors by owner, and the services. Then it draws one
 * panel for each resource, a timeline of the leases, the owners, the MCP servers and the pool tags. A panel opens to a chart
 * of its history.
 *
 * The page has no framework and no build step. The daemon keeps the page as one string of approximately 69 KB.
 *
 * - The page holds the token of the daemon. Only a request with a loopback host gets the page. Thus a site
 *   that tries DNS rebinding gets nothing, and a page of another site cannot read the answer.
 * - The request must also give the key of the dashboard as `?k=<key>`. Only this user can read the key file, and
 *   `headroom dashboard` opens the page with it. Thus a process that can connect to the port but cannot read the file gets no token.
 *   An example is a container that connects through `host.docker.internal`.
 * - The page keeps the key in the storage of its browser and removes it from the address bar. A later visit to `/` gets a
 *   short page that sends the stored key.
 * - The page stops its requests while its tab is hidden.
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { hostNameOf, isLoopbackHost, tokenMatches } from "@procedures/client";
import type { HostFaceFactory } from "@procedures/peer";
import { dashboardKey } from "./paths.ts";

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

/**
 * The page for a request without a valid key. It holds no token. When the browser has a stored key, the page loads the
 * dashboard with that key. When the key in the address is not valid, the page removes the stored key.
 */
const LOCKED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>headroom</title>
<script>
try {
  if (new URLSearchParams(location.search).has("k")) localStorage.removeItem("headroom.key");
  else { const key = localStorage.getItem("headroom.key"); if (key) location.replace("/?k=" + encodeURIComponent(key)); }
} catch {}
</script>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --code: #f0f0f2; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #ececf0; --code: #2a2a2e; } }
body { margin: 0; padding: 48px 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 36rem; margin: 0 auto; }
code { background: var(--code); padding: 2px 6px; border-radius: 4px; }
</style>
</head>
<body>
<main>
<h1>headroom</h1>
<p>The dashboard needs its key. To open the dashboard, run <code>headroom dashboard</code> on this computer.</p>
</main>
</body>
</html>
`;

/** The options of the dashboard. */
export interface DashboardOptions {
  /** This function gives the key of the dashboard. The default reads the key file of headroom. */
  readonly key?: (() => string) | undefined;
}

/** This function tells if the key of a request is the key of the dashboard. A key that cannot be read matches nothing. */
function keyMatches(key: () => string, presented: string | null): boolean {
  if (presented === null || presented === "") return false;
  try {
    const expected = key();
    return expected !== "" && tokenMatches(expected, presented);
  } catch {
    return false;
  }
}

/** This function gives the face of the dashboard for the host of the daemon. */
export function dashboardFace(options: DashboardOptions = {}): HostFaceFactory {
  const page = readFileSync(join(import.meta.dirname, "dashboard.html"), "utf8");
  const key = options.key ?? dashboardKey;
  return (context) => ({
    handler: (req: IncomingMessage, res: ServerResponse): boolean => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!PATHS.has(url.pathname) || (req.method !== "GET" && req.method !== "HEAD")) return false;
      if (!isLoopbackHost(hostNameOf(req.headers.host))) {
        res.statusCode = 403;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("headroom: the dashboard answers only on 127.0.0.1 or localhost.\n");
        return true;
      }
      const open = keyMatches(key, url.searchParams.get("k"));
      const body = open ? page.replace("%%TOKEN%%", context.policy.token ?? "") : LOCKED_PAGE;
      res.statusCode = open ? 200 : 403;
      for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    },
    endpoint: { type: "dashboard", scheme: "http", path: "/" },
  });
}
