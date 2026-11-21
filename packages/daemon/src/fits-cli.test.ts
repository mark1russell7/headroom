import { CPU_AUTO_DEFAULT, Engine, FITS_DEFAULT, Store, type JobKey, type LeaseRequest, type Sampler } from "@headroom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "./client.ts";
import { DOES_NOT_FIT, fitsCommand, NO_READ, type FitsOutput } from "./fits-cli.ts";
import { AUTO_DEFAULT_MB } from "./lease-report.ts";

const sampler: Sampler = {
  memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
  processes: () => [],
  close: () => undefined,
};

describe("headroom fits (H220)", () => {
  let now: number;
  let engine: Engine;
  let calls: { path: readonly string[]; input: unknown }[];
  let lines: string[];
  let errors: string[];
  let connection: Connection;
  const io = (): FitsOutput => ({ out: (text) => lines.push(text), err: (text) => errors.push(text), cwd: "/nowhere" });

  beforeEach(() => {
    now = 1_000_000;
    engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    calls = [];
    lines = [];
    errors = [];
    connection = {
      endpoint: "http://127.0.0.1:0",
      call: async <T>(path: readonly string[], input: unknown): Promise<T> => {
        calls.push({ path, input });
        if (path[1] === "suggest") {
          const asked = input as { job: string; holder: string; key?: JobKey };
          return engine.suggest(asked.job, asked.holder, asked.key ?? null) as T;
        }
        const ask = input as Omit<LeaseRequest, "holder" | "job"> & { holder?: string; job?: string };
        return engine.fits({ ...ask, holder: ask.holder ?? FITS_DEFAULT, job: ask.job ?? FITS_DEFAULT }) as T;
      },
    };
  });
  afterEach(() => engine.close());

  it("exits 0 when the lease starts at the next tick, and makes no lease", async () => {
    expect(await fitsCommand(["--mem", "750m", "--cpu", "1", "--job", "site install"], connection, io())).toBe(0);
    expect(calls).toEqual([{ path: ["resources", "fits"], input: { amounts: { memory: 750, cpu: 1 }, priority: 0, job: "site install" } }]);
    expect(lines).toEqual(["A lease of memory 750 MB, cpu 1 at priority 0 starts at the next tick."]);
    expect(errors).toEqual([]);
    expect(engine.status().leases).toEqual([]);
  });

  it("exits 1 when the lease waits, gives the reason of the broker, and changes no lease", async () => {
    // A granted lease of this process holds most of the 9000 MB that are free.
    const held = engine.request({ holder: "shop", job: "docker build", amounts: { memory: 6000 }, pid: process.pid });
    expect(held.state).toBe("granted");
    const before = JSON.stringify(engine.status().leases);
    expect(await fitsCommand(["--mem", "500m"], connection, io())).toBe(0);
    expect(await fitsCommand(["--mem", "4g"], connection, io())).toBe(DOES_NOT_FIT);
    expect(errors.at(-1)).toMatch(/^A lease of memory 4096 MB at priority 0 waits: ./);
    expect(JSON.stringify(engine.status().leases)).toBe(before);
  });

  it("exits 1 when the lease cannot start at any time", async () => {
    expect(await fitsCommand(["--mem", "200g"], connection, io())).toBe(DOES_NOT_FIT);
    expect(errors.at(-1)).toMatch(/^A lease of memory 204800 MB at priority 0 cannot start at any time: ./);
    expect(engine.status().leases).toEqual([]);
  });

  it("gives the answer as JSON with --json", async () => {
    expect(await fitsCommand(["--mem", "1g", "--json"], connection, io())).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toEqual({ fits: true, loan: false, reason: null, state: "granted", amounts: { memory: 1024 } });
  });

  it("takes the amounts of the last runs of the job with --mem auto and --cpu auto, as headroom run does", async () => {
    // No run of the job is known, so the amounts are the defaults of headroom run.
    expect(await fitsCommand(["--mem", "auto", "--cpu", "auto", "--priority", "31", "--job", "site install", "--", "node", "install.ts"], connection, io())).toBe(0);
    expect(calls.map((call) => call.path[1])).toEqual(["suggest", "fits"]);
    expect(calls[0]?.input).toMatchObject({ job: "site install", holder: FITS_DEFAULT });
    expect(calls[1]?.input).toEqual({ amounts: { memory: AUTO_DEFAULT_MB, cpu: CPU_AUTO_DEFAULT }, priority: 31, job: "site install" });
    expect(lines).toEqual([`A lease of memory ${AUTO_DEFAULT_MB} MB, cpu ${CPU_AUTO_DEFAULT} at priority 31 starts at the next tick.`]);
  });

  it("exits 3 with no read when the daemon does not run or has no dry tick", async () => {
    expect(await fitsCommand(["--mem", "1g"], null, io())).toBe(NO_READ);
    expect(errors[0]).toMatch(/^headroom does not run/);
    const old: Connection = { endpoint: "http://127.0.0.1:0", call: async () => Promise.reject(new Error("no procedure resources.fits")) };
    expect(await fitsCommand(["--mem", "1g"], old, io())).toBe(NO_READ);
    expect(errors.at(-1)).toBe("headroom: the daemon gave no dry tick: no procedure resources.fits");
  });

  it("gives the time limit of --loan to the dry tick, as headroom run does (H219)", async () => {
    expect(await fitsCommand(["--mem", "500m", "--loan", "60s"], connection, io())).toBe(0);
    expect(calls).toEqual([{ path: ["resources", "fits"], input: { amounts: { memory: 500 }, priority: 0, loanMs: 60_000 } }]);
  });

  it("exits 2 for a wrong use, and calls nothing", async () => {
    for (const argv of [[], ["--cpu", "0"], ["--mem", "1g", "--priority", "1.5"], ["--mem", "1g", "extra"], ["--mem", "lots"], ["--cpu", "1", "--loan", "60s"], ["--mem", "1g", "--loan", "0s"]]) {
      expect(await fitsCommand(argv, connection, io())).toBe(2);
    }
    expect(calls).toEqual([]);
    expect(errors.filter((line) => line.startsWith("Usage: headroom fits"))).toHaveLength(7);
  });
});
