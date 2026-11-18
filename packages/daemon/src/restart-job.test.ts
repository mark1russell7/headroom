import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openStartLog, RECORDED_END_NOTE, startsOfPid } from "@headroom/core";
import { afterAll, describe, expect, it } from "vitest";
import { killTree } from "./gateway.ts";
import { writePlannedStop } from "./paths.ts";

// H202: a restart of the daemon keeps the jobs that run, and the new daemon gets their true exit.
// The deploy of 2026-11-18 ended two running jobs with no exit code. This test does the same restart with real processes.

const cli = join(import.meta.dirname, "cli.ts");

// The job waits for its file, then exits with code 5. Thus it runs across the restart, and its exit code is known.
const JOB = `
import { existsSync } from "node:fs";
const go = process.argv[2];
setInterval(() => { if (existsSync(go)) process.exit(5); }, 100);
setTimeout(() => process.exit(9), 120000);
`;

// The holder of a job (Windows): it puts the process of its second argument in a new job with KILL_ON_JOB_CLOSE and
// BREAKAWAY_OK, and with no SILENT_BREAKAWAY_OK. Thus the children of that process stay in the job. When the holder
// exits, the job closes and Windows ends each process in it. The job of a scheduled task ends its processes the same way.
// The first argument is the URL of the package file of the core, because koffi is a dependency of the core only.
const HOLDER = `
import { createRequire } from "node:module";
const [core, pid] = process.argv.slice(2);
const koffi = createRequire(core)("koffi");
const kernel32 = koffi.load("kernel32.dll");
const createJob = kernel32.func("intptr_t __stdcall CreateJobObjectW(void* attributes, void* name)");
const setInformation = kernel32.func("int __stdcall SetInformationJobObject(intptr_t job, int kind, _In_ uint8_t* info, uint32_t size)");
const openProcess = kernel32.func("intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
const assign = kernel32.func("int __stdcall AssignProcessToJobObject(intptr_t job, intptr_t process)");
const job = Number(createJob(null, null));
// JOBOBJECT_EXTENDED_LIMIT_INFORMATION has 144 bytes on x64. LimitFlags is at the byte 16.
const info = Buffer.alloc(144);
info.writeUInt32LE(0x2000 | 0x800, 16);
if (job === 0 || setInformation(job, 9, info, info.length) === 0) {
  console.log("failed: the job");
  process.exit(1);
}
// PROCESS_SET_QUOTA and PROCESS_TERMINATE
const target = Number(openProcess(0x0100 | 0x0001, 0, Number(pid)));
if (target === 0 || assign(job, target) === 0) {
  console.log("failed: the assignment");
  process.exit(1);
}
console.log("ready");
setInterval(() => {}, 60000);
`;

interface Ended {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

interface Job {
  readonly state: string;
  readonly exitCode: number | null;
  readonly reason: string | null;
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });

/** This function starts the command. The promise ends with the end of the command. */
function start(home: string, args: readonly string[]): { readonly child: ChildProcess; readonly ended: Promise<Ended> } {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, HEADROOM_HOME: home, HEADROOM_HOLDER: "tests" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  return { child, ended: new Promise((resolve) => child.on("close", (code) => resolve({ code, out, err }))) };
}

const headroom = (home: string, args: readonly string[]): Promise<Ended> => start(home, args).ended;

