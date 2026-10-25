import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { HostFaceContext } from "@procedures/peer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { descendantsOf, killTree, McpGateway } from "./gateway.ts";

const fixture = join(import.meta.dirname, "fixtures", "counter-server.mjs");
const specs = { counter: { command: process.execPath, args: [fixture] } };

interface Counted {
  readonly count: number;
  readonly pid: number;
}

function counted(result: unknown): Counted & Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]?.text ?? "{}") as Counted & Record<string, unknown>;
}

describe("McpGateway", () => {
  let http: HttpServer;
  let gateway: McpGateway;
  let base = "";
  const clients: Client[] = [];

  const connect = async (answer?: boolean): Promise<Client> => {
    const client = new Client({ name: "test", version: "1.0.0" }, answer === undefined ? {} : { capabilities: { elicitation: {} } });
    if (answer !== undefined) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { ok: answer } }));
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/counter`), { requestInit: { headers: { Authorization: "Bearer secret" } } });
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    gateway = new McpGateway({ specs: () => specs });
    const face = gateway.face()({ policy: { token: "secret" } } as unknown as HostFaceContext);
    http = createServer((req, res) => {
      if (!face.handler?.(req, res)) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await gateway.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });

  it("serves one copy of a server to two sessions", async () => {
    const a = await connect();
    const b = await connect();
    expect((await a.listTools()).tools.map((tool) => tool.name)).toEqual(["count", "confirm"]);
    expect(a.getInstructions()).toBe("Counts the calls.");
    const first = counted(await a.callTool({ name: "count", arguments: {} }));
    const second = counted(await b.callTool({ name: "count", arguments: {} }));
    expect(second.pid).toBe(first.pid);
    expect(second.count).toBe(first.count + 1);
    expect([...gateway.pids()]).toEqual([[first.pid, "counter"]]);
    expect(gateway.list()[0]).toMatchObject({ name: "counter", state: "running", sessions: 2, pid: first.pid });
  });

  it("sends the progress of a call to its session", async () => {
    const client = await connect();
    const seen: number[] = [];
    await client.callTool({ name: "count", arguments: { steps: 3 } }, undefined, { onprogress: (progress) => seen.push(progress.progress) });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("sends a question of the server to the session of the call", async () => {
    const asks = await connect(true);
    expect(counted(await asks.callTool({ name: "confirm", arguments: {} }))).toEqual({ action: "accept", content: { ok: true } });
    // A session without the elicitation capability cannot answer: the server gets `decline`.
    const silent = await connect();
    expect(counted(await silent.callTool({ name: "confirm", arguments: {} }))).toMatchObject({ action: "decline" });
  });

  it("refuses a request without the token, and a web page", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await fetch(`${base}/mcp/counter`, { method: "POST", headers, body })).status).toBe(401);
    const page = { ...headers, Authorization: "Bearer secret", Origin: "https://example.com" };
    expect((await fetch(`${base}/mcp/counter`, { method: "POST", headers: page, body })).status).toBe(403);
  });

  it("answers 404 for a server that is not configured", async () => {
    const headers = { "content-type": "application/json", Authorization: "Bearer secret" };
    const res = await fetch(`${base}/mcp/nothing`, { method: "POST", headers, body: "{}" });
    expect(res.status).toBe(404);
  });

  it("starts the server again after it stops", async () => {
    const client = await connect();
    const before = counted(await client.callTool({ name: "count", arguments: {} }));
    killTree(before.pid);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = counted(await client.callTool({ name: "count", arguments: {} }));
    expect(after.pid).not.toBe(before.pid);
    expect(after.count).toBe(1);
  });
});

describe("the stdio bridge", () => {
  let http: HttpServer;
  let gateway: McpGateway;
  let home = "";
  const clients: Client[] = [];

  beforeAll(async () => {
    gateway = new McpGateway({ specs: () => specs });
    const face = gateway.face()({ policy: { token: "secret" } } as unknown as HostFaceContext);
    http = createServer((req, res) => {
      if (!face.handler?.(req, res)) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    home = mkdtempSync(join(tmpdir(), "headroom-bridge-"));
    const endpoint = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api`;
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: process.pid, endpoint, token: "secret", startedAt: new Date().toISOString() }));
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await gateway.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });

  const bridged = async (name = "counter", local: readonly string[] = []): Promise<Client> => {
    const client = new Client({ name: "bridged", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, "bridge.mjs"), name, ...(local.length > 0 ? ["--", ...local] : [])],
      env: { ...(process.env as Record<string, string>), HEADROOM_HOME: home },
    });
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    clients.push(client);
    return client;
  };

  it("connects a stdio client to the one copy", async () => {
    const a = await bridged();
    const b = await bridged();
    expect((await a.listTools()).tools.map((tool) => tool.name)).toEqual(["count", "confirm"]);
    const first = counted(await a.callTool({ name: "count", arguments: {} }));
    const second = counted(await b.callTool({ name: "count", arguments: {} }));
    expect(second.pid).toBe(first.pid);
    const seen: number[] = [];
    await a.callTool({ name: "count", arguments: { steps: 2 } }, undefined, { onprogress: (progress) => seen.push(progress.progress) });
    expect(seen).toEqual([1, 2]);
  });

  it("starts the local command only when the gateway does not serve the server", async () => {
    const local = [process.execPath, fixture];
    const shared = counted(await (await bridged("counter", local)).callTool({ name: "count", arguments: {} }));
    expect(gateway.pids().has(shared.pid)).toBe(true);
    const own = counted(await (await bridged("unknown", local)).callTool({ name: "count", arguments: {} }));
    expect(gateway.pids().has(own.pid)).toBe(false);
    expect(own.count).toBe(1);
  });

  it("opens a new session when the gateway lost the old one", async () => {
    const client = await bridged();
    const before = counted(await client.callTool({ name: "count", arguments: {} }));
    await gateway.reset("counter");
    const after = counted(await client.callTool({ name: "count", arguments: {} }));
    expect(after.pid).not.toBe(before.pid);
    expect(after.count).toBe(1);
  });

  it("opens one new session for two requests that lost the old session at the same time", async () => {
    const client = await bridged();
    await client.callTool({ name: "count", arguments: {} });
    await gateway.reset("counter");
    const results = await Promise.all([client.callTool({ name: "count", arguments: {} }), client.callTool({ name: "count", arguments: {} })]);
    expect(results.map((result) => counted(result).count).sort()).toEqual([1, 2]);
    expect(gateway.list().find((state) => state.name === "counter")?.sessions).toBe(1);
  });
});

