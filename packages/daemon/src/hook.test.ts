import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { HostFaceContext } from "@procedures/peer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PORT } from "./daemon.ts";
import { HOOK_CLIENT, HOOK_HEADER, HOOK_PATH, hookAnswer, hookFace } from "./hook-face.ts";
import { FALSE_CASES, HEAVY_CASES, LEASE_CASES, VERDICT_COMMANDS } from "./fixtures/hook-commands.ts";
import { hookOutput, isHeavy, leased, type Status } from "./hook-rating.ts";

const event = (command: unknown): unknown => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

describe("the rating of a command line (H55)", () => {
  it.each(FALSE_CASES)("does not rate %j as heavy", (command) => {
    expect(isHeavy(command)).toBe(false);
  });

  it.each(HEAVY_CASES)("rates %j as heavy", (command) => {
    expect(isHeavy(command)).toBe(true);
  });
});

describe("the lease form of a command line (H52)", () => {
  it.each(LEASE_CASES)("puts headroom run in front of each heavy part of %j", (command, form) => {
    expect(leased(command)).toBe(form);
  });
});

describe("the verdicts of the hook over HTTP and of the old process hook (H194)", () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "hook-golden.json"), "utf8")) as {
    commands: string[];
    statuses: Record<string, Status | null>;
    verdicts: Record<string, (string | null)[]>;
  };

  it("has a golden verdict for each command of the fixtures, in the same order", () => {
    expect(golden.commands).toEqual(VERDICT_COMMANDS);
    for (const verdicts of Object.values(golden.verdicts)) expect(verdicts).toHaveLength(VERDICT_COMMANDS.length);
  });

  const cases = Object.entries(golden.statuses).flatMap(([name, status]) =>
    golden.commands.map((command, index) => ({ name, status, command, verdict: golden.verdicts[name]![index] ?? null })),
  );
  it.each(cases)("gives the verdict of the old hook for $command under the status $name", ({ status, command, verdict }) => {
    const output = hookOutput(event(command), () => status);
    expect(output).toEqual(
      verdict === null ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict } },
    );
  });

  it("reads the status only for a heavy command that does not run under headroom run", () => {
    let reads = 0;
    const status = (): Status => {
      reads += 1;
      return { free: { memory: 100 }, leases: [] };
    };
    hookOutput(event("git status"), status);
    hookOutput(event("headroom run --mem 2g -- pnpm test"), status);
    expect(reads).toBe(0);
    hookOutput(event("pnpm test"), status);
    expect(reads).toBe(1);
  });

  it("lets an event with no command, or a command that is not a string, go on as the old hook did", () => {
    const tight = (): Status => ({ free: { memory: 100 }, leases: [] });
    expect(hookOutput({}, tight)).toEqual({});
    expect(hookOutput(null, tight)).toEqual({});
    expect(hookOutput(event(42), tight)).toEqual({});
  });
});

