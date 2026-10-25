import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The hook of the plugin, started as Claude Code starts it: a process with the event as JSON on stdin.
const hook = join(import.meta.dirname, "..", "..", "..", "plugins", "headroom", "hooks", "route.mjs");

describe("the hook of the plugin", () => {
  let server: Server;
  let home = "";
  let status = { free: { memory: 8000 }, leases: [] as { state: string }[] };

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(req.headers.authorization === "Bearer t" ? JSON.stringify(status) : "{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    home = mkdtempSync(join(tmpdir(), "headroom-hook-"));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: 1, endpoint, token: "t", startedAt: "" }));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  // An asynchronous start: the fake daemon in this process must answer while the hook runs.
  const run = (command: string, headroomHome = home): Promise<string> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [hook], { env: { ...process.env, HEADROOM_HOME: headroomHome } });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      child.on("close", () => resolve(out.trim()));
      child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
    });

  it("lets a light command go on", async () => {
    status = { free: { memory: 100 }, leases: [{ state: "waiting" }] };
    expect(await run("git status")).toBe("");
  });

  it("lets a heavy command go on when the memory has room", async () => {
    status = { free: { memory: 8000 }, leases: [] };
    expect(await run("pnpm test")).toBe("");
  });

  it("refuses a heavy command when the memory is tight, with the form under a lease", async () => {
    status = { free: { memory: 1200 }, leases: [] };
    const output = JSON.parse(await run("cd packages/core && pnpm exec vitest run")) as { hookSpecificOutput: Record<string, string> };
    expect(output.hookSpecificOutput["permissionDecision"]).toBe("deny");
    expect(output.hookSpecificOutput["permissionDecisionReason"]).toContain("only 1200 MB is free for a lease");
    expect(output.hookSpecificOutput["permissionDecisionReason"]).toContain("Send it again as: cd packages/core && headroom run --mem auto -- pnpm exec vitest run");
  });

  it("refuses a heavy command when other jobs wait for memory", async () => {
    status = { free: { memory: 9000 }, leases: [{ state: "granted" }, { state: "waiting", reason: "waits for memory: needs 2048, 900 free" }] };
    expect(await run("npx playwright test e2e")).toContain("1 job already wait");
  });

  it("lets a heavy command go on when the other jobs wait only for a slot", async () => {
    status = { free: { memory: 9000 }, leases: [{ state: "waiting", reason: "waits for browser: needs 1, 0 free" }] };
    expect(await run("pnpm test")).toBe("");
  });

  it("lets a command under headroom run go on, and lets each command go on without a daemon", async () => {
    status = { free: { memory: 100 }, leases: [] };
    expect(await run("headroom run --mem 2g -- pnpm test")).toBe("");
    expect(await run("pnpm test", mkdtempSync(join(tmpdir(), "headroom-none-")))).toBe("");
  });
});

describe("the lease form of a command line", () => {
  it("puts headroom run in front of the heavy part, after its variables", async () => {
    const { leased } = (await import(pathToFileURL(hook).href)) as { leased: (command: string) => string };
    expect(leased("pnpm test")).toBe("headroom run --mem auto -- pnpm test");
    expect(leased("cd app && CI=1 pnpm exec vitest run | tail -5")).toBe("cd app && CI=1 headroom run --mem auto -- pnpm exec vitest run | tail -5");
    expect(leased("git pull; npx playwright test e2e/x.spec.ts")).toBe("git pull; headroom run --mem auto -- npx playwright test e2e/x.spec.ts");
  });
});
