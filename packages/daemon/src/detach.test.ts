import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientArgs,
  detachedLine,
  noDaemonLine,
  relayCommandLine,
  relayPipePath,
  routeLine,
  runRelay,
  RELAY_MAX_WAIT_MS,
  startDetachedClient,
  waitForDaemon,
  windowsRelayLaunch,
  type ClientStart,
  type OutsideStarts,
  type RelayLaunch,
  type RelayStart,
} from "./detach.ts";

// The command itself, started as a user starts it. Its daemon has its own folder and port.
const cli = join(import.meta.dirname, "cli.ts");

/** A job that writes its arguments, waits for a file and exits with code 7. */
const JOB = `
import { existsSync } from "node:fs";
const [go, ...rest] = process.argv.slice(2);
console.log("arguments:" + JSON.stringify(rest));
setInterval(() => {
  if (existsSync(go)) process.exit(7);
}, 20);
setTimeout(() => process.exit(9), 50000);
`;

interface Ended {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** This function starts the command and waits for its end. */
function headroom(home: string, args: readonly string[]): Promise<Ended> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, HEADROOM_HOME: home, HEADROOM_HOLDER: "tests" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/** This function polls a read until it gives a value. */
async function until<T>(read: () => Promise<T | undefined>, ms = 40000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("the wait ended with no value");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });

