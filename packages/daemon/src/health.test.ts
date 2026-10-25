import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_HEALTH, nextHealth, type ServiceHealth } from "@headroom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServerState } from "./gateway.ts";
import { dockerCheck, failedProbe, lastErrorLine, MCP_EXITS_DOWN, mcpProbe, serviceChecks, urlCheck } from "./health.ts";
import { healthChange, healthLines, servicesLine, servicesTable } from "./services-cli.ts";

const server = (state: McpServerState["state"], extra: Partial<McpServerState> = {}): McpServerState => ({
  name: "vex", spec: { command: "node" }, state, pid: null, sessions: 0, requests: 0, startedAt: null, usedAt: null,
  failures: 0, error: null, failure: null, exits: 0, stderr: [], ...extra,
});

describe("mcpProbe", () => {
  it("makes a server that the gateway stopped for idle idle, not down", () => {
    expect(mcpProbe(server("stopped")).state).toBe("idle");
    expect(mcpProbe(server("running", { pid: 42 })).state).toBe("ok");
    expect(mcpProbe(server("starting")).state).toBe("ok");
  });

  it("makes a server that did not start down, with the last error line of its stderr", () => {
    const failed = server("waiting", {
      failures: 1, failure: "start", error: "MCP error -32000: Connection closed",
      stderr: ["node:internal/modules/cjs/loader:1228", "Error: Cannot find module 'zod'", "    at Module._resolveFilename"],
    });
    expect(mcpProbe(failed)).toEqual({ state: "down", latencyMs: null, error: "Error: Cannot find module 'zod'" });
    expect(lastErrorLine(server("waiting", { error: "the server process stopped" }))).toBe("the server process stopped");
  });

  it("makes one exit idle, because the next request starts the server, and many exits down", () => {
    const exited = server("waiting", { failures: 1, failure: "exit", error: "the server process stopped", exits: 1 });
    expect(mcpProbe(exited).state).toBe("idle");
    expect(mcpProbe({ ...exited, exits: MCP_EXITS_DOWN }).state).toBe("down");
  });
});

describe("the checks of the daemon", () => {
  let http: Server;
  let base = "";
  beforeAll(async () => {
    http = createServer((req, res) => {
      res.statusCode = req.url === "/broken" ? 503 : 200;
      res.end("OK");
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));

  it("gives ok for a URL that answers, and down for a status of 500 or more", async () => {
    const signal = new AbortController().signal;
    const good = await urlCheck("fleet-site", `${base}/`).run(signal);
    expect(good.state).toBe("ok");
    expect(good.latencyMs).toBeGreaterThanOrEqual(0);
    expect(await urlCheck("site", `${base}/broken`).run(signal)).toMatchObject({ state: "down", error: "HTTP 503" });
  });

  it("gives absent for no pipe and down for each other error, and has the checks of one round in order", () => {
    expect(failedProbe(Object.assign(new Error("connect ENOENT \\\\.\\pipe\\docker_engine"), { code: "ENOENT" }), true)).toEqual({ state: "absent", latencyMs: null, error: null });
    expect(failedProbe(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), true).state).toBe("down");
    expect(failedProbe(Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }), false).state).toBe("down");
    const checks = serviceChecks(DEFAULT_HEALTH, [server("stopped"), server("running", { name: "loom" })], "/nowhere/docker.sock");
    expect(checks.map((check) => [check.name, check.type, check.critical])).toEqual([
      ["docker", "docker", true],
      ["fleet-site", "url", false],
      ["mcp:vex", "mcp", true],
      ["mcp:loom", "mcp", true],
    ]);
    expect(dockerCheck("/nowhere/docker.sock")).toMatchObject({ title: "The Docker engine", target: "/nowhere/docker.sock" });
  });
});

describe("headroom services", () => {
  const at = Date.UTC(2026, 9, 24, 18, 45);
  const health = (name: string, state: "ok" | "down" | "idle", latencyMs: number | null, error: string | null = null): ServiceHealth =>
    nextHealth(undefined, { name, type: "url", title: name, target: null, critical: false, run: async () => ({ state, latencyMs, error }) }, { state, latencyMs, error }, at - 180_000);

  it("gives the services line of headroom status", () => {
    const list = [health("docker", "ok", 12), health("fleet-site", "ok", 3), health("mcp:vex", "ok", null), health("mcp:loom", "idle", null)];
    expect(servicesLine(list)).toBe("Services: docker ok (12 ms), fleet-site ok (3 ms), mcp:vex ok, mcp:loom idle.");
    expect(servicesLine([health("docker", "down", null, "No answer in 3 s")])).toBe("Services: docker down since 18:42 UTC.");
    expect(servicesLine([])).toBeNull();
  });

  it("gives one row for each service, with the state, the latency, the start of the state and the last error", () => {
    const rows = servicesTable([health("docker", "down", null, "No answer in 3 s"), health("fleet-site", "ok", 3)], at);
    expect(rows[0]).toMatch(/^SERVICE\s+STATE\s+LATENCY\s+SINCE \(UTC\)\s+LAST OK\s+LAST ERROR$/);
    expect(rows[1]).toMatch(/^docker\s+down\s+-\s+18:42 \(3 min\)\s+-\s+18:42 No answer in 3 s$/);
    expect(rows[2]).toMatch(/^fleet-site\s+ok\s+3 ms\s+18:42 \(3 min\)\s+18:42\s+-$/);
    expect(rows.at(-1)).toBe("The last check was 3 min ago. headroom does not restart a service.");
    expect(servicesTable([], at)).toEqual(["No check of the services yet. The daemon checks them every 30 seconds."]);
  });

  it("changes the setting health: add, remove, back to the default", () => {
    const current = { "fleet-site": "http://127.0.0.1:4731/" };
    expect(healthChange(current, "grafana", "http://localhost:3000/", false)).toEqual({ ...current, grafana: "http://localhost:3000/" });
    expect(healthChange(current, "fleet-site", undefined, true)).toEqual({});
    expect(healthChange(current, undefined, undefined, true)).toBeNull();
    expect(healthChange(current, undefined, undefined, false)).toBeUndefined();
    expect(healthChange(current, "unknown", undefined, true)).toBeUndefined();
    expect(healthChange(current, "grafana", undefined, false)).toBeUndefined();
    expect(healthLines({})).toEqual(["health: (none: the monitor checks no URL)"]);
  });
});
