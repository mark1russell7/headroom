import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientArgs, detachedLine } from "./detach.ts";

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
    expect(readFileSync(log, "utf8")).toContain("the job used at most");
  });
});