describe("the wait of an adopted job for a daemon", () => {
  it("gives the daemon that answers at the third look", async () => {
    let t = 0;
    let looks = 0;
    const sleeps: number[] = [];
    const found = await waitForDaemon(10_000, async () => (++looks === 3 ? "daemon" : null), {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      lookMs: 1000,
    });
    expect(found).toBe("daemon");
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("gives null at the deadline, and does not sleep past it", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const found = await waitForDaemon(2500, async () => null, {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      lookMs: 1000,
    });
    expect(found).toBeNull();
    expect(sleeps).toEqual([1000, 1000, 500]);
  });

  it("a job of the queue with no daemon does not run, and ends with 75", async () => {
    const home = mkdtempSync(join(tmpdir(), "headroom-adopt-"));
    try {
      const marker = join(home, "ran");
      const ended = await headroom(home, ["run", "--adopt", "00000000-0000-0000-0000-000000000000", "--job", "hr-adopt", "--wait", "1s", "--", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`]);
      expect(ended.code).toBe(75);
      expect(ended.err).toContain(noDaemonLine("hr-adopt"));
      expect(ended.err).not.toContain("runs without a lease");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});

describe("the arguments of a detached client", () => {
  it("removes --detach, and keeps the same word after --", () => {
    const argv = ["--detach", "--job", "a", "--", "node", "--detach"];
    expect(clientArgs(argv, new Set([0]), "tests", "x.log")).toEqual(["run", "--detached-client", "--holder", "tests", "--log", "x.log", "--job", "a", "--", "node", "--detach"]);
  });
});

describe("the line of a detached run", () => {
  it("names the lease, the log and the command for the state", () => {
    const { line, code } = detachedLine("hr-a", "x.log", { kind: "lease", lease: "3f2a9c1e-0000" });
    expect(line).toBe("headroom: job hr-a runs detached, lease 3f2a9c1e. Log: x.log. State: headroom job hr-a");
    expect(line).not.toContain("\n");
    expect(code).toBe(0);
  });

  it("quotes a job name with a space", () => {
    expect(detachedLine("a b", "x.log", { kind: "pending" }).line).toContain('State: headroom job "a b"');
  });

  it("gives the exit code of a client that ended before a lease", () => {
    expect(detachedLine("a", "x.log", { kind: "ended", code: 2 })).toMatchObject({ code: 2, line: expect.stringContaining("ended with code 2") as string });
    expect(detachedLine("a", "x.log", { kind: "ended", code: null }).code).toBe(1);
  });
});

describe("headroom run --detach without a daemon", () => {
  let home = "";

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "headroom-detach-"));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

  it("needs --job, and starts nothing", async () => {
    const proof = join(home, "started");
    const ended = await headroom(home, ["run", "--detach", "--", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(proof)}, "")`]);
    expect(ended.code).toBe(2);
    expect(ended.err).toContain("--detach needs --job");
    expect(existsSync(proof)).toBe(false);
  });

  it("writes each line once to the log of --log", { timeout: 30000 }, async () => {
    const log = join(home, "own.log");
    const ended = await headroom(home, ["run", "--detach", "--job", "own", "--log", log, "--", process.execPath, "-e", 'console.log("one line")']);
    expect(ended.code).toBe(0);
    expect(ended.out).toContain("without a lease");
    expect(ended.out).toContain(`Log: ${log}`);
    const text = await until(async () => {
      const read = readFileSync(log, "utf8");
      return read.includes("the job used at most") || read.includes("one line") ? read : undefined;
    });
    expect(text.match(/one line/g)).toHaveLength(1);
  });

  // 2026-11-08: Git Bash sh wrote nothing to the log handle of the client, which can append only. The exit code stayed.
  it("writes the output and the errors of sh -c to the log, each line once", { timeout: 30000 }, async () => {
    const log = join(home, "sh.log");
    const ended = await headroom(home, ["run", "--detach", "--job", "sh", "--log", log, "--", "sh", "-c", "echo probe-out; echo probe-err 1>&2; exit 3"]);
    expect(ended.code).toBe(0);
    const text = await until(async () => {
      const read = readFileSync(log, "utf8");
      return read.includes("probe-out") && read.includes("probe-err") ? read : undefined;
    });
    expect(text.match(/probe-out/g)).toHaveLength(1);
    expect(text.match(/probe-err/g)).toHaveLength(1);
  });
});

describe("headroom run --detach with a daemon", () => {
  let home = "";
  let daemon: ChildProcess;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "headroom-detach-"));
    const port = await freePort();
    daemon = spawn(process.execPath, [cli, "serve", "--port", String(port), "--reserve", "0m"], { env: { ...process.env, HEADROOM_HOME: home }, stdio: "ignore" });
    await until(async () => ((await headroom(home, ["status", "--json"])).code === 0 ? true : undefined));
  }, 60000);

  afterAll(async () => {
    const stopped = new Promise((resolve) => daemon.once("close", resolve));
    daemon.kill();
    await stopped;
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }, 30000);

  it("returns while the job runs, and headroom job gives its log and its exit code", { timeout: 90000 }, async () => {
    const script = join(home, "job.mjs");
    const go = join(home, "go");
    writeFileSync(script, JOB);
    // Both forms of an argument that the quotes of Windows must keep: a space, and a quote with a special character of cmd.
    const ended = await headroom(home, ["run", "--detach", "--job", "detached", "--", process.execPath, script, go, "a b", 'c "d" & e']);
    expect(ended.code).toBe(0);
    expect(ended.out.trim().split("\n")).toHaveLength(1);
    expect(ended.out).toMatch(/runs detached, lease [0-9a-f]{8}\./);
    expect(ended.out).toContain("State: headroom job detached");
    const log = /Log: (.+\.log)\./.exec(ended.out)?.[1] ?? "";
    expect(log.startsWith(join(home, "jobs"))).toBe(true);

    // The job waits for the file, so the run returned before the end of the job.
    const running = JSON.parse((await headroom(home, ["job", "detached", "--json"])).out) as { state: string; log: string; holder: string };
    expect(running.state).not.toBe("exited");
    expect(running.log).toBe(log);
    expect(running.holder).toBe("tests");
    expect((await headroom(home, ["job", "detached"])).out).toContain(`Log: ${log}`);

    const text = await until(async () => {
      const read = readFileSync(log, "utf8");
      return read.includes("arguments:") ? read : undefined;
    });
    expect(text).toContain(`arguments:${JSON.stringify(["a b", 'c "d" & e'])}`);

    writeFileSync(go, "");
    const exited = await until(async () => {
      const state = JSON.parse((await headroom(home, ["job", "detached", "--json"])).out) as { state: string; exitCode: number | null };
      return state.state === "exited" ? state : undefined;
    });
    expect(exited.exitCode).toBe(7);
    expect((await headroom(home, ["job", "detached"])).out).toContain("exited with code 7");
    // The client writes to the log too. The line of the peak comes from the job object, which only Windows has.
    expect(readFileSync(log, "utf8")).toContain("headroom: lease");
    if (process.platform === "win32") expect(readFileSync(log, "utf8")).toContain("the job used at most");
  });
});

