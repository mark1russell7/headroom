/**
 * The MCP gateway (H11): one copy of each local MCP server for all the Claude Code sessions.
 *
 * A stdio MCP server has one pipe to one client, so each session starts a copy of each server. The
 * gateway starts each server one time and is its MCP client. It serves the server to the sessions
 * over Streamable HTTP at `/mcp/<name>`, on the listener of the daemon. Each session gets an MCP
 * session of its own, and each request of a session goes to the one copy.
 *
 * - The gateway starts a server at the first request, and stops it after an idle time.
 * - `warm` starts the servers before the first request, for example before the sessions of the fleet start.
 * - After a server stops, the next request starts it again. After each failure, the wait before the next start is longer.
 * - The checks of the client apply: the token of the daemon, and no request from a web page.
 * - The SDK of MCP loads at the first request. Thus a daemon with no MCP server does not pay its memory.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServerSpec } from "@headroom/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Implementation, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { bearerOf, checkBrowserRequest, tokenMatches } from "@procedures/client";
import type { HostFaceFactory } from "@procedures/peer";

/** The path of the gateway on the listener of the daemon. A server has the path `/mcp/<name>`. */
export const GATEWAY_PATH = "/mcp/";

/** The name of a server: letters, digits, `-` and `_`. */
export const SERVER_NAME: RegExp = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const CALL_TIMEOUT_MS = 30 * 60_000;
const START_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_IDLE_MINUTES = 30;
const SESSION_IDLE_MS = 24 * 3_600_000;
const STDERR_LINES = 20;
/** The window of the unexpected exits that `McpServerState.exits` counts. */
const EXIT_WINDOW_MS = 10 * 60_000;

/** The modules of the MCP SDK that the gateway uses. */
interface Sdk {
  readonly client: typeof import("@modelcontextprotocol/sdk/client/index.js");
  readonly stdio: typeof import("@modelcontextprotocol/sdk/client/stdio.js");
  readonly server: typeof import("@modelcontextprotocol/sdk/server/index.js");
  readonly http: typeof import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  readonly types: typeof import("@modelcontextprotocol/sdk/types.js");
}

let sdk: Promise<Sdk> | undefined;

function loadSdk(): Promise<Sdk> {
  sdk ??= Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]).then(([client, stdio, server, http, types]) => ({ client, stdio, server, http, types }));
  return sdk;
}

/** The state of one server of the gateway. */
export interface McpServerState {
  readonly name: string;
  readonly spec: McpServerSpec;
  readonly state: "stopped" | "starting" | "running" | "waiting";
  /** The process of the server, when it runs. */
  readonly pid: number | null;
  /** The open MCP sessions of the Claude Code sessions. */
  readonly sessions: number;
  /** The requests since the start of the daemon. */
  readonly requests: number;
  readonly startedAt: number | null;
  readonly usedAt: number | null;
  /** The failures after the last good start. */
  readonly failures: number;
  readonly error: string | null;
  /** How the last failure after the last good start happened: at the start, or by an exit of the process. */
  readonly failure: "start" | "exit" | null;
  /** The unexpected exits of the process in the last 10 minutes. */
  readonly exits: number;
  /** The last lines that the server wrote to stderr. */
  readonly stderr: readonly string[];
}

/** A request as the SDK gives it to a handler. */
interface ForwardedRequest {
  readonly method: string;
  readonly params?: Record<string, unknown> | undefined;
}

/** The part of the extra data of a request handler that the gateway uses. */
interface RequestExtra {
  readonly signal: AbortSignal;
  readonly requestId: string | number;
  sendNotification(notification: { method: string; params?: Record<string, unknown> }): Promise<void>;
}

type SetHandler = (schema: unknown, handler: (request: ForwardedRequest, extra: RequestExtra) => Promise<unknown>) => void;
type SendRequest = (request: ForwardedRequest, schema: unknown, options: Record<string, unknown>) => Promise<unknown>;

/** The data of a server that a new session gets in its `initialize` answer. */
interface ServerInfo {
  readonly capabilities: ServerCapabilities;
  readonly serverInfo: Implementation;
  readonly instructions: string | undefined;
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: Server;
  /** The requests of the session that the server has not answered. */
  readonly inFlight: Set<string | number>;
  seenAt: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** This function gives the descendants of a process from the lines `<pid> <parent pid>` of `ps -A -o pid=,ppid=`. */
export function descendantsOf(pid: number, table: string): number[] {
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined || !Number.isInteger(child) || !Number.isInteger(parent)) continue;
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  }
  const found: number[] = [];
  const queue = [pid];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (child === pid || found.includes(child)) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** This function stops a process and its descendants. A server often starts a chain of processes, for example `pnpm`, then `tsx`, then `node`. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  // The function finds the descendants first, because a child gets another parent when its parent stops.
  const table = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  for (const id of [pid, ...(table.status === 0 ? descendantsOf(pid, table.stdout) : [])]) {
    try {
      process.kill(id, "SIGTERM");
    } catch {
      // The process stopped before.
    }
  }
}

