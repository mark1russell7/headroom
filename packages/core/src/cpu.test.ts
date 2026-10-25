import { describe, expect, it } from "vitest";
import type { Lease } from "./broker.ts";
import {
  accountingCpuMs,
  applyCpuControl,
  coresText,
  cpuControlOf,
  cpuGroups,
  cpuLine,
  cpuRateInfo,
  cpuRateOf,
  heldMs,
  suggestCores,
  type CpuRateBinding,
} from "./cpu.ts";
import type { ResourceStatus } from "./resources.ts";
import type { OwnerKind, ProcessInfo } from "./types.ts";

/** A fake binding of `SetInformationJobObject`: it keeps each call, and fails with an error code when one is set. */
function fakeBinding(error: number | null = null): CpuRateBinding & { calls: { job: number; infoClass: number; flags: number; value: number; length: number }[] } {
  const calls: { job: number; infoClass: number; flags: number; value: number; length: number }[] = [];
  return {
    calls,
    setInformation: (job, infoClass, info, length) => {
      calls.push({ job, infoClass, flags: info.readUInt32LE(0), value: info.readUInt32LE(4), length });
      return error === null ? 1 : 0;
    },
    lastError: () => error ?? 0,
  };
}

describe("the CPU rate of a job object (H23)", () => {
  it("gives the rate of a count of cores in 1/100 of a percent of all the processors", () => {
    expect(cpuRateOf(1, 16)).toBe(625);
    expect(cpuRateOf(4, 16)).toBe(2500);
    expect(cpuRateOf(1.5, 12)).toBe(1250);
    // The rate stays from 1 to 10000.
    expect(cpuRateOf(32, 16)).toBe(10_000);
    expect(cpuRateOf(0.0001, 16)).toBe(1);
    expect(() => cpuRateOf(0, 16)).toThrow();
    expect(() => cpuRateOf(1, 0)).toThrow();
  });

  it("prefers a cap to a weight, and keeps a weight from 1 to 9", () => {
    expect(cpuControlOf({})).toBeNull();
    expect(cpuControlOf({ cpuRate: 625, cpuWeight: 5 })).toEqual({ mode: "cap", rate: 625 });
    expect(cpuControlOf({ cpuWeight: 5 })).toEqual({ mode: "weight", weight: 5 });
    expect(cpuControlOf({ cpuWeight: 20 })).toEqual({ mode: "weight", weight: 9 });
    expect(cpuControlOf({ cpuWeight: 0 })).toEqual({ mode: "weight", weight: 1 });
  });

  it("sets class 15 with 8 bytes: ENABLE | HARD_CAP and the rate, or ENABLE | WEIGHT_BASED and the weight", () => {
    const binding = fakeBinding();
    applyCpuControl(binding, 77, { mode: "cap", rate: 625 });
    applyCpuControl(binding, 77, { mode: "weight", weight: 5 });
    expect(binding.calls).toEqual([
      { job: 77, infoClass: 15, flags: 0x5, value: 625, length: 8 },
      { job: 77, infoClass: 15, flags: 0x3, value: 5, length: 8 },
    ]);
    expect(cpuRateInfo({ mode: "cap", rate: 10_000 })).toHaveLength(8);
  });

  it("throws with the error code of Windows when the call fails", () => {
    expect(() => applyCpuControl(fakeBinding(87), 77, { mode: "cap", rate: 625 })).toThrow("SetInformationJobObject (CPU rate) failed with the error 87");
  });

  it("gives the processor time of a job from its accounting, in ms", () => {
    const info = Buffer.alloc(48);
    info.writeBigInt64LE(25_000_000n, 0);
    info.writeBigInt64LE(5_000_000n, 8);
    expect(accountingCpuMs(info)).toBe(3000);
    expect(accountingCpuMs(Buffer.alloc(4))).toBe(0);
  });
});

describe("heldMs", () => {
  const trail = [
    { at: 0, value: 15 },
    { at: 10_000, value: 9 },
    { at: 20_000, value: 15 },
    { at: 30_000, value: 15.5 },
  ];

  it("gives the time from the first point of the last run that passes, to now", () => {
    expect(heldMs(trail, 40_000, (value) => value > 13)).toBe(20_000);
    expect(heldMs(trail, 40_000, (value) => value > 8)).toBe(40_000);
    expect(heldMs(trail, 40_000, (value) => value > 16)).toBe(0);
    expect(heldMs([], 40_000, () => true)).toBe(0);
  });
});

