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
import { FALSE_CASES, HEAVY_CASES, LEASE_CASES, RUNNER_CASES, RUNNER_FILE_CASES, VERDICT_COMMANDS } from "./fixtures/hook-commands.ts";
import {
  CALL_TIMEOUT_DEFAULT_MS,
  CALL_TIMEOUT_MAX_MS,
  decide,
  hookOutput,
  isHeavy,
  leased,
  runnerOf,
  runParts,
  toolCallOf,
  type HookOutput,
  type Status,
} from "./hook-rating.ts";

const event = (command: unknown): unknown => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

describe("the rating of a command line (H55)", () => {
  it.each(FALSE_CASES)("does not rate %j as heavy", (command) => {
    expect(isHeavy(command)).toBe(false);
  });

  it.each(HEAVY_CASES)("rates %j as heavy", (command) => {
    expect(isHeavy(command)).toBe(true);
  });
});

describe("the test runners as words (H221)", () => {
  it.each(RUNNER_FILE_CASES)("does not rate %j as heavy, because a file of a runner is not the runner", (command) => {
    expect(isHeavy(command)).toBe(false);
  });

  it.each(RUNNER_CASES)("rates %j as heavy: a runner by a path, a version or a launcher", (command) => {
    expect(isHeavy(command)).toBe(true);
  });

  it("gives the runner of the last segment of a word, without a version and the extension of a program", () => {
    expect(runnerOf("vitest")).toBe("vitest");
    expect(runnerOf("node_modules/.bin/vitest.cmd")).toBe("vitest");
    expect(runnerOf("C:\\repo\\node_modules\\.bin\\JEST.CMD")).toBe("jest");
    expect(runnerOf("vitest@3.2.4")).toBe("vitest");
    expect(runnerOf("'pytest'")).toBe("pytest");
    expect(runnerOf("$(vitest")).toBe("vitest");
    expect(runnerOf("--runner=jest")).toBe("jest");
    expect(runnerOf("vitest.config.ts")).toBeNull();
    expect(runnerOf("origin/main:packages/x/vitest.config.ts")).toBeNull();
    expect(runnerOf("@vitest/coverage-v8")).toBeNull();
    expect(runnerOf("")).toBeNull();
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

  it("rates a command with many options and no verb in linear time", () => {
    // Each `--o1` matched in two ways before the fix. The time doubled with each option: 3.5 ms at 16 options, 48 ms at 20.
    const options = Array.from({ length: 40 }, (_, index) => `--o${index}`).join(" ");
    const started = performance.now();
    expect(isHeavy(`docker ${options} ps`)).toBe(false);
    expect(isHeavy(`docker compose ${options} logs`)).toBe(false);
    expect(isHeavy(`docker-compose ${options} ps`)).toBe(false);
    expect(isHeavy(`docker ${options} run mongo:7`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
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

  it("reads the status only for a heavy command or a headroom run that waits in the foreground (H208)", () => {
    let reads = 0;
    const status = (): Status => {
      reads += 1;
      return { free: { memory: 100 }, leases: [] };
    };
    hookOutput(event("git status"), status);
    hookOutput(event("headroom run --detach --job tests --mem 2g -- pnpm test"), status);
    hookOutput(event("headroom run --wait 1m --mem 2g -- pnpm test"), status);
    hookOutput(event("echo headroom run --mem 2g -- pnpm test"), status);
    expect(reads).toBe(0);
    hookOutput(event("pnpm test"), status);
    hookOutput(event("headroom run --mem 2g -- pnpm test"), status);
    expect(reads).toBe(2);
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

  // The three commands of 2026-11-21 (H221), with the state of that hour: 445 MB free and a lease that waits.
  it.each(RUNNER_FILE_CASES.slice(0, 3))("lets %j go on when the memory is tight, because a file of a runner is not the runner", async (command) => {
    status = () => ({ free: { memory: 445 }, leases: [{ state: "waiting", reason: "waits for memory: needs 1600, 445 free" }] });
    expect(await send(JSON.stringify(event(command)))).toEqual({ code: 200, body: "{}" });
  });

  it("refuses a runner by its path when the memory is tight (H221)", async () => {
    status = () => ({ free: { memory: 445 }, leases: [] });
    const output = JSON.parse((await send(JSON.stringify(event("node_modules/.bin/vitest run")))).body) as { hookSpecificOutput: Record<string, string> };
    expect(output.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect(output.hookSpecificOutput["permissionDecisionReason"]).toContain("Send it again as: headroom run --mem auto -- node_modules/.bin/vitest run");
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

  it("asks the gate of links (H223) after the gate of native paths, and gives the first refusal", async () => {
    const asked: string[] = [];
    const gate =
      (name: string, refusal: string | null) =>
      async (command: string, cwd: string | null): Promise<string | null> => (asked.push(`${name} ${command} ${cwd ?? "-"}`), refusal);
    const body = JSON.stringify({ ...(event("pnpm install") as object), cwd: "/r/app-wt/t" });
    expect(reasonOf((await hookVerdict(body, { status: free, native: gate("native", null), links: gate("links", "a link points into it") })).json)).toBe("a link points into it");
    expect(reasonOf((await hookVerdict(body, { status: free, native: gate("native", "too long"), links: gate("links", "a link") })).json)).toBe("too long");
    expect(asked).toEqual(["native pnpm install /r/app-wt/t", "links pnpm install /r/app-wt/t", "native pnpm install /r/app-wt/t"]);
    const throws = (): Promise<string | null> => Promise.reject(new Error("no read"));
    expect(await hookVerdict(body, { status: free, links: throws })).toEqual({ code: 200, json: "{}" });
    expect(reasonOf((await hookVerdict(body, { status: free, links: gate("links", "only links") })).json)).toBe("only links");
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

describe("the guard of a headroom run that waits in the foreground (H208)", () => {
  const call = (command: string, input: Record<string, unknown> = {}, tool = "Bash"): unknown => ({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { command, ...input },
  });
  const QUEUE: Status = { free: { memory: 9000 }, leases: [{ state: "granted" }, { state: "waiting", reason: "waits for memory: needs 3072, 1770 free" }] };
  const TWO_IN_QUEUE: Status = {
    free: { memory: 1770 },
    leases: [
      { state: "waiting", reason: "waits for memory: needs 3072, 1770 free" },
      { state: "waiting", reason: "waits for memory: needs 3300, 1770 free" },
    ],
  };
  const NO_QUEUE: Status = { free: { memory: 1770 }, leases: [{ state: "granted" }] };
  const SLOT_QUEUE: Status = { free: { memory: 9000 }, leases: [{ state: "waiting", reason: "waits for browser: needs 1, 0 free" }] };
  const reasonOf = (output: HookOutput): string | null => ("hookSpecificOutput" in output ? output.hookSpecificOutput.permissionDecisionReason : null);
  const RUN = "headroom run --mem 2g -- pnpm test";

  const cases: { name: string; command: string; input?: Record<string, unknown>; tool?: string; status: Status | null; refused: boolean }[] = [
    { name: "no lease waits for memory", command: RUN, status: NO_QUEUE, refused: false },
    { name: "a lease waits for a slot, not for memory", command: RUN, status: SLOT_QUEUE, refused: false },
    { name: "the daemon gives no status", command: RUN, status: null, refused: false },
    { name: "no --wait (30 min) and the default timeout (2 min)", command: RUN, status: QUEUE, refused: true },
    { name: "a --wait shorter than the default timeout", command: "headroom run --wait 1m --mem 2g -- pnpm test", status: QUEUE, refused: false },
    { name: "a --wait equal to the timeout", command: "headroom run --wait 2m --mem 2g -- pnpm test", status: QUEUE, refused: true },
    { name: "--wait 8m and a timeout of 600000", command: "headroom run --wait 8m --mem 2g -- pnpm test", input: { timeout: 600_000 }, status: QUEUE, refused: false },
    { name: "--wait=8m and a timeout of 600000", command: "headroom run --wait=8m --mem 2g -- pnpm test", input: { timeout: 600_000 }, status: QUEUE, refused: false },
    { name: "--wait 10m and a timeout of 600000", command: "headroom run --wait 10m --mem 2g -- pnpm test", input: { timeout: 600_000 }, status: QUEUE, refused: true },
    { name: "a timeout above the largest value counts as the largest value", command: "headroom run --wait 15m -- pnpm test", input: { timeout: 1_200_000 }, status: QUEUE, refused: true },
    { name: "a timeout that is not a number counts as the default", command: "headroom run --wait 8m -- pnpm test", input: { timeout: "600000" }, status: QUEUE, refused: true },
    { name: "--detach with --job", command: "headroom run --detach --job tests --mem 2g -- pnpm test", status: QUEUE, refused: false },
    { name: "--detach after -- is an argument of the command", command: "headroom run --mem 2g -- pnpm test --detach", status: QUEUE, refused: true },
    { name: "--detach with no --job: the tool refuses the run at once", command: "headroom run --detach -- pnpm test", status: QUEUE, refused: false },
    { name: "an unknown option: the tool refuses the run at once", command: "headroom run --bogus -- pnpm test", status: QUEUE, refused: false },
    { name: "no command: the tool refuses the run at once", command: "headroom run --mem 2g", status: QUEUE, refused: false },
    { name: "a wrong --wait: the tool refuses the run at once", command: "headroom run --wait soon -- pnpm test", status: QUEUE, refused: false },
    { name: "the PowerShell tool", command: RUN, tool: "PowerShell", status: QUEUE, refused: true },
    { name: "the PowerShell tool with --detach", command: "headroom run --detach --job tests -- pnpm test", tool: "PowerShell", status: QUEUE, refused: false },
    { name: "the call operator of PowerShell", command: `& ${RUN}`, tool: "PowerShell", status: QUEUE, refused: true },
    { name: "a run after cd", command: `cd app && ${RUN}`, status: QUEUE, refused: true },
    { name: "a run after its variables", command: `CI=1 ${RUN}`, status: QUEUE, refused: true },
    { name: "headroom.cmd", command: "headroom.cmd run --mem 2g -- pnpm test", status: QUEUE, refused: true },
    { name: "headroom run in the text of echo", command: `echo ${RUN}`, status: QUEUE, refused: false },
    { name: "a call in the background with a short --wait", command: "headroom run --wait 1m -- pnpm test", input: { run_in_background: true }, status: QUEUE, refused: true },
    { name: "a call in the background with --detach", command: "headroom run --detach --job tests -- pnpm test", input: { run_in_background: true }, status: QUEUE, refused: false },
  ];
  it.each(cases)("$name: refused $refused", ({ command, input, tool, status, refused }) => {
    const reason = reasonOf(hookOutput(call(command, input, tool), () => status));
    expect(reason !== null).toBe(refused);
  });

  it("gives the detached form of the command and the wait of the job, with --job <name> when the run has no name", () => {
    const reason = reasonOf(hookOutput(call(`cd app && ${RUN}`), () => TWO_IN_QUEUE));
    expect(reason).toContain("2 jobs already wait for memory");
    expect(reason).toContain("waits up to 30 min for its grant, and the tool call ends at 2 min");
    expect(reason).toContain("Send it as a detached job: cd app && headroom run --detach --job <name> --mem 2g -- pnpm test.");
    expect(reason).toContain('Then "headroom job <name>" gives its state.');
    expect(reason).toContain("--wait 8m with a timeout of 600000");
  });

  it("keeps the name of the job in the detached form", () => {
    const reason = reasonOf(hookOutput(call("headroom run --job tests --wait 10m -- pnpm test", { timeout: 300_000 }), () => QUEUE));
    expect(reason).toContain("1 job already waits for memory");
    expect(reason).toContain("waits up to 10 min for its grant, and the tool call ends at 5 min");
    expect(reason).toContain("Send it as a detached job: headroom run --detach --job tests --wait 10m -- pnpm test.");
    expect(reason).toContain('Then "headroom job tests" gives its state.');
  });

  it("tells a call in the background that it has no time in the foreground", () => {
    const reason = reasonOf(hookOutput(call("headroom run --wait 1m --job tests -- pnpm test", { run_in_background: true }), () => QUEUE));
    expect(reason).toContain("this tool call starts in the background");
    expect(reason).not.toContain("--wait 8m");
  });

  it("reads the limits of a call", () => {
    expect(toolCallOf(undefined)).toEqual({ timeoutMs: CALL_TIMEOUT_DEFAULT_MS, background: false });
    expect(toolCallOf({ timeout: 300_000 })).toEqual({ timeoutMs: 300_000, background: false });
    expect(toolCallOf({ timeout: 0 })).toEqual({ timeoutMs: CALL_TIMEOUT_DEFAULT_MS, background: false });
    expect(toolCallOf({ timeout: Number.NaN })).toEqual({ timeoutMs: CALL_TIMEOUT_DEFAULT_MS, background: false });
    expect(toolCallOf({ timeout: 9_000_000, run_in_background: true })).toEqual({ timeoutMs: CALL_TIMEOUT_MAX_MS, background: true });
  });

  it("reads each run of a line with the options of the command line tool", () => {
    expect(runParts("git status")).toEqual([]);
    expect(runParts("headroom run --job a --wait 90s -- x && headroom run --detach --job b -- y")).toEqual([
      { detach: false, waitMs: 90_000, job: "a" },
      { detach: true, waitMs: 30 * 60_000, job: "b" },
    ]);
    // Without --, parseArgs of the tool reads --detach after the command as an option. The run has no --job, so the tool refuses it.
    expect(runParts("headroom run --mem 2g pnpm test --detach")).toEqual([]);
  });
});
