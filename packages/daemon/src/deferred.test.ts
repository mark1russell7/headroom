import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, Store, type Lease, type Sampler } from "@headroom/core";
import { afterEach, describe, expect, it } from "vitest";
import { DeferredStarts, launchClient, type DeferredLeases, type DeferredStart } from "./deferred.ts";
import { resourceProcedures } from "./procedures.ts";

const START: DeferredStart = { args: ["--job", "tests", "--", "pnpm", "test"], cwd: ".", env: { TOKEN: "secret-value" }, log: "job.log", waitMs: 1000 };

const ENV = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

function lease(state: Lease["state"], more: Partial<Lease> = {}): Lease {
  return { id: "a", job: "tests", holder: "shop", state, ttlMs: 300, heartbeatAt: 0, reason: null, ...more } as unknown as Lease;
}

function fixture(first: Lease) {
  let now = 0;
  let current: Lease | undefined = first;
  const renewed: number[] = [];
  const released: string[] = [];
  const launched: string[] = [];
  const lines: string[] = [];
  let failure: string | null = null;
  const leases: DeferredLeases = {
    get: () => current,
    renew: () => {
      renewed.push(now);
      if (current) current = { ...current, heartbeatAt: now };
      return current;
    },
    release: (_id, reason) => {
      released.push(reason ?? "");
      return current;
    },
  };
  const queue = new DeferredStarts({
    leases,
    launch: (id, _start, failed) => {
      launched.push(id);
      if (failure !== null) failed(failure);
    },
    write: (_log, line) => lines.push(line),
    now: () => now,
  });
  return {
    queue,
    renewed,
    released,
    launched,
    lines,
    set: (next: Lease | undefined) => (current = next),
    at: (time: number) => (now = time),
    failWith: (reason: string) => (failure = reason),
  };
}

