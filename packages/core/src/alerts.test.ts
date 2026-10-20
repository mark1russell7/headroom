import { describe, expect, it } from "vitest";
import { detect, type AlertInput } from "./alerts.ts";
import type { Lease } from "./broker.ts";
import type { OwnerKind, ProcessInfo } from "./types.ts";

const p = (pid: number, ppid: number, name: string, privateMb: number): ProcessInfo => ({ pid, ppid, name, privateMb, workingMb: privateMb });
const memory = { totalMb: 28_000, availableMb: 8000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 };

const lease = (pid: number): Lease => ({
  id: "l1", holder: "graph", job: "vitest", amounts: { memory: 6000 }, priority: 0, pid, ttlMs: 0, state: "granted",
  requestedAt: 0, grantedAt: 0, endedAt: null, heartbeatAt: 0, reason: null, peakMb: null,
});

function input(processes: ProcessInfo[], owners: Record<number, [string, OwnerKind]>, extra: Partial<AlertInput> = {}): AlertInput {
  return {
    memory,
    processes,
    ownerOf: new Map(Object.entries(owners).map(([pid, [owner]]) => [Number(pid), owner])),
    kindOf: new Map(Object.values(owners).map(([owner, kind]) => [owner, kind])),
    leases: [],
    ...extra,
  };
}

describe("detect", () => {
  it("flags a large process with no lease, and not one under a lease or in Docker", () => {
    const processes = [p(1, 0, "claude.exe", 500), p(2, 1, "grep.exe", 16_000), p(3, 1, "node.exe", 1000), p(4, 3, "vitest.exe", 6000), p(5, 0, "vmmemWSL", 8000)];
    const owners: Record<number, [string, OwnerKind]> = {
      1: ["session:graph", "session"], 2: ["session:graph", "session"], 3: ["session:graph", "session"], 4: ["session:graph", "session"], 5: ["docker", "docker"],
    };
    const alerts = detect(input(processes, owners, { leases: [lease(3)] }));
    expect(alerts.map((alert) => alert.id)).toEqual(["runaway:2"]);
    expect(alerts[0]?.message).toBe("grep.exe (2) of session:graph holds 15.6 GB with no lease");
  });

  it("flags a large orphan with no owner", () => {
    const alerts = detect(input([p(7, 99, "grep.exe", 2000), p(8, 99, "M365Copilot.exe", 90)], { 7: ["other", "other"], 8: ["other", "other"] }));
    expect(alerts.map((alert) => alert.id)).toEqual(["orphan:7"]);
  });

  it("flags low memory, a commit near its limit, and a pool that grows", () => {
    const low = { ...memory, availableMb: 400, commitMb: 75_000, kernelNonpagedMb: 1800 };
    const alerts = detect({ ...input([], {}), memory: low, poolHourAgoMb: 1000 });
    expect(alerts.map((alert) => alert.kind)).toEqual(["memory", "commit", "pool"]);
    expect(alerts[2]?.message).toContain("800 MB more than one hour ago");
  });

  it("flags a large or fast-growing paged pool", () => {
    const big = detect({ ...input([], {}), memory: { ...memory, kernelPagedMb: 4600 } });
    expect(big.map((alert) => alert.id)).toEqual(["pool:paged"]);
    const fast = detect({ ...input([], {}), memory: { ...memory, kernelPagedMb: 2900 }, pagedHourAgoMb: 2200 });
    expect(fast[0]?.message).toContain("The paged kernel pool is 2.8 GB, 700 MB more than one hour ago");
  });

  it("flags a session with very many processes", () => {
    const busy = detect({ ...input([], {}), load: { processes: 1240, userObjects: 9100, gdiObjects: 15000 } });
    expect(busy.map((alert) => alert.id)).toEqual(["desktop"]);
    expect(busy[0]?.message).toContain("1240 processes run in this session (9100 USER and 15000 GDI objects)");
    expect(detect({ ...input([], {}), load: { processes: 504, userObjects: 2685, gdiObjects: 4445 } })).toEqual([]);
  });

  it("gives nothing on a quiet computer", () => expect(detect({ ...input([], {}), poolHourAgoMb: 980 })).toEqual([]));
});