describe("the face of the hook on the daemon (H194)", () => {
  let server: Server;
  let port = 0;
  let status: () => Status | null = () => ({ free: { memory: 8000 }, leases: [] });

  beforeAll(async () => {
    const face = hookFace({ status: () => status() })({} as HostFaceContext);
    server = createServer((req, res) => {
      if (face.handler?.(req, res) !== true) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  // A request as Claude Code sends it: POST with the event as JSON. `host` and `headers` change one part of it.
  const send = (body: string, options: { method?: string; path?: string; headers?: Record<string, string> } = {}): Promise<{ code: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: options.method ?? "POST",
          path: options.path ?? HOOK_PATH,
          headers: { "content-type": "application/json", [HOOK_HEADER]: HOOK_CLIENT, ...options.headers },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
          res.on("end", () => resolve({ code: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      req.end(options.method === "GET" ? undefined : body);
    });

  it("refuses a heavy command when the memory is tight, with a 2xx answer and the form under a lease", async () => {
    status = () => ({ free: { memory: 1200 }, leases: [] });
    const answer = await send(JSON.stringify(event("cd packages/core && pnpm exec vitest run")));
    expect(answer.code).toBe(200);
    const output = JSON.parse(answer.body) as { hookSpecificOutput: Record<string, string> };
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(output.hookSpecificOutput["permissionDecisionReason"]).toContain("only 1200 MB is free for a lease");
    expect(output.hookSpecificOutput["permissionDecisionReason"]).toContain(
      "Send it again as: cd packages/core && headroom run --mem auto -- pnpm exec vitest run",
    );
  });

  it("lets a light command go on with an empty object", async () => {
    status = () => ({ free: { memory: 100 }, leases: [{ state: "waiting", reason: "waits for memory: needs 1, 0 free" }] });
    expect(await send(JSON.stringify(event("git status")))).toEqual({ code: 200, body: "{}" });
  });

  it("lets a heavy command go on when the status fails, as the old hook did with no daemon", async () => {
    status = () => {
      throw new Error("the engine is closed");
    };
    expect(await send(JSON.stringify(event("pnpm test")))).toEqual({ code: 200, body: "{}" });
  });

  it("answers 403 for a host that is not 127.0.0.1 or localhost", async () => {
    const answer = await send(JSON.stringify(event("pnpm test")), { headers: { host: "example.com" } });
    expect(answer.code).toBe(403);
  });

  it("answers 403 for a request with no header of the hook, or a different value", async () => {
    expect((await send(JSON.stringify(event("pnpm test")), { headers: { [HOOK_HEADER]: "" } })).code).toBe(403);
    expect((await send(JSON.stringify(event("pnpm test")), { headers: { [HOOK_HEADER]: "page" } })).code).toBe(403);
  });

  it("answers 405 for a method that is not POST, and 400 for a body that is not JSON", async () => {
    expect((await send("", { method: "GET" })).code).toBe(405);
    expect((await send("{not json")).code).toBe(400);
  });

  it("does not take a path that is not its own", async () => {
    expect((await send("{}", { path: `${HOOK_PATH}/x` })).code).toBe(404);
  });

  it("gives the same answer as hookAnswer, which the route uses", () => {
    const tight = (): Status => ({ free: { memory: 100 }, leases: [] });
    expect(hookAnswer(JSON.stringify(event("pnpm test")), tight).code).toBe(200);
    expect(hookAnswer("", tight)).toEqual({ code: 200, json: "{}" });
  });
});

describe("the hook of the plugin (H194)", () => {
  const root = join(import.meta.dirname, "..", "..", "..", "plugins", "headroom");
  const config = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as {
    hooks: { PreToolUse: { matcher: string; hooks: Record<string, unknown>[] }[] };
  };
  const [entry] = config.hooks.PreToolUse;
  const hook = entry?.hooks[0] ?? {};

  it("is one HTTP hook for the Bash and PowerShell tools, on the route of the daemon at its default port", () => {
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(entry?.matcher).toBe("Bash|PowerShell");
    expect(entry?.hooks).toHaveLength(1);
    expect(hook["type"]).toBe("http");
    expect(hook["url"]).toBe(`http://127.0.0.1:${DEFAULT_PORT}${HOOK_PATH}`);
    expect(hook["headers"]).toEqual({ [HOOK_HEADER]: HOOK_CLIENT });
  });

  it("waits at most 1 second and has no onFailure, so a failed request lets the tool call go on", () => {
    expect(typeof hook["timeout"]).toBe("number");
    expect(hook["timeout"] as number).toBeLessThanOrEqual(1);
    expect(hook).not.toHaveProperty("onFailure");
  });

  it("starts no process: the plugin has no command hook and no script", () => {
    const all = Object.values(config.hooks).flatMap((entries) => entries.flatMap((each) => each.hooks));
    expect(all.every((each) => each["type"] === "http")).toBe(true);
  });

  it("has a SemVer version", () => {
    const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")) as { version?: string };
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("with the daemon stopped, the connection fails at once, far inside the timeout", async () => {
    // A port with no listener, as the port of a stopped daemon: the refusal comes in milliseconds, and Claude Code lets
    // the tool call go on after a failed HTTP hook with no onFailure.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const free = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const started = performance.now();
    const outcome = await fetch(`http://127.0.0.1:${free}${HOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", [HOOK_HEADER]: HOOK_CLIENT },
      body: JSON.stringify(event("pnpm test")),
      signal: AbortSignal.timeout(((hook["timeout"] as number) || 1) * 1000),
    }).then(
      () => "answered",
      (error: unknown) => ((error as { cause?: { code?: string } }).cause?.code ?? String(error)),
    );
    expect(outcome).toBe("ECONNREFUSED");
    expect(performance.now() - started).toBeLessThan(((hook["timeout"] as number) || 1) * 1000);
  });
});
