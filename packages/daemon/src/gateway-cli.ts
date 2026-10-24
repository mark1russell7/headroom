/**
 * The `headroom mcp` commands: the servers of the MCP gateway.
 *
 * - `headroom mcp list`: the state, the process, the memory and the sessions of each server.
 * - `headroom mcp add <name> [--cwd dir] [--env KEY=VALUE]... [--idle 30] -- <command> [args...]`
 * - `headroom mcp remove <name>`, `headroom mcp restart <name>`.
 * - `headroom mcp warm [name...] [--timeout 120s]`: start the servers, and wait until each answers.
 * - `headroom mcp config <name>`: the configuration of the server for Claude Code.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { answers, connectTo, type Connection } from "./client.ts";
import { DEFAULT_PORT } from "./daemon.ts";
import { GATEWAY_PATH } from "./gateway.ts";
import { parseTime } from "./parse.ts";
import { readDiscovery } from "./paths.ts";
import type { McpServerRow } from "./procedures.ts";

const USAGE = `headroom mcp list
headroom mcp add <name> [--cwd dir] [--env KEY=VALUE]... [--idle 30] -- <command> [args...]
headroom mcp remove <name>
headroom mcp restart <name>
headroom mcp warm [name...] [--timeout 120s]
headroom mcp config <name>`;

/** The longest wait of the procedure `mcp.warm`. */
const MAX_WARM_MS = 600_000;

function age(at: number | null): string {
  if (at === null) return "-";
  const minutes = Math.round((Date.now() - at) / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function printRows(rows: readonly McpServerRow[]): void {
  if (rows.length === 0) {
    console.log("The gateway has no MCP server. Add one with: headroom mcp add <name> -- <command> [args...]");
    return;
  }
  console.log(`${"name".padEnd(16)} ${"state".padEnd(9)} ${"pid".padStart(7)} ${"memory".padStart(8)} ${"sessions".padStart(8)} ${"requests".padStart(8)}  used`);
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(16)} ${row.state.padEnd(9)} ${String(row.pid ?? "-").padStart(7)} ${`${row.memoryMb} MB`.padStart(8)} ${String(row.sessions).padStart(8)} ${String(row.requests).padStart(8)}  ${age(row.usedAt)}`,
    );
    if (row.error) console.log(`  error: ${row.error}`);
    for (const line of row.error ? row.stderr.slice(-5) : []) console.log(`  stderr: ${line}`);
  }
}

/** This function gives the configuration of a server of the gateway for Claude Code. */
export function claudeConfig(name: string): { readonly type: "http"; readonly url: string; readonly headersHelper: string } {
  const endpoint = readDiscovery()?.endpoint ?? `http://127.0.0.1:${DEFAULT_PORT}/api`;
  const origin = new URL(endpoint).origin;
  // Claude Code starts the helper through a shell. A path with forward slashes works in each shell of Windows.
  const helper = join(import.meta.dirname, "headers.ts").replace(/\\/g, "/");
  return { type: "http", url: `${origin}${GATEWAY_PATH}${name}`, headersHelper: `node ${helper.includes(" ") ? JSON.stringify(helper) : helper}` };
}

/** This function waits until the daemon answers, and tries one time each second. The daemon can still start, for example at logon. */
async function waitForDaemon(deadline: number): Promise<Connection | null> {
  for (;;) {
    const discovery = readDiscovery();
    if (discovery && (await answers(discovery, Math.min(3000, Math.max(1000, deadline - Date.now()))))) return connectTo(discovery);
    if (Date.now() + 1000 > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * This function does `headroom mcp warm`. It waits for the daemon, then starts the servers and waits until each answers.
 * The exit code is 0 only when the state of each requested server is `running`. Without names, this applies to each configured server.
 */
async function warmCommand(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: { timeout: { type: "string" } } });
  const started = Date.now();
  const deadline = started + parseTime(values.timeout ?? "120s");
  const seconds = (): string => ((Date.now() - started) / 1000).toFixed(1);
  const connection = await waitForDaemon(deadline);
  if (!connection) {
    console.error(`headroom did not answer in ${seconds()} s. Start it with: headroom service start`);
    return 1;
  }
  const timeoutMs = Math.min(MAX_WARM_MS, Math.max(1000, deadline - Date.now()));
  const rows = await connection.call<McpServerRow[]>(["mcp", "warm"], { ...(positionals.length > 0 ? { names: positionals } : {}), timeoutMs });
  printRows(rows);
  const wanted = positionals.length > 0 ? positionals : rows.map((row) => row.name);
  const missing = wanted.filter((name) => !rows.some((row) => row.name === name));
  const stopped = rows.filter((row) => wanted.includes(row.name) && row.state !== "running");
  if (missing.length > 0) {
    console.error(`The gateway has no MCP server ${missing.join(", ")} (${seconds()} s).`);
    return 1;
  }
  if (stopped.length > 0) {
    console.error(`Not running after ${seconds()} s: ${stopped.map((row) => `${row.name} (${row.state})`).join(", ")}.`);
    return 1;
  }
  console.log(`\nEach MCP server runs (${seconds()} s).`);
  return 0;
}

/** This function runs a `headroom mcp` command. It gives the exit code. */
export async function mcpCommand(argv: readonly string[], connection: Connection | null): Promise<number> {
  const [action, ...rest] = argv;
  // The daemon can still start: the warm-up waits for it.
  if (action === "warm") return warmCommand(rest);
  if (action === "config") {
    const name = rest[0];
    if (!name) return (console.error(USAGE), 2);
    const config = claudeConfig(name);
    console.log(JSON.stringify(config, null, 2));
    console.log(`\nTo add it for each session of this user:\n  claude mcp add-json ${name} '${JSON.stringify(config)}' --scope user`);
    const bridge = join(import.meta.dirname, "bridge.mjs").replace(/\\/g, "/");
    console.log(`\nFor a program that starts only stdio servers, for example the launcher of a plugin:\n  node ${bridge} ${name} -- <the usual command of the server>`);
    console.log("The bridge uses the gateway when it serves the server. Otherwise it starts the usual command.");
    return 0;
  }
  if (!connection) {
    console.error("headroom does not run. Start it with: headroom service install");
    return 1;
  }
  switch (action) {
    case "list":
      printRows(await connection.call<McpServerRow[]>(["mcp", "list"], {}));
      return 0;
    case "add": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        allowPositionals: true,
        options: { cwd: { type: "string" }, env: { type: "string", multiple: true }, idle: { type: "string" } },
      });
      const [name, command, ...args] = positionals;
      if (!name || !command) return (console.error(USAGE), 2);
      const env: Record<string, string> = {};
      for (const pair of values.env ?? []) {
        const at = pair.indexOf("=");
        if (at <= 0) return (console.error(`--env needs KEY=VALUE, not ${pair}`), 2);
        env[pair.slice(0, at)] = pair.slice(at + 1);
      }
      printRows(
        await connection.call<McpServerRow[]>(["mcp", "add"], {
          name,
          command,
          args,
          ...(values.cwd ? { cwd: values.cwd } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
          ...(values.idle ? { idleMinutes: Number(values.idle) } : {}),
        }),
      );
      console.log(`\nThe sessions reach it with: headroom mcp config ${name}`);
      return 0;
    }
    case "remove":
    case "restart": {
      const name = rest[0];
      if (!name) return (console.error(USAGE), 2);
      printRows(await connection.call<McpServerRow[]>(["mcp", action], { name }));
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}