describe("the queue of detached jobs (H64)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("starts no client while the lease waits, and starts one client at the grant", () => {
    const f = fixture(lease("waiting"));
    f.queue.add("a", START);
    f.queue.tick();
    expect(f.launched).toEqual([]);
    expect(f.queue.size).toBe(1);
    f.set(lease("granted"));
    f.queue.tick();
    f.queue.tick();
    expect(f.launched).toEqual(["a"]);
    expect(f.queue.size).toBe(0);
  });

  it("starts the client at once when the request has its grant already", () => {
    const f = fixture(lease("granted"));
    f.queue.add("a", START);
    expect(f.launched).toEqual(["a"]);
  });

  it("gives the heartbeat of a waiting lease, with only three writes in each limit", () => {
    const f = fixture(lease("waiting"));
    f.queue.add("a", START);
    for (let time = 0; time <= 900; time += 2) {
      f.at(time);
      f.queue.tick();
    }
    expect(f.renewed).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
  });

  it("ends a job that waited past its time, and starts nothing", () => {
    const f = fixture(lease("waiting", { reason: "waits for memory" }));
    f.queue.add("a", START);
    f.at(1000);
    f.queue.tick();
    expect(f.released).toEqual(["the wait ended"]);
    expect(f.launched).toEqual([]);
    expect(f.lines.at(-1)).toBe("headroom: tests waited too long (waits for memory). Nothing ran.");
    expect(f.queue.size).toBe(0);
  });

  it("removes a cancelled job, and writes why in its log", () => {
    const f = fixture(lease("waiting"));
    f.queue.add("a", START);
    f.set(lease("cancelled", { reason: "cancelled by shop (headroom cancel)" }));
    f.queue.tick();
    expect(f.launched).toEqual([]);
    expect(f.queue.size).toBe(0);
    expect(f.lines).toEqual(["headroom: the job did not start: cancelled by shop (headroom cancel)."]);
  });

  it("writes each reason of the wait one time", () => {
    const f = fixture(lease("waiting", { reason: "waits for memory" }));
    f.queue.add("a", START);
    f.queue.tick();
    f.queue.tick();
    f.set(lease("waiting", { reason: "waits for starts<700" }));
    f.queue.tick();
    expect(f.lines).toEqual(["headroom: tests waits for memory", "headroom: tests waits for starts<700"]);
  });

  it("releases the lease when the client does not start, so the queue moves on", () => {
    const f = fixture(lease("waiting"));
    f.failWith("no such folder");
    f.queue.add("a", START);
    f.set(lease("granted"));
    f.queue.tick();
    expect(f.released).toEqual(["the client did not start: no such folder"]);
    expect(f.lines.at(-1)).toBe("headroom: the client of the job did not start: no such folder");
  });

  it("gives each waiting job a client when the daemon stops, and starts it one time", () => {
    const f = fixture(lease("waiting"));
    f.queue.add("a", START);
    f.queue.handOff();
    f.queue.tick();
    expect(f.launched).toEqual(["a"]);
    expect(f.released).toEqual([]);
    expect(f.queue.size).toBe(0);
  });

  it("calls the failure when the folder of the job does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-deferred-"));
    dirs.push(dir);
    const log = join(dir, "job.log");
    const launch = launchClient(process.execPath, join(dir, "no-cli.ts"), "headroom-test");
    const reason = await new Promise<string>((resolve) => launch("a", { ...START, cwd: join(dir, "missing"), env: ENV, log }, resolve));
    expect(reason.length).toBeGreaterThan(0);
  });

  it("calls the failure when the start exits with an error, and writes the output to the log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-deferred-"));
    dirs.push(dir);
    const log = join(dir, "job.log");
    const launch = launchClient(process.execPath, join(dir, "no-cli.ts"), "headroom-test");
    const reason = await new Promise<string>((resolve) => launch("a", { ...START, cwd: dir, env: ENV, log }, resolve));
    expect(reason).toMatch(/the start ended with code/);
    expect(readFileSync(log, "utf8")).toMatch(/no-cli/);
  });

  it("holds through the procedures: the lease has no process, the store has no environment, and adopt gives the process", async () => {
    const now = 10_000_000;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 700 }),
      processes: () => [],
      close: () => undefined,
    };
    const dir = mkdtempSync(join(tmpdir(), "headroom-deferred-"));
    dirs.push(dir);
    const path = join(dir, "tags.db");
    const engine = new Engine({ sampler, store: new Store(path), now: () => now, sessionsDir: "/nowhere" });
    engine.tick();
    const launched: string[] = [];
    const deferred = new DeferredStarts({ leases: engine, launch: (id) => launched.push(id), now: () => now, write: () => undefined });
    const procedures = resourceProcedures(engine, () => null, deferred);
    const call = async (name: string, input: unknown): Promise<Lease> => {
      const procedure = procedures.find((each) => each.path.join(".") === name);
      if (procedure === undefined) throw new Error(`no procedure ${name}`);
      const parsed = (procedure.input as unknown as { parse(value: unknown): unknown }).parse(input);
      return (await (procedure.handler as unknown as (value: unknown, context: unknown) => Promise<Lease>)(parsed, {})) as Lease;
    };

    const first = await call("resources.defer", {
      holder: "shop",
      job: "tests",
      amounts: { memory: 100 },
      log: join(dir, "job.log"),
      start: { args: ["--job", "tests"], cwd: dir, env: { TOKEN: "secret-value" }, waitMs: 60_000 },
    });
    expect(first.pid).toBeNull();
    expect(launched).toEqual([first.id]);
    expect(JSON.stringify(first)).not.toContain("secret-value");

    const adopted = await call("resources.adopt", { id: first.id, pid: process.pid });
    expect(adopted.pid).toBe(process.pid);
    expect(adopted.state).toBe("granted");
    engine.close();
    for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name)).includes(Buffer.from("secret-value"))).toBe(false);
  });

  it("holds through the real commands: no client while the job waits, and its environment reaches the job", async () => {
    const home = mkdtempSync(join(tmpdir(), "headroom-deferred-"));
    dirs.push(home);
    const cli = join(import.meta.dirname, "cli.ts");
    const env = { ...ENV, HEADROOM_HOME: home, H64_MARK: "secret-value" };
    const headroom = (...args: string[]): string => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", cwd: home, timeout: 30_000 }).stdout;
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const leases = (): { job: string; state: string; pid: number | null }[] => (JSON.parse(headroom("status", "--json")) as { leases: { job: string; state: string; pid: number | null }[] }).leases;
    const port = String(47_000 + (process.pid % 1000));
    // The output of the daemon goes to a file, and the ends below have limits, so a failure tells its step and does not only time out.
    const daemonLog = join(home, "daemon.log");
    const output = openSync(daemonLog, "a");
    const daemon = spawn(process.execPath, [cli, "serve", "--port", port, "--reserve", "1"], { env, stdio: ["ignore", output, output], cwd: home });
    closeSync(output);
    const stopped = new Promise((resolve) => daemon.once("exit", resolve));
    let step = "the daemon starts";
    try {
      for (let tries = 0; tries < 60 && readdirSync(home).every((name) => name !== "daemon.json"); tries++) await pause(500);
      step = "the two jobs start";
      headroom("run", "--detach", "--job", "first", "--slot", "docker", "--holder", "t", "--", process.execPath, "-e", "setTimeout(()=>{},4000)");
      const second = headroom("run", "--detach", "--job", "second", "--slot", "docker", "--holder", "t", "--", process.execPath, "-e", "console.log('ran',process.env.H64_MARK)");
      expect(leases().find((each) => each.job === "second")).toMatchObject({ state: "waiting", pid: null });
      const log = /Log: (.+?)\. State/.exec(second)?.[1] ?? "";
      step = "the two jobs end";
      const limit = Date.now() + 30_000;
      while (Date.now() < limit && leases().length > 0) await pause(500);
      expect(readFileSync(log, "utf8")).toContain("ran secret-value");
    } catch (error) {
      const said = existsSync(daemonLog) ? readFileSync(daemonLog, "utf8").slice(-2000) : "no output";
      throw new Error(`Step: ${step}. Daemon exit code: ${String(daemon.exitCode)}. Daemon output: ${said}`, { cause: error });
    } finally {
      daemon.kill();
      await Promise.race([stopped, pause(10_000)]);
    }
    for (const name of readdirSync(home)) {
      if (name.startsWith("headroom.db")) expect(readFileSync(join(home, name)).includes(Buffer.from("secret-value"))).toBe(false);
    }
  }, 90_000);
});
