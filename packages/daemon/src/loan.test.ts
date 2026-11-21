import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, Store, type Lease, type Sampler } from "@headroom/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeferredStarts } from "./deferred.ts";
import { LOAN_ENDED_CODE, LOAN_OPTION_MAX_MS, loanLimitNote, loanOption, loanText, stopJobProcesses, watchLoan } from "./loan.ts";
import { resourceProcedures } from "./procedures.ts";

const T = 1_000_000;

/** A granted lease of 400 MB on a loan of 400 MB that ends 10 seconds after T. */
const lease = (over: Partial<Lease> = {}): Lease =>
  ({
    id: "4f7c2a9e00000000",
    holder: "fleet",
    job: "pnpm install",
    amounts: { memory: 400 },
    priority: 0,
    state: "granted",
    pid: 9,
    requestedAt: T,
    grantedAt: T,
    endedAt: null,
    reason: null,
    loanMs: 10_000,
    loan: { amounts: { memory: 400 }, until: T + 10_000 },
    ...over,
  }) as Lease;

describe("the option --loan of headroom run (H219)", () => {
  it("gives the time limit in ms, and null with no option", () => {
    expect(loanOption("10s", { mem: "auto", keep: false })).toBe(10_000);
    expect(loanOption("2m", { mem: "400m", keep: false })).toBe(120_000);
    expect(loanOption(undefined, { mem: undefined, keep: true })).toBeNull();
  });

  it("needs --mem, refuses --keep, and refuses a time that is not a time, 0, or more than one day", () => {
    expect(loanOption("10s", { mem: undefined, keep: false })).toEqual({ error: expect.stringContaining("--loan needs --mem") });
    expect(loanOption("10s", { mem: "auto", keep: true })).toEqual({ error: expect.stringContaining("--keep") });
    expect(loanOption("soon", { mem: "auto", keep: false })).toEqual({ error: expect.stringContaining("Not a time: soon") });
    expect(loanOption("0s", { mem: "auto", keep: false })).toEqual({ error: expect.stringContaining("above 0") });
    expect(loanOption("25h", { mem: "auto", keep: false })).toEqual({ error: expect.stringContaining("at most 24h") });
    expect(loanOption(`${LOAN_OPTION_MAX_MS}ms`, { mem: "auto", keep: false })).toBe(LOAN_OPTION_MAX_MS);
  });

  it("names a time limit above the longest loan of the daemon, because such a job gets no loan", () => {
    expect(loanLimitNote(120_000)).toBeNull();
    expect(loanLimitNote(600_000)).toBe(
      "headroom: --loan 600 s is longer than the longest loan of the daemon (120 s). The job gets no loan, and waits for free room.",
    );
  });

  it("exits with 75 when a loan ends before its job, as a run that waited too long", () => {
    expect(LOAN_ENDED_CODE).toBe(75);
  });
});

describe("the text of a loan (H219)", () => {
  it("gives the amounts of the loan and the time to its end, for a granted lease only", () => {
    expect(loanText(lease(), T + 2000)).toBe("on a loan of 400 MB, which ends in 8 s");
    expect(loanText(lease({ loan: { amounts: { memory: 400, "memory:gpu0": 2048 }, until: T + 10_000 } }), T + 20_000)).toBe(
      "on a loan of 400 MB and 2 GB of memory:gpu0, which ends in 0 s",
    );
    expect(loanText(lease({ loan: undefined }), T)).toBeNull();
    expect(loanText(lease({ state: "expired" }), T)).toBeNull();
  });
});

describe("the stop of the processes of a job at the end of its loan (H219)", () => {
  it("stops each process except the client, and continues past a process that already ended", () => {
    const stopped: number[] = [];
    const kill = (pid: number): void => {
      if (pid === 30) throw new Error("ESRCH");
      stopped.push(pid);
    };
    expect(stopJobProcesses([7, 20, 30, 40], 7, kill)).toBe(2);
    expect(stopped).toEqual([20, 40]);
  });
});