describe("the idle sweep", () => {
  it("does not stop a server while a call is open, and stops it after the call", async () => {
    const swept = new McpGateway({ specs: () => specs });
    const face = swept.face()({ policy: { token: undefined } } as unknown as HostFaceContext);
    const server = createServer((req, res) => {
      if (!face.handler?.(req, res)) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new Client({ name: "test", version: "1.0.0" });
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/counter`);
    await client.connect(new StreamableHTTPClientTransport(url) as unknown as Parameters<Client["connect"]>[0]);
    try {
      // The default idle time is 30 minutes. The sweep runs 31 minutes later, while the call sends its progress.
      const later = (): number => Date.now() + 31 * 60_000;
      let progressed = (): void => undefined;
      const started = new Promise<void>((resolve) => {
        progressed = () => resolve();
      });
      const call = client.callTool({ name: "count", arguments: { steps: 5 } }, undefined, { onprogress: () => progressed() });
      await started;
      await swept.sweep(later());
      const result = counted(await call);
      expect(swept.list()[0]).toMatchObject({ state: "running", pid: result.pid });
      await swept.sweep(later());
      expect(swept.list()[0]?.state).toBe("stopped");
    } finally {
      await client.close();
      await swept.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("killTree", () => {
  it("finds the descendants of a process in the table of ps", () => {
    const table = "    1     0\n   10     1\n   11    10\n   12    11\n   13    10\n   20     1\n";
    expect(descendantsOf(10, table).sort((a, b) => a - b)).toEqual([11, 12, 13]);
    expect(descendantsOf(20, table)).toEqual([]);
  });

  it("stops a process and its grandchild", async () => {
    const script =
      'const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);';
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    const grandchild = await new Promise<number>((resolve) => child.stdout.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(grandchild)).toBe(true);
    killTree(child.pid ?? 0);
    const deadline = Date.now() + 5000;
    while (alive(grandchild) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(grandchild)).toBe(false);
  });
});

describe("the warm-up of the servers", () => {
  it("starts each configured server with no session, and a failed server does not stop the others", async () => {
    const broken = { command: process.execPath, args: ["-e", "process.exit(3)"] };
    const warmed = new McpGateway({ specs: () => ({ ...specs, broken }) });
    try {
      const states = await warmed.warm();
      const counter = states.find((state) => state.name === "counter");
      expect(counter).toMatchObject({ state: "running", sessions: 0 });
      expect([...warmed.pids()]).toEqual([[counter?.pid, "counter"]]);
      expect(warmed.list().find((state) => state.name === "broken")).toMatchObject({ state: "waiting", failures: 1 });
    } finally {
      await warmed.close();
    }
  });
});

describe("the marks of a server process", () => {
  it("starts a Node server with the title headroom-mcp-<name> and the variable HEADROOM_MCP_SERVER", async () => {
    const marked = new McpGateway({ specs: () => ({ marked: { command: process.execPath, args: [fixture] } }) });
    const face = marked.face()({ policy: { token: undefined } } as unknown as HostFaceContext);
    const server = createServer((req, res) => {
      if (!face.handler?.(req, res)) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new Client({ name: "test", version: "1.0.0" });
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/marked`);
    await client.connect(new StreamableHTTPClientTransport(url) as unknown as Parameters<Client["connect"]>[0]);
    const result = counted(await client.callTool({ name: "count", arguments: {} }));
    expect(result).toMatchObject({ title: "headroom-mcp-marked", server: "marked" });
    await client.close();
    await marked.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
});