/** One server of the gateway: its process, its MCP client and the sessions that use it. */
class Upstream {
  readonly name: string;
  spec: McpServerSpec;
  readonly sessions: Map<string, Session> = new Map();
  readonly #log: (line: string) => void;
  #client: Client | null = null;
  #starting: Promise<Client> | null = null;
  #info: ServerInfo | null = null;
  #pid: number | null = null;
  #startedAt: number | null = null;
  #usedAt: number | null = null;
  /** The requests that the server has not answered. */
  #open = 0;
  #requests = 0;
  #failures = 0;
  #failedAt = 0;
  #error: string | null = null;
  #failure: "start" | "exit" | null = null;
  /** The times of the unexpected exits of the last 10 minutes. */
  #exits: number[] = [];
  readonly #stderr: string[] = [];

  constructor(name: string, spec: McpServerSpec, log: (line: string) => void) {
    this.name = name;
    this.spec = spec;
    this.#log = log;
  }

  get pid(): number | null {
    return this.#pid;
  }

  /** This function gives the client of the server. It starts the server when it does not run. */
  client(): Promise<Client> {
    if (this.#client) return Promise.resolve(this.#client);
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  /** This function gives the capabilities, the name and the instructions of the server. It starts the server when it does not run. */
  async info(): Promise<ServerInfo> {
    await this.client();
    if (!this.#info) throw new Error(`The MCP server ${this.name} gave no data at its start`);
    return this.#info;
  }

  /** This function sends a request of a session to the server, with its cancel and its progress. */
  async forward(request: ForwardedRequest, resultSchema: unknown, extra: RequestExtra): Promise<unknown> {
    const client = await this.client();
    this.#usedAt = Date.now();
    this.#requests += 1;
    const meta = request.params?.["_meta"] as { progressToken?: string | number } | undefined;
    const token = meta?.progressToken;
    const send = client.request.bind(client) as unknown as SendRequest;
    // The sweep does not stop a server with an open request. The end of a request also counts as a use.
    this.#open += 1;
    try {
      return await send(request, resultSchema, {
        signal: extra.signal,
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        ...(token !== undefined
          ? {
              onprogress: (progress: Record<string, unknown>) => {
                extra.sendNotification({ method: "notifications/progress", params: { ...progress, progressToken: token } }).catch(() => undefined);
              },
            }
          : {}),
      });
    } finally {
      this.#open -= 1;
      this.#usedAt = Date.now();
    }
  }

  /** This function stops the server. The next request starts it again. */
  async stop(): Promise<void> {
    const client = this.#client;
    const pid = this.#pid;
    this.#client = null;
    this.#pid = null;
    this.#startedAt = null;
    if (!client) return;
    if (pid !== null) killTree(pid);
    await client.close().catch(() => undefined);
    this.#log(`The MCP server ${this.name} stopped.`);
  }

  /** This function closes the sessions that sent no request for a long time, and stops an idle server. A server with an open request is not idle. */
  async sweep(now: number): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (now - session.seenAt > SESSION_IDLE_MS) {
        this.sessions.delete(id);
        await session.transport.close().catch(() => undefined);
      }
    }
    const idleMs = (this.spec.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
    const last = this.#usedAt ?? this.#startedAt;
    if (this.#client && this.#open === 0 && idleMs > 0 && last !== null && now - last > idleMs) await this.stop();
  }

  /** This function closes each session and stops the server. */
  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.transport.close().catch(() => undefined)));
    await this.stop();
  }

  state(): McpServerState {
    const waiting = this.#failures > 0 && !this.#client && !this.#starting;
    return {
      name: this.name,
      spec: this.spec,
      state: this.#client ? "running" : this.#starting ? "starting" : waiting ? "waiting" : "stopped",
      pid: this.#pid,
      sessions: this.sessions.size,
      requests: this.#requests,
      startedAt: this.#startedAt,
      usedAt: this.#usedAt,
      failures: this.#failures,
      error: this.#error,
      failure: this.#failures > 0 ? this.#failure : null,
      exits: this.#exits.filter((at) => Date.now() - at <= EXIT_WINDOW_MS).length,
      stderr: [...this.#stderr],
    };
  }

  /** This function sends a notification of the server to each session. */
  #each(send: (server: Server) => Promise<void>): void {
    for (const session of this.sessions.values()) send(session.server).catch(() => undefined);
  }