describe("the watch of a loan (H219)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const networkError = (): Error => Object.assign(new Error("fetch failed"), { code: "NETWORK_ERROR" });

  it("renews every 2 seconds, and ends the job when the daemon ends the loan", async () => {
    const answers: Lease[] = [lease(), lease({ state: "expired", reason: "the loan ended early: the free memory fell under its reserve" })];
    const renew = vi.fn(async () => answers.shift() ?? lease());
    const onEnd = vi.fn();
    watchLoan(lease(), { renew, onEnd });
    await vi.advanceTimersByTimeAsync(1999);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onEnd).toHaveBeenCalledWith("the loan ended early: the free memory fell under its reserve");
    // The watch stops after the end.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("stops the watch when the loan returns, and the job runs on", async () => {
    const renew = vi.fn(async () => lease({ loan: undefined }));
    const onEnd = vi.fn();
    const onReturn = vi.fn();
    watchLoan(lease(), { renew, onEnd, onReturn });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("lets the job run on while no daemon answers before the time limit, and ends it after the time limit", async () => {
    let clock = T;
    const renew = vi.fn(async (): Promise<Lease> => {
      throw networkError();
    });
    const onEnd = vi.fn();
    watchLoan(lease(), { renew, onEnd, now: () => clock });
    clock = T + 8000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(onEnd).not.toHaveBeenCalled();
    clock = T + 10_000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(onEnd).toHaveBeenCalledWith("no daemon answers after the time limit of the loan (10 s)");
  });

  it("ends the job at once when the daemon does not know the lease", async () => {
    const renew = vi.fn(async (): Promise<Lease> => {
      throw new Error("No lease has the id 4f7c2a9e");
    });
    const onEnd = vi.fn();
    watchLoan(lease(), { renew, onEnd, now: () => T });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onEnd).toHaveBeenCalledWith("the daemon does not know the lease: No lease has the id 4f7c2a9e");
  });

  it("sends no second renewal while the first one waits, and gives no watch for a lease with no loan", async () => {
    let answer: (value: Lease) => void = () => undefined;
    const renew = vi.fn(() => new Promise<Lease>((resolve) => (answer = resolve)));
    const stop = watchLoan(lease(), { renew, onEnd: vi.fn() });
    await vi.advanceTimersByTimeAsync(6000);
    expect(renew).toHaveBeenCalledTimes(1);
    answer(lease());
    await vi.advanceTimersByTimeAsync(2000);
    expect(renew).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(2);

    const none = vi.fn(async () => lease());
    watchLoan(lease({ loan: undefined }), { renew: none, onEnd: vi.fn() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(none).not.toHaveBeenCalled();
  });
});

describe("the time limit of a loan through the procedures (H219)", () => {
  const sampler: Sampler = {
    memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 700 }),
    processes: () => [],
    close: () => undefined,
  };

  it("gives loanMs of a lease and of a deferred lease to the broker, and refuses 0 and more than one day", async () => {
    const now = 10_000_000;
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    try {
      engine.tick();
      const deferred = new DeferredStarts({ leases: engine, launch: () => undefined, now: () => now, write: () => undefined });
      const procedures = resourceProcedures(engine, () => null, deferred);
      const call = async (name: string, input: unknown): Promise<Lease> => {
        const procedure = procedures.find((each) => each.path.join(".") === name);
        if (procedure === undefined) throw new Error(`no procedure ${name}`);
        const parsed = (procedure.input as unknown as { parse(value: unknown): unknown }).parse(input);
        return (await (procedure.handler as unknown as (value: unknown, context: unknown) => Promise<Lease>)(parsed, {})) as Lease;
      };
      const base = { holder: "fleet", job: "pnpm install", amounts: { memory: 400 }, ttlMs: 60_000 };
      const lease = await call("resources.lease", { ...base, loanMs: 10_000 });
      // The job fits in the free room, so it gets its grant with no loan. The lease keeps its time limit.
      expect(lease).toMatchObject({ state: "granted", loanMs: 10_000 });
      expect(lease.loan).toBeUndefined();
      const start = { args: ["--job", "pnpm install"], cwd: tmpdir(), env: {}, waitMs: 60_000 };
      const { ttlMs: _ttlMs, ...withoutTtl } = base;
      const later = await call("resources.defer", { ...withoutTtl, job: "pnpm install later", log: join(tmpdir(), "h219.log"), start, loanMs: 20_000 });
      expect(later.loanMs).toBe(20_000);
      await expect(call("resources.lease", { ...base, loanMs: 0 })).rejects.toThrow();
      await expect(call("resources.lease", { ...base, loanMs: 86_400_001 })).rejects.toThrow();
      await expect(call("resources.lease", { ...base, loanMs: 1.5 })).rejects.toThrow();
    } finally {
      engine.close();
    }
  });
});

describe("headroom run --loan (H219)", () => {
  it("stops the run with exit 2 before the lease when --loan has no --mem, or goes with --keep", () => {
    const home = mkdtempSync(join(tmpdir(), "headroom-loan-run-"));
    try {
      const cli = join(import.meta.dirname, "cli.ts");
      const env = { ...process.env, HEADROOM_HOME: home };
      const run = (...args: string[]) => spawnSync(process.execPath, [cli, "run", ...args, "--", process.execPath, "-e", ""], { env, encoding: "utf8", cwd: home, timeout: 30_000 });
      const noMem = run("--loan", "10s");
      expect(noMem.status).toBe(2);
      expect(noMem.stderr).toContain("--loan needs --mem");
      const keep = run("--loan", "10s", "--mem", "400m", "--keep");
      expect(keep.status).toBe(2);
      expect(keep.stderr).toContain("--loan does not go with --keep");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
