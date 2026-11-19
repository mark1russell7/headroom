import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, PEAK_FLOOR_CODE, PeakFloorError, Store, type JobKey, type Lease, type Sampler } from "@headroom/core";
import { afterEach, describe, expect, it } from "vitest";
import { isPeakFloorRefusal } from "./client.ts";
import { DeferredStarts } from "./deferred.ts";
import { keyOfRun } from "./job-key.ts";
import { resourceProcedures } from "./procedures.ts";

const ENV = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sampler: Sampler = {
  memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 700 }),
  processes: () => [],
  close: () => undefined,
};

/** This function writes a run of a command that ended with a peak of `peakMb`, with its key, as a lease of the daemon does. */
function seedRun(store: Store, id: string, key: JobKey, peakMb: number, endedAt: number): void {
  store.saveLease({
    id,
    holder: "visuals",
    job: "visuals bundle",
    amounts: { memory: 900 },
    priority: 0,
    pid: null,
    ttlMs: 60_000,
    state: "released",
    requestedAt: endedAt - 2000,
    grantedAt: endedAt - 1900,
    endedAt,
    heartbeatAt: 0,
    reason: null,
    peakMb,
    exitCode: 0,
  } as Lease);
  store.saveLeaseKey(id, key, { mb: null, rung: "none", runs: 0, peakMb: null }, { ms: 1000, from: "all", runs: 0 });
}

describe("isPeakFloorRefusal (H215)", () => {
  it("tells a refusal of the floor from the other errors", () => {
    expect(isPeakFloorRefusal(Object.assign(new Error("below the floor"), { code: PEAK_FLOOR_CODE }))).toBe(true);
    expect(isPeakFloorRefusal(Object.assign(new Error("no answer"), { code: "NETWORK_ERROR" }))).toBe(false);
    expect(isPeakFloorRefusal({ code: PEAK_FLOOR_CODE })).toBe(false);
    expect(isPeakFloorRefusal(null)).toBe(false);
  });
});

describe("The floor through the procedures (H215)", () => {
  it("refuses a lease and a deferred lease below the floor, and takes the reason of --below-peak", async () => {
    const now = 10_000_000;
    const dir = mkdtempSync(join(tmpdir(), "headroom-floor-"));
    dirs.push(dir);
    const store = new Store(join(dir, "floor.db"));
    const key: JobKey = { kind: "build", repo: "visuals", lock: "0123456789abcdef", filter: ".", warm: true, packages: 400, command: "pnpm -s build" };
    seedRun(store, "seed-run-0001", key, 803, now - 1000);
    const engine = new Engine({ sampler, store, now: () => now, sessionsDir: "/nowhere" });
    engine.tick();
    const deferred = new DeferredStarts({ leases: engine, launch: () => undefined, now: () => now, write: () => undefined });
    const procedures = resourceProcedures(engine, () => null, deferred);
    const call = async (name: string, input: unknown): Promise<Lease> => {
      const procedure = procedures.find((each) => each.path.join(".") === name);
      if (procedure === undefined) throw new Error(`no procedure ${name}`);
      const parsed = (procedure.input as unknown as { parse(value: unknown): unknown }).parse(input);
      return (await (procedure.handler as unknown as (value: unknown, context: unknown) => Promise<Lease>)(parsed, {})) as Lease;
    };
    const base = { holder: "visuals", job: "visuals bundle retry", amounts: { memory: 500 }, key };
    await expect(call("resources.lease", base)).rejects.toBeInstanceOf(PeakFloorError);
    await expect(call("resources.lease", base)).rejects.toMatchObject({ code: PEAK_FLOOR_CODE, floor: { floorMb: 884 } });
    const start = { args: ["--job", "visuals bundle retry"], cwd: dir, env: {}, waitMs: 60_000 };
    await expect(call("resources.defer", { ...base, log: join(dir, "job.log"), start })).rejects.toBeInstanceOf(PeakFloorError);
    expect(store.activeLeases()).toHaveLength(0);
    const below = await call("resources.lease", { ...base, belowPeak: "a half input" });
    expect(below.state).toBe("granted");
    expect(store.leaseKeyRow(below.id)).toMatchObject({ floorMb: 884, belowPeak: "a half input" });
    // An empty reason is not a reason: the schema refuses it.
    await expect(call("resources.lease", { ...base, belowPeak: "" })).rejects.toThrow();
    engine.close();
  });
});

describe("headroom run against the floor (H215)", () => {
  it("does not start a job below the floor, in the foreground or detached, and starts it with a reason", async () => {
    const home = mkdtempSync(join(tmpdir(), "headroom-floor-run-"));
    dirs.push(home);
    const cli = join(import.meta.dirname, "cli.ts");
    const env = { ...ENV, HEADROOM_HOME: home };
    const proof = join(home, "ran.txt");
    const argv = [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(proof)}, "ran")`];
    // The run of the case: the same command used 803 MB at its peak. The client gives this key to this command in this folder.
    const key = keyOfRun(argv, home);
    expect(key).not.toBeNull();
    const seed = new Store(join(home, "headroom.db"));
    seedRun(seed, "seed-run-0001", key as JobKey, 803, Date.now() - 60_000);
    seed.close();
    const headroom = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", cwd: home, timeout: 30_000 });
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const port = String(48_500 + (process.pid % 500));
    const daemonLog = join(home, "daemon.log");
    const output = openSync(daemonLog, "a");
    const daemon = spawn(process.execPath, [cli, "serve", "--port", port, "--reserve", "1"], { env, stdio: ["ignore", output, output], cwd: home });
    closeSync(output);
    const stopped = new Promise((resolve) => daemon.once("exit", resolve));
    let step = "the daemon starts";
    try {
      for (let tries = 0; tries < 60 && readdirSync(home).every((name) => name !== "daemon.json"); tries++) await pause(500);
      step = "a foreground job below the floor";
      const foreground = headroom("run", "--mem", "500m", "--job", "retry", "--holder", "visuals", "--", ...argv);
      expect(foreground.status).toBe(75);
      expect(foreground.stderr).toContain("The lease of 500 MB is below the floor of 884 MB for this command.");
      expect(foreground.stderr).toContain("used 803 MB at its peak");
      step = "a detached job below the floor";
      const detached = headroom("run", "--detach", "--mem", "500m", "--job", "retry detached", "--holder", "visuals", "--", ...argv);
      expect(detached.status).toBe(75);
      expect(detached.stderr).toContain("below the floor of 884 MB");
      const status = JSON.parse(headroom("status", "--json").stdout) as { leases: unknown[] };
      expect(status.leases).toHaveLength(0);
      expect(existsSync(proof)).toBe(false);
      step = "an empty reason";
      expect(headroom("run", "--mem", "500m", "--below-peak", " ", "--holder", "visuals", "--", ...argv).status).toBe(2);
      step = "a job below the floor with a reason";
      const below = headroom("run", "--mem", "500m", "--below-peak", "a smaller input", "--job", "retry reason", "--holder", "visuals", "--", ...argv);
      expect(below.status).toBe(0);
      expect(readFileSync(proof, "utf8")).toBe("ran");
    } catch (error) {
      const said = existsSync(daemonLog) ? readFileSync(daemonLog, "utf8").slice(-2000) : "no output";
      throw new Error(`Step: ${step}. Daemon exit code: ${String(daemon.exitCode)}. Daemon output: ${said}`, { cause: error });
    } finally {
      daemon.kill();
      await Promise.race([stopped, pause(10_000)]);
    }
  }, 90_000);
});
