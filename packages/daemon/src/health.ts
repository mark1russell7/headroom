/**
 * The checks of the service monitor (H27): the Docker engine, the URLs of the setting `health` and the MCP servers of the gateway.
 * This file also gives the transport of the Docker reader (H38).
 *
 * - Docker: a GET of `/_ping` on the pipe of the engine. No pipe gives `absent`, not an alert. headroom starts no `docker` process.
 * - A URL: a GET. An answer with a status below 500 is `ok`.
 * - An MCP server: the state of the gateway, with no call. A server that the gateway stopped for idle is `idle`, not `down`.
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { errorText, type DockerAnswer, type DockerGet, type ServiceCheck, type ServiceProbe } from "@headroom/core";
import type { McpServerState } from "./gateway.ts";

/** The pipe of the Docker engine: a named pipe on Windows, a Unix socket on Linux. */
export const DOCKER_PIPE: string = process.platform === "win32" ? "\\\\.\\pipe\\docker_engine" : "/var/run/docker.sock";

/** The sentence of the Docker alert that tells who needs the engine. */
const DOCKER_NEEDS = "Containers such as Mongo and the graph tests need it.";

/** An MCP server with this count of unexpected exits in 10 minutes is `down`: it stops again after each start. */
export const MCP_EXITS_DOWN = 3;

/** This function gives the result of a failed request. No pipe or socket (`ENOENT`) gives `absent` when `absentOnMissing` is set. */
export function failedProbe(error: unknown, absentOnMissing: boolean): ServiceProbe {
  const code = (error as { code?: unknown } | null)?.code;
  if (absentOnMissing && code === "ENOENT") return { state: "absent", latencyMs: null, error: null };
  return { state: "down", latencyMs: null, error: errorText(error) };
}

/**
 * This function makes one GET and gives the result. A status of 500 or more is `down`. The signal aborts the request.
 * Each request has its own connection, so a hung server keeps no socket of the pool.
 */
export function httpProbe(options: RequestOptions & { readonly url?: string | undefined }, signal: AbortSignal, absentOnMissing = false): Promise<ServiceProbe> {
  return new Promise((resolve) => {
    const started = performance.now();
    const { url, ...rest } = options;
    const settings: RequestOptions = { ...rest, method: "GET", agent: false, signal };
    const answer = (res: IncomingMessage): void => {
      const latencyMs = performance.now() - started;
      const status = res.statusCode ?? 0;
      res.resume();
      resolve(status >= 500 ? { state: "down", latencyMs, error: `HTTP ${status}` } : { state: "ok", latencyMs, error: null });
    };
    let req: ClientRequest;
    try {
      const secure = url !== undefined && url.startsWith("https:");
      req = url === undefined ? httpRequest(settings, answer) : secure ? httpsRequest(url, settings, answer) : httpRequest(url, settings, answer);
    } catch (error) {
      resolve(failedProbe(error, absentOnMissing));
      return;
    }
    req.on("error", (error) => resolve(failedProbe(error, absentOnMissing)));
    req.end();
  });
}

/** The largest answer of the Docker engine that the reader of H38 takes. `GET /system/df` gave 322 KB on this computer. */
export const DOCKER_ANSWER_LIMIT: number = 16 * 1024 * 1024;

/**
 * This function gives the transport of the Docker reader (H38): one GET on the pipe of the engine, with no `docker` process.
 * Each request has its own connection. An answer above the limit gives an error. The signal aborts the request.
 */
export function dockerGet(pipe: string = DOCKER_PIPE, limit: number = DOCKER_ANSWER_LIMIT): DockerGet {
  return (path, signal) =>
    new Promise<DockerAnswer>((resolve, reject) => {
      const answer = (res: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) res.destroy(new Error(`The answer of the Docker engine is larger than ${Math.round(limit / 1024 / 1024)} MB`));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      };
      let req: ClientRequest;
      try {
        req = httpRequest({ socketPath: pipe, path, method: "GET", agent: false, signal, headers: { accept: "application/json" } }, answer);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      req.on("error", reject);
      req.end();
    });
}

/** This function gives the check of the Docker engine: a GET of `/_ping` on its pipe. */
export function dockerCheck(pipe: string = DOCKER_PIPE): ServiceCheck {
  return {
    name: "docker",
    type: "docker",
    title: "The Docker engine",
    target: pipe,
    critical: true,
    needs: DOCKER_NEEDS,
    run: (signal) => httpProbe({ socketPath: pipe, path: "/_ping" }, signal, true),
  };
}

/** This function gives the check of one URL of the setting `health`. Its alert is a warning. */
export function urlCheck(name: string, url: string): ServiceCheck {
  return {
    name,
    type: "url",
    title: name === "fleet-site" ? "The fleet site" : `The service ${name}`,
    target: url,
    critical: false,
    run: (signal) => httpProbe({ url }, signal),
  };
}

/** This function gives the last error line of an MCP server. It is the last stderr line with an error, else the error, else the last line. */
export function lastErrorLine(server: McpServerState): string | null {
  const lines = server.stderr.map((line) => line.trim()).filter(Boolean);
  const named = [...lines].reverse().find((line) => /error|cannot|not found|missing|denied|failed/i.test(line));
  const line = named ?? server.error ?? lines.at(-1) ?? null;
  return line === null ? null : line.slice(0, 300);
}

/**
 * This function gives the health of an MCP server from the state of the gateway. A server that did not start is `down`.
 * A server that exited is `idle`, because the next request starts it again. With 3 exits in 10 minutes, it is `down`.
 */
export function mcpProbe(server: McpServerState): ServiceProbe {
  if (server.state === "running" || server.state === "starting") return { state: "ok", latencyMs: null, error: null };
  if (server.state === "stopped") return { state: "idle", latencyMs: null, error: null };
  const error = lastErrorLine(server);
  if (server.failure === "start" || server.exits >= MCP_EXITS_DOWN) return { state: "down", latencyMs: null, error };
  return { state: "idle", latencyMs: null, error };
}

/** This function gives the check of one MCP server of the gateway. It reads the state of the gateway and makes no call. */
export function mcpCheck(name: string, state: () => McpServerState | undefined): ServiceCheck {
  return {
    name: `mcp:${name}`,
    type: "mcp",
    title: `The MCP server ${name}`,
    target: null,
    critical: true,
    run: async () => {
      const server = state();
      return server === undefined ? { state: "idle", latencyMs: null, error: null } : mcpProbe(server);
    },
  };
}

/** This function gives the checks of one round: Docker, each URL of the setting `health`, and each MCP server of the gateway. */
export function serviceChecks(urls: Readonly<Record<string, string>>, servers: readonly McpServerState[], pipe: string = DOCKER_PIPE): ServiceCheck[] {
  const byName = new Map(servers.map((server) => [server.name, server]));
  return [
    dockerCheck(pipe),
    ...Object.entries(urls).map(([name, url]) => urlCheck(name, url)),
    ...[...byName.keys()].map((name) => mcpCheck(name, () => byName.get(name))),
  ];
}
