/**
 * The `headroom services [--json]` command and the services line of `headroom status` (H27).
 *
 * Each shared service has a state: `ok`, `slow`, `down`, `idle` (an MCP server that the gateway stopped on purpose) or
 * `absent` (no Docker engine). The command shows the state, the latency, the start of the state and the last error.
 */

import { parseArgs } from "node:util";
import { CHECK_EVERY_MS, DEFAULT_HEALTH, type ServiceHealth } from "@headroom/core";
import type { Connection } from "./client.ts";

export const SERVICES_USAGE = "headroom services [--json]";

/** The outputs of the command. The tests replace them. */
export interface ServicesOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly now: () => number;
}

const CONSOLE: ServicesOutput = { out: (text) => console.log(text), err: (text) => console.error(text), now: Date.now };

/** This function writes a time as the UTC clock, as the alerts do. */
function utc(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

/** This function writes a time span: "30 s", "3 min" or "1.5 h". */
function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;
}

/** This function writes one service for the line of `headroom status`: "docker ok (12 ms)" or "docker down since 18:42 UTC". */
function serviceWord(health: ServiceHealth): string {
  const latency = health.latencyMs === null ? "" : ` (${health.latencyMs} ms)`;
  const since = health.state === "down" || health.state === "slow" ? ` since ${utc(health.since)} UTC` : "";
  return `${health.name} ${health.state}${latency}${since}`;
}

/**
 * This function gives the services line of `headroom status`, for example "Services: docker ok (12 ms), mcp:loom idle."
 * Without a service, it gives `null`.
 */
export function servicesLine(services: readonly ServiceHealth[]): string | null {
  return services.length === 0 ? null : `Services: ${services.map(serviceWord).join(", ")}.`;
}

/** This function gives the table of `headroom services`: one row for each service, with the times in UTC. */
export function servicesTable(services: readonly ServiceHealth[], now: number): string[] {
  if (services.length === 0) return [`No check of the services yet. The daemon checks them every ${CHECK_EVERY_MS / 1000} seconds.`];
  const rows = [`${"SERVICE".padEnd(24)} ${"STATE".padEnd(7)} ${"LATENCY".padStart(8)}  ${"SINCE (UTC)".padEnd(16)} ${"LAST OK".padEnd(8)} LAST ERROR`];
  for (const health of services) {
    const latency = health.latencyMs === null ? "-" : `${health.latencyMs} ms`;
    const since = `${utc(health.since)} (${span(now - health.since)})`;
    const okAt = health.okAt === null ? "-" : utc(health.okAt);
    const error = health.error === null ? "-" : `${health.errorAt === null ? "" : `${utc(health.errorAt)} `}${health.error}`;
    rows.push(`${health.name.slice(0, 24).padEnd(24)} ${health.state.padEnd(7)} ${latency.padStart(8)}  ${since.padEnd(16)} ${okAt.padEnd(8)} ${error}`);
  }
  const checked = Math.max(...services.map((health) => health.checkedAt));
  rows.push("", `The last check was ${span(now - checked)} ago. headroom does not restart a service.`);
  return rows;
}

/** `headroom services [--json]`: the health of each shared service. */
export async function servicesCommand(argv: readonly string[], connection: Connection | null, io: ServicesOutput = CONSOLE): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { json: { type: "boolean" } } });
  if (!connection) return (io.err("headroom does not run. Start it with: headroom service install"), 1);
  const services = await connection.call<ServiceHealth[]>(["resources", "services"], {});
  if (values.json) io.out(JSON.stringify(services, null, 2));
  else for (const row of servicesTable(services, io.now())) io.out(row);
  return 0;
}

/** This function gives the lines of the setting `health` for `headroom config`. */
export function healthLines(health: Readonly<Record<string, string>>): string[] {
  const entries = Object.entries(health);
  if (entries.length === 0) return ["health: (none: the monitor checks no URL)"];
  return ["health:", ...entries.map(([name, url]) => `  ${name.padEnd(20)} ${url}`)];
}

/**
 * This function gives the new list of URLs for `headroom config health`. A name and a URL add or change one check.
 * A name with `--clear` removes one check. `--clear` alone gives `null`, the default list. Other arguments give `undefined`.
 */
export function healthChange(
  current: Readonly<Record<string, string>>,
  name: string | undefined,
  url: string | undefined,
  clear: boolean,
): Record<string, string> | null | undefined {
  if (name === undefined) return clear ? null : undefined;
  if (url !== undefined) return clear ? undefined : { ...current, [name]: url };
  if (!clear || !(name in current)) return undefined;
  const { [name]: _removed, ...rest } = current;
  return rest;
}

/** The default list of the setting `health`, for the help of `headroom config`. */
export const DEFAULT_HEALTH_TEXT: string = Object.entries(DEFAULT_HEALTH).map(([name, url]) => `${name} ${url}`).join(", ");