describe("the command line of the relay (H190)", () => {
  it("quotes Node, its options, the file of the relay and the pipe", () => {
    const line = relayCommandLine("\\\\.\\pipe\\headroom-detach-1", "C:\\Program Files\\nodejs\\node.exe", ["--title=headroom-cli"], "D:\\git\\headroom\\detach-relay.ts");
    expect(line).toBe('"C:\\Program Files\\nodejs\\node.exe" "--title=headroom-cli" "D:\\git\\headroom\\detach-relay.ts" "\\\\.\\pipe\\headroom-detach-1"');
  });

  it("gives a named pipe on Windows, and a socket file elsewhere, with a new name each time", () => {
    expect(relayPipePath("win32")).toMatch(/^\\\\\.\\pipe\\headroom-detach-[0-9a-f-]{36}$/);
    const unix = relayPipePath("linux");
    expect(unix.startsWith(tmpdir())).toBe(true);
    expect(unix).toMatch(/headroom-detach-[0-9a-f-]{36}\.sock$/);
    expect(relayPipePath("win32")).not.toBe(relayPipePath("win32"));
  });
});

describe("the line about the place of a detached client", () => {
  it("names the relay and the shell outside the jobs of the caller", () => {
    expect(routeLine("build", { kind: "shell", relayPid: 41, shellPid: 7 })).toBe(
      "headroom: the client of job build runs outside the jobs of the caller. Its relay (process 41) has the shell (process 7) as its parent.",
    );
  });

  it("names the relay that broke away from the jobs of the caller, and why the shell did not start it (H202)", () => {
    expect(routeLine("build", { kind: "breakaway", relayPid: 41, why: "no shell window" })).toBe(
      "headroom: the client of job build runs outside the jobs of the caller. Its relay (process 41) broke away from the jobs, because the shell did not start it: no shell window.",
    );
  });

  it("tells why the client stays in the jobs of the caller, and has no line on a platform with no relay", () => {
    expect(routeLine("build", { kind: "caller", reason: "no shell window" })).toContain("runs in the jobs of the caller, because no shell window.");
    expect(routeLine("build", { kind: "caller", reason: null })).toBeNull();
  });
});

/** The start of a client in a test: it keeps each call, and gives `result`. */
function fakeStart(result: ClientStart | (() => Promise<ClientStart>)): { readonly calls: unknown[][]; readonly start: (...args: [string, readonly string[], string, number?]) => Promise<ClientStart> } {
  const calls: unknown[][] = [];
  return {
    calls,
    start: async (...args) => {
      calls.push(args);
      return typeof result === "function" ? result() : result;
    },
  };
}

const ENTRY = "D:/git/headroom/packages/daemon/src/cli.ts";
const ARGS = ["run", "--job", "a b", "--", "sh", "-c", 'echo "x" ✓'];
const LOG = "D:/headroom-test/.headroom/jobs/x.log";
const STARTED = { kind: "started", pid: 4242, shellPid: 17 } as const;

