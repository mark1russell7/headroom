import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { hostPolicy, ProcedureRegistry } from "@procedures/client";
import { createProcedureHost, peerHostOptions, type HostFaceContext } from "@procedures/peer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dashboardFace } from "./dashboard.ts";
import { DEFAULT_PORT, withFaces } from "./daemon.ts";
import { HOOK_CLIENT, HOOK_HEADER, HOOK_PATH, hookAnswer, hookFace, hookVerdict } from "./hook-face.ts";
import { FALSE_CASES, HEAVY_CASES, LEASE_CASES, VERDICT_COMMANDS } from "./fixtures/hook-commands.ts";
import { decide, hookOutput, isHeavy, leased, type Status } from "./hook-rating.ts";

const event = (command: unknown): unknown => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

describe("the rating of a command line (H55)", () => {
  it.each(FALSE_CASES)("does not rate %j as heavy", (command) => {
    expect(isHeavy(command)).toBe(false);
  });

  it.each(HEAVY_CASES)("rates %j as heavy", (command) => {
    expect(isHeavy(command)).toBe(true);
  });
});

describe("the container starts (H62)", () => {
  const STARTS = [
    "docker run -d --name db mongo:7",
    "docker start db",
    "docker restart db",
    "docker container run --rm alpine",
    "docker container start db",
    "docker compose up -d",
    "docker compose start",
    "docker compose run api",
    "docker compose restart",
    "docker-compose up -d",
    "podman run -d mongo:7",
    "podman-compose up",
    "nerdctl run mongo:7",
    "cd deploy && docker compose -f a.yml up",
    "docker compose --project-name shop --profile dev up -d",
    "docker --context remote run mongo:7",
    "docker-compose -f a.yml start",
    "docker build .",
  ];
  const LIGHT = [
    "docker ps",
    "docker stop db",
    "docker compose down",
    "docker compose logs api",
    "docker images",
    "docker container ls",
    "docker-compose ps",
    "docker compose -f up.yml logs",
    "docker inspect --format x db",
  ];

  it.each(STARTS)("rates %j as heavy", (command) => {
    expect(isHeavy(command)).toBe(true);
  });

  it.each(LIGHT)("does not rate %j as heavy", (command) => {
    expect(isHeavy(command)).toBe(false);
  });

  it("refuses a container start below the room of a lease, and tells the form that waits for its room", () => {
    const tight: Status = { free: { memory: 1500 }, leases: [] };
    expect(decide("docker compose up -d", tight)).toContain("Send it again as: headroom run --mem auto -- docker compose up -d");
    expect(decide("docker start db", { free: { memory: 9000 }, leases: [{ state: "waiting", reason: "waits for memory: needs 3072, 400 free" }] })).toContain(
      "1 job already wait for memory",
    );
    // With room and no wait, the start goes on. Under a lease, it waits for the room of the lease.
    expect(decide("docker compose up -d", { free: { memory: 9000 }, leases: [] })).toBeNull();
    expect(decide("headroom run --mem 3g -- docker compose up -d", tight)).toBeNull();
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
    const face = hookFace({ status: () => status(), bodyLimit: 1024 })({} as HostFaceContext);
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

  it("answers 413 for a body over the limit, and the answer reaches the client", async () => {
    const answer = await send(JSON.stringify(event("x".repeat(4096))));
    expect(answer.code).toBe(413);
    expect(JSON.parse(answer.body)).toEqual({ error: "headroom: the event of the hook is too large." });
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

describe("the faces of the daemon on its host (H194)", () => {
  // The options of the host as serve() makes them: the procedures of the peer, then the faces of the daemon.
  const base = peerHostOptions(
    { id: "headroom-test", transports: [{ type: "http", port: DEFAULT_PORT, host: "127.0.0.1", basePath: "/api" }], registry: new ProcedureRegistry(), policy: hostPolicy({ token: "t" }) },
    "headroom",
  );
  const tight = (): Status => ({ free: { memory: 1200 }, leases: [] });
  const options = withFaces(base, { dashboard: dashboardFace(), hook: hookFace({ status: tight }) });

  it("puts the hook and the dashboard on each listener, after the faces of the peer", () => {
    expect(options.listen?.length ?? 0).toBeGreaterThan(0);
    for (const listener of options.listen ?? []) expect(listener.faces?.slice(-2)).toEqual(["dashboard", "hook"]);
    expect(Object.keys(options.faces ?? {})).toEqual([...Object.keys(base.faces ?? {}), "dashboard", "hook"]);
  });

  it("answers the route of the hook through the handler of the host, next to the dashboard", async () => {
    // With no listener, the host serves each face on its handler, in the order of the faces.
    const host = createProcedureHost({ ...options, listen: undefined });
    const server = createServer((req, res) => {
      if (!host.handler(req, res)) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const post = async (command: string): Promise<unknown> => {
        const answer = await fetch(`http://127.0.0.1:${port}${HOOK_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", [HOOK_HEADER]: HOOK_CLIENT },
          body: JSON.stringify(event(command)),
        });
        expect(answer.status).toBe(200);
        return answer.json();
      };
      expect(await post("git status")).toEqual({});
      expect(await post("pnpm test")).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("the gate of long native paths in the hook (H203)", () => {
  const free = (): Status => ({ free: { memory: 8000 }, leases: [] });
  const reasonOf = (json: string): string | undefined =>
    (JSON.parse(json) as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason;

  it("refuses a light command with a lot of free memory when the gate refuses it, and gives the gate the folder and the session of the event", async () => {
    const seen: [string, string | null, string | null][] = [];
    const native = async (command: string, cwd: string | null, sessionId: string | null): Promise<string | null> => (
      seen.push([command, cwd, sessionId]), "the path is too long"
    );
    const body = JSON.stringify({ ...(event("pnpm -v") as object), cwd: "D:\git\app", session_id: "6f1c-kestrel" });
    const verdict = await hookVerdict(body, { status: free, native });
    expect(verdict.code).toBe(200);
    expect(reasonOf(verdict.json)).toBe("the path is too long");
    // An event with no session ID, or an empty one, gives the gate no session.
    await hookVerdict(JSON.stringify({ ...(event("pnpm -v") as object), session_id: "" }), { status: free, native });
    expect(seen).toEqual([
      ["pnpm -v", "D:\git\app", "6f1c-kestrel"],
      ["pnpm -v", null, null],
    ]);
  });

  it("lets the command go on when the gate throws, rejects or lets it go", async () => {
    const body = JSON.stringify(event("pnpm test"));
    const throws = (): Promise<string | null> => {
      throw new Error("no walk");
    };
    expect(await hookVerdict(body, { status: free, native: throws })).toEqual({ code: 200, json: "{}" });
    expect(await hookVerdict(body, { status: free, native: () => Promise.reject(new Error("no walk")) })).toEqual({ code: 200, json: "{}" });
    expect(await hookVerdict(body, { status: free, native: async () => null })).toEqual({ code: 200, json: "{}" });
  });

  it("asks the gate nothing for an event with no command or a bad body, and keeps the refusal for memory", async () => {
    const asked: string[] = [];
    const native = async (command: string): Promise<string | null> => (asked.push(command), null);
    expect(await hookVerdict(JSON.stringify({ tool_input: {} }), { status: free, native })).toEqual({ code: 200, json: "{}" });
    expect((await hookVerdict("{", { status: free, native })).code).toBe(400);
    expect(asked).toEqual([]);
    const tight = await hookVerdict(JSON.stringify(event("pnpm exec vitest run")), { status: () => ({ free: { memory: 1200 }, leases: [] }), native });
    expect(reasonOf(tight.json)).toContain("only 1200 MB is free for a lease");
  });

  it("gives the refusal of the gate through the route of the daemon", async () => {
    const face = hookFace({ status: free, native: async () => "the path is too long" })({} as HostFaceContext);
    const server = createServer((req, res) => {
      if (face.handler?.(req, res) !== true) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const body = await new Promise<string>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", path: HOOK_PATH, headers: { [HOOK_HEADER]: HOOK_CLIENT } }, (res) => {
          let text = "";
          res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
          res.on("end", () => resolve(text));
        });
        req.on("error", reject);
        req.end(JSON.stringify(event("pnpm test")));
      });
      expect(reasonOf(body)).toBe("the path is too long");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