  /**
   * This function sends a question of the server (MCP elicitation) to the session that waits for an
   * answer of the server. Stdio does not tell which call asks. Thus the gateway sends the question
   * only when exactly one session has a request in flight. Otherwise, the answer is `decline`.
   */
  async #elicit(request: ForwardedRequest, resultSchema: unknown): Promise<unknown> {
    const busy = [...this.sessions.values()].filter((session) => session.inFlight.size > 0);
    const session = busy.length === 1 ? busy[0] : undefined;
    if (!session || !session.server.getClientCapabilities()?.elicitation) {
      this.#log(`The MCP server ${this.name} asked a question, and no single session can answer: ${busy.length} sessions wait.`);
      return { action: "decline" };
    }
    const send = session.server.request.bind(session.server) as unknown as SendRequest;
    return send(request, resultSchema, { relatedRequestId: [...session.inFlight][0], timeout: CALL_TIMEOUT_MS });
  }

  #fail(error: unknown, failure: "start" | "exit"): void {
    this.#failures += 1;
    this.#failedAt = Date.now();
    this.#failure = failure;
    if (failure === "exit") this.#exits = [...this.#exits.filter((at) => this.#failedAt - at <= EXIT_WINDOW_MS), this.#failedAt];
    this.#error = message(error);
    this.#log(`The MCP server ${this.name} failed: ${this.#error}`);
  }

  async #start(): Promise<Client> {
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.#failures - 1));
    const wait = this.#failures === 0 ? 0 : backoff - (Date.now() - this.#failedAt);
    if (wait > 0) throw new Error(`The MCP server ${this.name} failed (${this.#error ?? "no reason"}). The next start is in ${Math.ceil(wait / 1000)} s.`);
    const { client: clientModule, stdio, types } = await loadSdk();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    const transport = new stdio.StdioClientTransport({
      command: this.spec.command,
      // A title marks the process of a Node server in its command line: headroom-mcp-<name>.
      args: [...(/^node(\.exe)?$/i.test(basename(this.spec.command)) ? [`--title=headroom-mcp-${this.name}`] : []), ...(this.spec.args ?? [])],
      env: { ...env, ...this.spec.env, HEADROOM_MCP_SERVER: this.name },
      stderr: "pipe",
      ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}),
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) this.#stderr.push(line.slice(0, 500));
      this.#stderr.splice(0, Math.max(0, this.#stderr.length - STDERR_LINES));
    });
    // The gateway can ask a person: it sends each question of the server to the session of the call.
    const client = new clientModule.Client({ name: "headroom-gateway", version: "0.1.0" }, { capabilities: { elicitation: {} } });
    client.onclose = () => {
      // A stop sets the client to null first. Thus only an unexpected exit is a failure.
      if (this.#client !== client) return;
      this.#client = null;
      this.#pid = null;
      this.#startedAt = null;
      this.#fail(new Error("the server process stopped"), "exit");
    };
    client.setNotificationHandler(types.ToolListChangedNotificationSchema, async () => this.#each((server) => server.sendToolListChanged()));
    client.setNotificationHandler(types.PromptListChangedNotificationSchema, async () => this.#each((server) => server.sendPromptListChanged()));
    client.setNotificationHandler(types.ResourceListChangedNotificationSchema, async () => this.#each((server) => server.sendResourceListChanged()));
    client.setNotificationHandler(types.ResourceUpdatedNotificationSchema, async (notification) =>
      this.#each((server) => server.sendResourceUpdated(notification.params)),
    );
    const handle = client.setRequestHandler.bind(client) as unknown as SetHandler;
    handle(types.ElicitRequestSchema, (request) => this.#elicit(request, types.ElicitResultSchema));
    try {
      await client.connect(transport, { timeout: START_TIMEOUT_MS });
    } catch (error) {
      if (transport.pid !== null) killTree(transport.pid);
      await client.close().catch(() => undefined);
      this.#fail(error, "start");
      throw new Error(`The MCP server ${this.name} did not start: ${message(error)}`);
    }
    this.#info = {
      capabilities: client.getServerCapabilities() ?? {},
      serverInfo: client.getServerVersion() ?? { name: this.name, version: "0.0.0" },
      instructions: client.getInstructions(),
    };
    this.#client = client;
    this.#pid = transport.pid;
    this.#startedAt = Date.now();
    this.#failures = 0;
    this.#error = null;
    this.#failure = null;
    this.#log(`The MCP server ${this.name} runs as process ${this.#pid ?? "?"}.`);
    return client;
  }
}

/** This function sends the requests of a session for each capability of the server to the server. */
function forwardRequests(session: Session, upstream: Upstream, capabilities: ServerCapabilities, types: Sdk["types"]): void {
  const pairs: [unknown, unknown][] = [];
  if (capabilities.tools) {
    pairs.push([types.ListToolsRequestSchema, types.ListToolsResultSchema], [types.CallToolRequestSchema, types.CallToolResultSchema]);
  }
  if (capabilities.resources) {
    pairs.push(
      [types.ListResourcesRequestSchema, types.ListResourcesResultSchema],
      [types.ListResourceTemplatesRequestSchema, types.ListResourceTemplatesResultSchema],
      [types.ReadResourceRequestSchema, types.ReadResourceResultSchema],
    );
    if (capabilities.resources.subscribe) {
      pairs.push([types.SubscribeRequestSchema, types.EmptyResultSchema], [types.UnsubscribeRequestSchema, types.EmptyResultSchema]);
    }
  }
  if (capabilities.prompts) {
    pairs.push([types.ListPromptsRequestSchema, types.ListPromptsResultSchema], [types.GetPromptRequestSchema, types.GetPromptResultSchema]);
  }
  if (capabilities.completions) pairs.push([types.CompleteRequestSchema, types.CompleteResultSchema]);
  const handle = session.server.setRequestHandler.bind(session.server) as unknown as SetHandler;
  for (const [requestSchema, resultSchema] of pairs) {
    handle(requestSchema, async (request, extra) => {
      session.inFlight.add(extra.requestId);
      try {
        return await upstream.forward(request, resultSchema, extra);
      } finally {
        session.inFlight.delete(extra.requestId);
      }
    });
  }
}

/** The capabilities that a session gets: those of the server that the gateway forwards. */
function forwardedCapabilities(capabilities: ServerCapabilities): ServerCapabilities {
  return {
    ...(capabilities.tools ? { tools: capabilities.tools } : {}),
    ...(capabilities.resources ? { resources: capabilities.resources } : {}),
    ...(capabilities.prompts ? { prompts: capabilities.prompts } : {}),
    ...(capabilities.completions ? { completions: capabilities.completions } : {}),
    ...(capabilities.logging ? { logging: capabilities.logging } : {}),
  };
}

function refuse(res: ServerResponse, status: number, code: string, text: string): true {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
  }
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: text, data: { code } }, id: null }));
  return true;
}

