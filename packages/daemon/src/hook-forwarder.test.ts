import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_CLIENT, HOOK_HEADER, HOOK_PATH } from "./hook-face.ts";
import { leased } from "./hook-rating.ts";

const FORWARDER = join(import.meta.dirname, "..", "..", "..", "plugins", "headroom", "hooks", "route.ts");
const event = (command: string): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const DENY = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "from the route" } };

/** The fake daemon: with the route of H194 ("new"), or from before it ("old"). */
let mode: "new" | "old" = "new";
let seen: { path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
let server: Server;
let home = "";

/** This function starts the forwarder with an input, as Claude Code starts the command hook. */
function forward(input: string, env: Record<string, string> = { HEADROOM_HOME: home }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [FORWARDER], { env: { ...process.env, ...env }, timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      if (req.url === HOOK_PATH && mode === "new") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(DENY));
      } else if (req.url === "/api/resources/status" && mode === "old") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ free: { memory: 1000 }, leases: [] }));
      } else res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  home = mkdtempSync(join(tmpdir(), "headroom-forwarder-"));
  const { port } = server.address() as AddressInfo;
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: 1, endpoint: `http://127.0.0.1:${port}/api`, token: "secret", startedAt: 0 }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
});

describe("the forwarder of the old command hook (H194)", () => {
  it("posts the hook input to the route of the daemon and writes its answer", async () => {
    mode = "new";
    const input = event("pnpm test");
    expect(await forward(input)).toEqual({ code: 0, stdout: JSON.stringify(DENY), stderr: "" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ path: HOOK_PATH, body: input });
    expect(seen[0]?.headers[HOOK_HEADER]).toBe(HOOK_CLIENT);
  });

  it("rates the command with the one copy of the rating when the daemon has no route (404)", async () => {
    mode = "old";
    const heavy = await forward(event("pnpm test"));
    expect(heavy.code).toBe(0);
    expect(heavy.stderr).toBe("");
    const output = JSON.parse(heavy.stdout) as typeof DENY;
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("only 1000 MB is free");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(leased("pnpm test"));
    expect(seen.map((request) => request.path)).toEqual([HOOK_PATH, "/api/resources/status"]);
    expect(seen[1]?.headers["authorization"]).toBe("Bearer secret");
  });

  it("asks no status for a light command when the daemon has no route", async () => {
    mode = "old";
    expect(await forward(event("git status"))).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(seen.map((request) => request.path)).toEqual([HOOK_PATH]);
  });

  it("writes nothing and ends with 0 when the daemon file is missing, the daemon is down or the input is not JSON", async () => {
    const empty = mkdtempSync(join(tmpdir(), "headroom-forwarder-none-"));
    try {
      expect(await forward(event("pnpm test"), { HEADROOM_HOME: empty })).toEqual({ code: 0, stdout: "", stderr: "" });
      writeFileSync(join(empty, "daemon.json"), JSON.stringify({ endpoint: "http://127.0.0.1:1/api", token: "x" }));
      expect(await forward(event("pnpm test"), { HEADROOM_HOME: empty })).toEqual({ code: 0, stdout: "", stderr: "" });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    mode = "old";
    expect(await forward("{not json")).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