describe("the start of a detached client through a relay (H190)", () => {
  it("starts the client in the jobs of the caller when the platform has no relay", async () => {
    const direct = fakeStart({ kind: "lease", lease: "direct" });
    const started = await startDetachedClient(ENTRY, ARGS, LOG, { launch: null, waitMs: 300, direct: direct.start });
    expect(started).toEqual({ start: { kind: "lease", lease: "direct" }, route: { kind: "caller", reason: null } });
    expect(direct.calls).toEqual([[ENTRY, ARGS, LOG, 300]]);
  });

  it("gives the request to the relay, and the answer of the relay back, with each argument whole", { timeout: 20000 }, async () => {
    const direct = fakeStart({ kind: "lease", lease: "direct" });
    const relay = fakeStart({ kind: "lease", lease: "from-relay" });
    let ran: Promise<number> = Promise.resolve(-1);
    const launch: RelayLaunch = async (pipe) => {
      ran = runRelay(pipe, relay.start, 5000);
      return STARTED;
    };
    const started = await startDetachedClient(ENTRY, ARGS, LOG, { launch, waitMs: 2000, pipe: relayPipePath(), direct: direct.start });
    expect(started).toEqual({ start: { kind: "lease", lease: "from-relay" }, route: { kind: "shell", relayPid: 4242, shellPid: 17 } });
    expect(relay.calls).toEqual([[ENTRY, ARGS, LOG, 2000]]);
    expect(direct.calls).toEqual([]);
    expect(await ran).toBe(0);
  });

  it("gives the route of a relay that broke away, and of a relay in the jobs of the caller, with the reason (H202)", { timeout: 20000 }, async () => {
    for (const [launched, route] of [
      [{ kind: "breakaway", pid: 51, why: "no shell window" }, { kind: "breakaway", relayPid: 51, why: "no shell window" }],
      [{ kind: "inside", pid: 52, why: "no shell window, and a job refused the breakaway" }, { kind: "caller", reason: "no shell window, and a job refused the breakaway" }],
    ] as const) {
      const direct = fakeStart({ kind: "lease", lease: "direct" });
      const relay = fakeStart({ kind: "lease", lease: "from-relay" });
      let ran: Promise<number> = Promise.resolve(-1);
      const launch: RelayLaunch = async (pipe) => {
        ran = runRelay(pipe, relay.start, 5000);
        return launched;
      };
      const started = await startDetachedClient(ENTRY, ARGS, LOG, { launch, waitMs: 2000, pipe: relayPipePath(), direct: direct.start });
      expect(started).toEqual({ start: { kind: "lease", lease: "from-relay" }, route });
      expect(direct.calls).toEqual([]);
      expect(await ran).toBe(0);
    }
  });

  it("starts the client in the jobs of the caller when the relay cannot start, and tells why", async () => {
    const direct = fakeStart({ kind: "no-lease" });
    const started = await startDetachedClient(ENTRY, ARGS, LOG, { launch: async () => ({ kind: "unavailable", reason: "the shell is elevated, and this process is not" }), direct: direct.start });
    expect(started).toEqual({ start: { kind: "no-lease" }, route: { kind: "caller", reason: "the shell is elevated, and this process is not" } });
    expect(direct.calls).toHaveLength(1);
  });

  it("takes an error of the launch as a reason, and starts the client in the jobs of the caller", async () => {
    const direct = fakeStart({ kind: "pending" });
    const started = await startDetachedClient(ENTRY, ARGS, LOG, {
      launch: async () => {
        throw new Error("koffi did not load");
      },
      direct: direct.start,
    });
    expect(started.route).toEqual({ kind: "caller", reason: "koffi did not load" });
    expect(direct.calls).toHaveLength(1);
  });

  it("starts exactly one client when the relay connects after the time limit: the late relay finds no pipe and starts nothing", { timeout: 20000 }, async () => {
    const direct = fakeStart({ kind: "lease", lease: "direct" });
    const relay = fakeStart({ kind: "lease", lease: "late" });
    let late: Promise<number> = Promise.resolve(-1);
    let wake: () => void = () => undefined;
    const due = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const launch: RelayLaunch = async (pipe) => {
      setTimeout(() => {
        late = runRelay(pipe, relay.start, 3000);
        wake();
      }, 600);
      return STARTED;
    };
    const started = await startDetachedClient(ENTRY, ARGS, LOG, { launch, connectMs: 200, pipe: relayPipePath(), direct: direct.start });
    expect(started).toEqual({ start: { kind: "lease", lease: "direct" }, route: { kind: "caller", reason: "the relay (process 4242) did not connect in 0.2 s" } });
    await due;
    expect(await late).toBe(1);
    expect(relay.calls).toEqual([]);
    expect(direct.calls).toHaveLength(1);
  });

  it("gives pending when the relay has the request but no answer comes in time, because the client can run", { timeout: 20000 }, async () => {
    const direct = fakeStart({ kind: "lease", lease: "direct" });
    const relay = fakeStart(() => new Promise((resolve) => setTimeout(() => resolve({ kind: "lease", lease: "slow" }), 1500)));
    let ran: Promise<number> = Promise.resolve(-1);
    const launch: RelayLaunch = async (pipe) => {
      ran = runRelay(pipe, relay.start, 5000);
      return STARTED;
    };
    const started = await startDetachedClient(ENTRY, ARGS, LOG, { launch, waitMs: 100, marginMs: 100, pipe: relayPipePath(), direct: direct.start });
    expect(started).toEqual({ start: { kind: "pending" }, route: { kind: "shell", relayPid: 4242, shellPid: 17 } });
    expect(direct.calls).toEqual([]);
    expect(await ran).toBe(0);
    expect(relay.calls).toHaveLength(1);
  });

  it("gives the reason of a relay whose start of the client failed", { timeout: 20000 }, async () => {
    const relay = fakeStart(async () => {
      throw new Error("no node at that path");
    });
    const launch: RelayLaunch = async (pipe) => {
      void runRelay(pipe, relay.start, 5000);
      return STARTED;
    };
    const started = await startDetachedClient(ENTRY, ARGS, LOG, { launch, waitMs: 2000, pipe: relayPipePath(), direct: fakeStart({ kind: "pending" }).start });
    expect(started.start).toEqual({ kind: "failed", reason: "no node at that path" });
  });

  it("gives pending for an answer that is not a start of a client", { timeout: 20000 }, async () => {
    const launch: RelayLaunch = async (pipe) => {
      const socket = connect(pipe);
      socket.once("data", () => socket.end("not a start\n"));
      return STARTED;
    };
    const started = await startDetachedClient(ENTRY, ARGS, LOG, { launch, waitMs: 2000, pipe: relayPipePath(), direct: fakeStart({ kind: "lease", lease: "direct" }).start });
    expect(started).toEqual({ start: { kind: "pending" }, route: { kind: "shell", relayPid: 4242, shellPid: 17 } });
  });
});