describe("cpuGroups", () => {
  const p = (pid: number, ppid: number): ProcessInfo => ({ pid, ppid, name: `p${pid}.exe`, privateMb: 1, workingMb: 1 });
  // The session process 100 starts a shell 110, and the shell starts a test 120. Process 200 is the job of a lease.
  const processes = [p(100, 1), p(110, 100), p(120, 110), p(200, 110), p(210, 200), p(300, 4), p(310, 300)];
  const ownerOf = new Map([[100, "session:graph"], [110, "session:graph"], [120, "session:graph"], [200, "session:graph"], [210, "session:graph"], [300, "mcp:vex"], [310, "mcp:vex"]]);
  const kindOf = new Map<string, OwnerKind>([["session:graph", "session"], ["mcp:vex", "mcp"]]);
  const leaseOf = new Map([[200, "l1"], [210, "l1"]]);

  it("groups a leased process by its lease, and another process by the top process of its owner, below the session process", () => {
    const groups = cpuGroups(processes, { ownerOf, kindOf, leaseOf });
    expect(Object.fromEntries(groups)).toEqual({
      100: "tree:100",
      110: "tree:110",
      120: "tree:110",
      200: "lease:l1",
      210: "lease:l1",
      300: "tree:300",
      310: "tree:300",
    });
  });

  it("stops at a loop of parents", () => {
    const loop = [p(5, 6), p(6, 5)];
    const groups = cpuGroups(loop, { ownerOf: new Map([[5, "docker"], [6, "docker"]]), kindOf: new Map(), leaseOf: new Map() });
    expect(groups.get(5)).toBe("tree:6");
    expect(groups.get(6)).toBe("tree:5");
  });
});

describe("suggestCores and the CPU line", () => {
  it("gives the 90th percentile of the peak cores and 25% more, from 1 to the cores that the leases can get", () => {
    expect(suggestCores([], 14)).toBeNull();
    expect(suggestCores([3, 2, 2.5, 0.9], 14)).toBe(4);
    expect(suggestCores([0.2], 14)).toBe(1);
    expect(suggestCores([15], 14)).toBe(14);
    expect(suggestCores([15], 0.5)).toBe(1);
    expect(coresText(1)).toBe("1 core");
    expect(coresText(2.46)).toBe("2.5 cores");
  });

  it("names the reserve, the top owners and the capped jobs", () => {
    const cpu: ResourceStatus = {
      id: "cpu",
      kind: "cpu",
      unit: "cores",
      capacity: 16,
      used: 11.24,
      free: 4.76,
      owners: [
        { owner: "session:graph", kind: "session", value: 6.04, unit: "cores" },
        { owner: "mcp:vex", kind: "mcp", value: 2, unit: "cores" },
        { owner: "docker", kind: "docker", value: 1, unit: "cores" },
        { owner: "system", kind: "system", value: 0.5, unit: "cores" },
      ],
    };
    const lease = (job: string, state: Lease["state"], cpuCap?: number): Lease => ({
      id: job, holder: "graph", job, amounts: { cpu: 4 }, priority: 0, pid: 1, ttlMs: 1, state, requestedAt: 0, grantedAt: 0, endedAt: null, heartbeatAt: 0, reason: null, peakMb: null,
      ...(cpuCap === undefined ? {} : { cpuCap }),
    });
    expect(cpuLine(cpu, 2, [lease("graph-e2e", "granted", 4), lease("lint", "granted"), lease("old", "released", 2)])).toBe(
      "CPU: 11.2 of 16 cores in use (2 kept for Mark). Most: session:graph 6.0, mcp:vex 2.0, docker 1.0. Capped: graph-e2e 4 cores.",
    );
    // A daemon of an older version gives no reserve. Before two reads, the processors have no used part.
    expect(cpuLine({ ...cpu, owners: [] }, undefined, [])).toBe("CPU: 11.2 of 16 cores in use.");
    expect(cpuLine({ ...cpu, used: null }, 2, [])).toBeNull();
    expect(cpuLine(undefined, 2, [])).toBeNull();
  });
});
