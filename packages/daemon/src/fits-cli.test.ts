import { Engine, Store, type LeaseRequest, type Sampler } from "@headroom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "./client.ts";
import { DOES_NOT_FIT, fitsCommand, NO_READ, type FitsOutput } from "./fits-cli.ts";

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
  const io = (): FitsOutput => ({ out: (text) => lines.push(text), err: (text) => errors.push(text) });

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
        const ask = input as Omit<LeaseRequest, "holder" | "job"> & { holder?: string; job?: string };
        return engine.fits({ ...ask, holder: ask.holder ?? "headroom fits", job: ask.job ?? "headroom fits" }) as T;
      },
    };
  });
  afterEach(() => engine.close());

  it("exits 0 when the lease starts at the next tick, and makes no lease", async () => {
    expect(await fitsCommand(["--mem", "750m", "--cpu", "1", "--job", "fleet install"], connection, io())).toBe(0);
    expect(calls).toEqual([{ path: ["resources", "fits"], input: { amounts: { memory: 750, cpu: 1 }, priority: 0, job: "fleet install" } }]);
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
    expect(JSON.parse(lines.join("\n"))).toEqual({ fits: true, loan: false, reason: null, state: "granted" });
  });

  it("exits 3 with no read when the daemon does not run or has no dry tick", async () => {
    expect(await fitsCommand(["--mem", "1g"], null, io())).toBe(NO_READ);
    expect(errors[0]).toMatch(/^headroom does not run/);
    const old: Connection = { endpoint: "http://127.0.0.1:0", call: async () => Promise.reject(new Error("no procedure resources.fits")) };
    expect(await fitsCommand(["--mem", "1g"], old, io())).toBe(NO_READ);
    expect(errors.at(-1)).toBe("headroom: the daemon gave no dry tick: no procedure resources.fits");
  });

  it("exits 2 for a wrong use, and calls nothing", async () => {
    for (const argv of [[], ["--cpu", "0"], ["--mem", "1g", "--priority", "1.5"], ["--mem", "1g", "extra"], ["--mem", "lots"]]) {
      expect(await fitsCommand(argv, connection, io())).toBe(2);
    }
    expect(calls).toEqual([]);
    expect(errors.filter((line) => line.startsWith("Usage: headroom fits"))).toHaveLength(5);
  });
});
