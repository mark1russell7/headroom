/**
 * The headers helper of the MCP gateway. Claude Code starts it at each connection to a server of the
 * gateway, and again after a 401 answer (`headersHelper`). It writes the token of the running daemon
 * as a JSON object of headers. The token changes at each start of the daemon.
 */

import { readDiscovery } from "./paths.ts";

const discovery = readDiscovery();
process.stdout.write(`${JSON.stringify(discovery ? { Authorization: `Bearer ${discovery.token}` } : {})}\n`);