/** This function polls a read until it gives a value. */
async function until<T>(read: () => Promise<T | undefined>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("the wait ended with no value");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** This function tells if the start log of the trace has a row of the process. */
function traced(path: string, pid: number): boolean {
  if (!existsSync(path)) return false;
  try {
    const db = openStartLog(path);
    try {
      return startsOfPid(db, pid, 1).length > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** This function gives the state of a job, or undefined when the daemon does not answer. */
async function job(home: string, name: string): Promise<Job | undefined> {
  const read = await headroom(home, ["job", name, "--json"]);
  if (read.code !== 0) return undefined;
  try {
    return JSON.parse(read.out) as Job;
  } catch {
    return undefined;
  }
}

/** This function starts a daemon with its own folder, and waits until it answers. */
async function daemon(home: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [cli, "serve", "--port", String(port), "--reserve", "0m"], { env: { ...process.env, HEADROOM_HOME: home }, stdio: "ignore" });
  await until(async () => ((await headroom(home, ["status", "--json"])).code === 0 ? true : undefined));
  return child;
}

describe("a restart of the daemon with jobs that run (H202)", () => {
  const home = mkdtempSync(join(tmpdir(), "headroom-restart-job-"));
  const children: ChildProcess[] = [];
  const homeBefore = process.env["HEADROOM_HOME"];

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null && child.pid !== undefined) killTree(child.pid);
    if (homeBefore === undefined) delete process.env["HEADROOM_HOME"];
    else process.env["HEADROOM_HOME"] = homeBefore;
    await pause(500);
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }, 30_000);

  it("keeps a job and a detached job, and the new daemon gets their exit codes", { timeout: 150_000 }, async () => {
    const port = await freePort();
    const old = await daemon(home, port);
    children.push(old);
    // The holder "tests" is no session, so its kind is "other". The jobs of the trace of a session holder refuse a breakaway (H191).
    expect((await headroom(home, ["config", "start-trace-hold", "session,other"])).code).toBe(0);
    const script = join(home, "job.mjs");
    writeFileSync(script, JOB);
    const go = join(home, "go");

    const attached = start(home, ["run", "--job", "across", "--", process.execPath, script, go]);
    children.push(attached.child);
    const detached = await headroom(home, ["run", "--detach", "--job", "across-detached", "--", process.execPath, script, go]);
    expect(detached.code).toBe(0);
    for (const name of ["across", "across-detached"]) await until(async () => ((await job(home, name))?.state === "running" ? true : undefined));
    // The first report of each client comes after 3 s (FIRST_REPORT_MS). The two jobs of 2026-11-18 had sent it.
    await pause(4000);
    // The two jobs of 2026-11-18 ran in the trace of the old daemon (H188). The trace puts the client of a lease in a job.
    if (process.platform === "win32" && attached.child.pid !== undefined) {
      const pid = attached.child.pid;
      await until(async () => (traced(join(home, "starts.db"), pid) ? true : undefined), 60_000);
    }

    // The restart of `headroom service restart`: the mark of a planned stop, then the stop of the process tree of the daemon.
    process.env["HEADROOM_HOME"] = home;
    const stopped = new Promise((resolve) => old.once("close", resolve));
    if (old.pid !== undefined) {
      writePlannedStop(old.pid);
      killTree(old.pid);
    }
    await stopped;
    const next = await daemon(home, port);
    children.push(next);
    // The new daemon expires a lease at its first tick when the process of the lease does not run.
    await pause(5000);
    for (const name of ["across", "across-detached"]) {
      const state = await job(home, name);
      expect({ name, state: state?.state, reason: state?.reason }).toEqual({ name, state: "running", reason: state?.reason });
    }

    writeFileSync(go, "");
    const end = await attached.ended;
    expect({ code: end.code, err: end.err }).toEqual({ code: 5, err: end.err });
    for (const name of ["across", "across-detached"]) {
      const state = await until(async () => {
        const read = await job(home, name);
        return read?.state === "exited" ? read : undefined;
      });
      expect({ name, exitCode: state.exitCode, reason: state.reason }).toEqual({ name, exitCode: 5, reason: state.reason });
    }
    const stoppedNext = new Promise((resolve) => next.once("close", resolve));
    next.kill();
    await stoppedNext;
  });

  it("keeps a job whose first heartbeat comes while no daemon runs", { timeout: 150_000 }, async () => {
    const home2 = mkdtempSync(join(tmpdir(), "headroom-restart-beat-"));
    const port = await freePort();
    const old = await daemon(home2, port);
    children.push(old);
    const script = join(home2, "job.mjs");
    writeFileSync(script, JOB);
    const go = join(home2, "go");
    const attached = start(home2, ["run", "--job", "beat", "--", process.execPath, script, go]);
    children.push(attached.child);
    await until(async () => ((await job(home2, "beat"))?.state === "running" ? true : undefined), 40_000);
    const granted = Date.now();
    // The ss-api-help job of 2026-11-16 ended 0.4 s after the time of its first heartbeat, which came during the restart.
    process.env["HEADROOM_HOME"] = home2;
    const stopped = new Promise((resolve) => old.once("close", resolve));
    if (old.pid !== undefined) {
      writePlannedStop(old.pid);
      killTree(old.pid);
    }
    await stopped;
    // The first heartbeat comes 3 s after the start of the job. No daemon runs until 6 s after the grant.
    await pause(Math.max(0, granted + 6000 - Date.now()));
    const alive = attached.child.exitCode === null;
    const next = await daemon(home2, port);
    children.push(next);
    await pause(5000);
    const state = await job(home2, "beat");
    expect({ alive, state: state?.state, reason: state?.reason, err: attached.child.exitCode === null ? "" : "ended" }).toEqual({ alive: true, state: "running", reason: state?.reason, err: "" });
    writeFileSync(go, "");
    const end = await attached.ended;
    expect({ code: end.code, err: end.err }).toEqual({ code: 5, err: end.err });
    const stoppedNext = new Promise((resolve) => next.once("close", resolve));
    next.kill();
    await stoppedNext;
    rmSync(home2, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it("gives the true exit of a job that ends while no daemon runs", { timeout: 150_000 }, async () => {
    const home3 = mkdtempSync(join(tmpdir(), "headroom-restart-gap-"));
    const port = await freePort();
    const old = await daemon(home3, port);
    children.push(old);
    const script = join(home3, "job.mjs");
    writeFileSync(script, JOB);
    const go = join(home3, "go");
    const attached = start(home3, ["run", "--job", "gap", "--", process.execPath, script, go]);
    children.push(attached.child);
    await until(async () => ((await job(home3, "gap"))?.state === "running" ? true : undefined), 40_000);
    await pause(4000);
    process.env["HEADROOM_HOME"] = home3;
    const stopped = new Promise((resolve) => old.once("close", resolve));
    if (old.pid !== undefined) {
      writePlannedStop(old.pid);
      killTree(old.pid);
    }
    await stopped;
    // The job ends, and its client cannot reach a daemon for its release.
    writeFileSync(go, "");
    const end = await attached.ended;
    expect(end.code).toBe(5);
    const next = await daemon(home3, port);
    children.push(next);
    const state = await until(async () => {
      const read = await job(home3, "gap");
      return read !== undefined && read.state !== "running" ? read : undefined;
    });
    expect({ state: state.state, exitCode: state.exitCode, recorded: state.reason?.endsWith(RECORDED_END_NOTE) }).toEqual({ state: "exited", exitCode: 5, recorded: true });
    const stoppedNext = new Promise((resolve) => next.once("close", resolve));
    next.kill();
    await stoppedNext;
    rmSync(home3, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  // The deploy of 2026-11-18 ended the adopted job of template-c3. The daemon had a job with no silent breakaway, and the
  // job of the scheduled task ended each process in it at the restart. Before H202, the client of an adopted job was in it.
  it("keeps a detached job when the job of the daemon closes", { timeout: 150_000, skip: process.platform !== "win32" }, async (context) => {
    const home4 = mkdtempSync(join(tmpdir(), "headroom-restart-close-"));
    const port = await freePort();
    const old = await daemon(home4, port);
    children.push(old);
    const holderScript = join(home4, "holder.mjs");
    writeFileSync(holderScript, HOLDER);
    const core = pathToFileURL(join(import.meta.dirname, "..", "..", "core", "package.json")).href;
    const holder = spawn(process.execPath, [holderScript, core, String(old.pid)], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(holder);
    const said = await new Promise<string>((resolve) => {
      let out = "";
      holder.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (out.includes("\n")) resolve(out.trim());
      });
      holder.on("close", () => resolve(out.trim()));
    });
    if (said !== "ready") {
      context.skip(`the holder did not put the daemon in a job: ${said}`);
      return;
    }
    const script = join(home4, "job.mjs");
    writeFileSync(script, JOB);
    const go = join(home4, "go");
    const log = join(home4, "closing.log");
    expect((await headroom(home4, ["run", "--detach", "--job", "closing", "--log", log, "--", process.execPath, script, go])).code).toBe(0);
    await until(async () => ((await job(home4, "closing"))?.state === "running" ? true : undefined));
    const route = readFileSync(log, "utf8");
    if (route.includes("runs in the jobs of the caller")) {
      context.skip(`the relay did not leave the jobs of the daemon: ${route.split("\n").find((line) => line.includes("jobs of the caller"))}`);
      return;
    }
    await pause(4000);

    // The stop of a scheduled task: the mark of a planned stop, then the close of the job of the daemon.
    process.env["HEADROOM_HOME"] = home4;
    const stopped = new Promise((resolve) => old.once("close", resolve));
    if (old.pid !== undefined) writePlannedStop(old.pid);
    holder.kill();
    await stopped;
    const next = await daemon(home4, port);
    children.push(next);
    await pause(5000);
    const kept = await job(home4, "closing");
    expect({ state: kept?.state, reason: kept?.reason }).toEqual({ state: "running", reason: kept?.reason });

    writeFileSync(go, "");
    const state = await until(async () => {
      const read = await job(home4, "closing");
      return read?.state === "exited" ? read : undefined;
    });
    expect({ exitCode: state.exitCode, recorded: state.reason?.includes(RECORDED_END_NOTE) }).toEqual({ exitCode: 5, recorded: false });
    const stoppedNext = new Promise((resolve) => next.once("close", resolve));
    next.kill();
    await stoppedNext;
    rmSync(home4, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
});