/** The options of the gateway. */
export interface GatewayOptions {
  /** This function gives the configured servers by name. The gateway reads it at each new session. */
  readonly specs: () => Record<string, McpServerSpec>;
  readonly log?: ((line: string) => void) | undefined;
}

/** The gateway: the servers, their sessions and the face that serves them. */
export class McpGateway {
  readonly #specs: () => Record<string, McpServerSpec>;
  readonly #log: (line: string) => void;
  readonly #upstreams = new Map<string, Upstream>();

  constructor(options: GatewayOptions) {
    this.#specs = options.specs;
    this.#log = options.log ?? (() => undefined);
  }

  /** This function gives the state of each configured server. */
  list(): McpServerState[] {
    const specs = this.#specs();
    return Object.keys(specs)
      .sort()
      .map((name) => this.#upstreams.get(name)?.state() ?? new Upstream(name, specs[name] as McpServerSpec, this.#log).state());
  }

  /** This function gives the process of each running server, with its name. The engine gives their memory to the owner `mcp:<name>`. */
  pids(): Map<number, string> {
    const pids = new Map<number, string>();
    for (const upstream of this.#upstreams.values()) if (upstream.pid !== null) pids.set(upstream.pid, upstream.name);
    return pids;
  }

  /**
   * This function starts servers before the first request, and waits until each answers its `initialize` request.
   * Without names, it starts each configured server. A server that fails does not stop the others.
   * The function gives the state of each configured server. It ignores a name that has no configuration.
   */
  async warm(names?: readonly string[]): Promise<McpServerState[]> {
    const wanted = names ?? Object.keys(this.#specs());
    await Promise.allSettled(
      wanted.map(async (name) => {
        const upstream = this.#upstream(name);
        if (upstream) await upstream.client();
      }),
    );
    return this.list();
  }

  /** This function stops a server and closes its sessions, for example after a change of its spec or its removal. */
  async reset(name: string): Promise<void> {
    const upstream = this.#upstreams.get(name);
    this.#upstreams.delete(name);
    await upstream?.close();
  }

  /** This function stops a server. Its sessions stay open, and the next request starts it again. */
  async restart(name: string): Promise<void> {
    await this.#upstreams.get(name)?.stop();
  }

  /** This function closes the idle sessions and stops the idle servers. */
  async sweep(now: number = Date.now()): Promise<void> {
    for (const upstream of this.#upstreams.values()) await upstream.sweep(now);
  }

  /** This function closes each session and stops each server. */
  async close(): Promise<void> {
    const upstreams = [...this.#upstreams.values()];
    this.#upstreams.clear();
    await Promise.all(upstreams.map((upstream) => upstream.close()));
  }

  /** This function answers one request of the path of a server. */
  async handle(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const upstream = this.#upstream(name);
    if (!upstream) {
      refuse(res, 404, "NOT_FOUND", `The gateway has no MCP server ${name}. Add it with: headroom mcp add ${name} -- <command>`);
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    let transport: StreamableHTTPServerTransport;
    if (typeof sessionId === "string") {
      const session = upstream.sessions.get(sessionId);
      if (!session) {
        refuse(res, 404, "SESSION_NOT_FOUND", "No session: start one with an initialize request");
        return;
      }
      session.seenAt = Date.now();
      transport = session.transport;
    } else if (req.method === "POST") {
      transport = await this.#open(upstream);
    } else {
      refuse(res, 400, "NO_SESSION", "Start a session with an initialize request");
      return;
    }
    await transport.handleRequest(req, res);
  }

  /** This function gives the face of the gateway for the host of the daemon. */
  face(): HostFaceFactory {
    return (context) => {
      let open = true;
      const timer = setInterval(() => {
        this.sweep().catch((error: unknown) => this.#log(`The sweep of the MCP gateway failed: ${message(error)}`));
      }, 60_000);
      timer.unref();
      const handler = (req: IncomingMessage, res: ServerResponse): boolean => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (!path.startsWith(GATEWAY_PATH)) return false;
        // A web page must not reach the servers: the host and the origin of the request.
        const guard = checkBrowserRequest(req, {}, false, false);
        if (!guard.ok) return refuse(res, guard.status, guard.code, guard.message);
        const token = context.policy.token;
        if (token !== undefined && !tokenMatches(token, bearerOf(req.headers["authorization"]))) {
          return refuse(res, 401, "UNAUTHORIZED", "Unauthorized: send the token of headroom (headroom mcp config <name>)");
        }
        if (!open) return refuse(res, 503, "UNAVAILABLE", "headroom stops");
        const name = decodeURIComponent(path.slice(GATEWAY_PATH.length)).replace(/\/+$/, "");
        this.handle(name, req, res).catch((error: unknown) => {
          refuse(res, 502, "BAD_GATEWAY", message(error));
        });
        return true;
      };
      return {
        handler,
        endpoint: { type: "mcp", scheme: "http", path: GATEWAY_PATH },
        parts: {
          start: async () => undefined,
          stopIntake: () => {
            open = false;
          },
          drain: async () => undefined,
          inFlight: () => 0,
          close: async () => {
            clearInterval(timer);
            await this.close();
          },
        },
      };
    };
  }

  /** This function gives the upstream of a configured server, and follows a change of its spec. */
  #upstream(name: string): Upstream | undefined {
    const spec = SERVER_NAME.test(name) ? this.#specs()[name] : undefined;
    const upstream = this.#upstreams.get(name);
    if (!spec) {
      if (upstream) this.reset(name).catch(() => undefined);
      return undefined;
    }
    if (upstream && JSON.stringify(upstream.spec) === JSON.stringify(spec)) return upstream;
    if (upstream) this.reset(name).catch(() => undefined);
    const created = new Upstream(name, spec, this.#log);
    this.#upstreams.set(name, created);
    return created;
  }

  /** This function opens an MCP session for a Claude Code session: an MCP server of its own, with the data of the one copy. */
  async #open(upstream: Upstream): Promise<StreamableHTTPServerTransport> {
    const { server: serverModule, http, types } = await loadSdk();
    const info = await upstream.info();
    const server = new serverModule.Server(info.serverInfo, {
      capabilities: forwardedCapabilities(info.capabilities),
      ...(info.instructions ? { instructions: info.instructions } : {}),
    });
    const transport: StreamableHTTPServerTransport = new http.StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        upstream.sessions.set(id, session);
      },
    });
    const session: Session = { transport, server, inFlight: new Set(), seenAt: Date.now() };
    forwardRequests(session, upstream, info.capabilities, types);
    // The SDK types of the transport do not compile under `exactOptionalPropertyTypes`.
    await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
    server.onclose = () => {
      if (transport.sessionId) upstream.sessions.delete(transport.sessionId);
    };
    return transport;
  }
}