describe("the relay (H190)", () => {
  it("starts nothing and ends with 1 when the request is not a request", { timeout: 20000 }, async () => {
    const pipe = relayPipePath();
    const server = createServer((socket) => socket.end(`${JSON.stringify({ entry: ENTRY, args: [1, 2], log: LOG, waitMs: 100 })}\n`));
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    const relay = fakeStart({ kind: "lease", lease: "x" });
    try {
      expect(await runRelay(pipe, relay.start, 3000)).toBe(1);
      expect(relay.calls).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("starts nothing and ends with 1 when the wait of the request is longer than the bound", { timeout: 20000 }, async () => {
    const pipe = relayPipePath();
    const server = createServer((socket) => socket.end(`${JSON.stringify({ entry: ENTRY, args: ["run"], log: LOG, waitMs: RELAY_MAX_WAIT_MS + 1 })}
`));
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    const relay = fakeStart({ kind: "lease", lease: "x" });
    try {
      expect(await runRelay(pipe, relay.start, 3000)).toBe(1);
      expect(relay.calls).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("starts nothing and ends with 1 when no pipe answers", async () => {
    const relay = fakeStart({ kind: "lease", lease: "x" });
    expect(await runRelay(relayPipePath(), relay.start, 3000)).toBe(1);
    expect(relay.calls).toEqual([]);
  });
});

describe("the start of the relay on Windows (H190, H202)", () => {
  /** The two starts in a test: each keeps its calls and gives its result. */
  function starts(shell: RelayStart & ({ kind: "started" } | { kind: "unavailable" }), breakaway: boolean): { readonly calls: string[]; readonly starts: OutsideStarts } {
    const calls: string[] = [];
    return {
      calls,
      starts: {
        underShell: async (line, cwd) => (calls.push(`shell ${cwd} ${line}`), shell),
        outsideJob: async (line, cwd) => (calls.push(`outside ${cwd} ${line}`), { pid: 77, breakaway, jobFlags: 0x800 }),
      },
    };
  }

  it("starts the relay under the shell first, and does not try the breakaway after a start", async () => {
    const fake = starts(STARTED, true);
    expect(await windowsRelayLaunch(fake.starts, "D:/work")("p1")).toEqual(STARTED);
    expect(fake.calls).toEqual([`shell D:/work ${relayCommandLine("p1")}`]);
  });

  it("starts the relay with a breakaway when the shell does not start it, and keeps the reason of the shell", async () => {
    const fake = starts({ kind: "unavailable", reason: "no shell window" }, true);
    expect(await windowsRelayLaunch(fake.starts, "D:/work")("p2")).toEqual({ kind: "breakaway", pid: 77, why: "no shell window" });
    expect(fake.calls).toEqual([`shell D:/work ${relayCommandLine("p2")}`, `outside D:/work ${relayCommandLine("p2")}`]);
  });

  it("tells that the relay runs in the jobs of the caller when a job refuses the breakaway", async () => {
    const fake = starts({ kind: "unavailable", reason: "no shell window" }, false);
    expect(await windowsRelayLaunch(fake.starts, "D:/work")("p3")).toEqual({ kind: "inside", pid: 77, why: "no shell window, and a job refused the breakaway" });
  });
});
