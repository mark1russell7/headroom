import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, detect, diskLevel, type AlertInput } from "./alerts.ts";
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

  it("warns about a drive with little free space", () => {
    const alerts = detect({ ...input([], {}), disks: [{ mount: "D:", freeMb: 12_600, totalMb: 200_000 }] });
    expect(alerts).toEqual([
      { id: "disk:D:", kind: "disk", subject: "drive D:", pid: null, mb: 12_600, severity: "warning", message: "Drive D: has 12.3 GB free of 195 GB." },
    ]);
  });

  it("flags a nearly full drive as critical, with the loss of the last hour", () => {
    const disks = [{ mount: "C:", freeMb: 4300, totalMb: 974_848, droppedMb: 39_014, windowMinutes: 60 }, { mount: "D:", freeMb: 125_000, totalMb: 200_000 }];
    const alerts = detect({ ...input([], {}), disks });
    expect(alerts.map((alert) => [alert.id, alert.severity])).toEqual([["disk:C:", "critical"]]);
    expect(alerts[0]?.message).toBe("Drive C: has 4.2 GB free of 952 GB, 38.1 GB less than one hour ago.");
    const recent = detect({ ...input([], {}), disks: [{ ...disks[0]!, windowMinutes: 12 }] });
    expect(recent[0]?.message).toContain("38.1 GB less than 12 minutes ago.");
  });

  it("gives no disk alert above the limits, and scales the limits down on a small drive", () => {
    expect(detect({ ...input([], {}), disks: [{ mount: "C:", freeMb: 265_000, totalMb: 774_000 }, { mount: "D:", freeMb: 20_481, totalMb: 200_000 }] })).toEqual([]);
    // A drive of 30 GB warns below 20% (6 GB) and is critical below 5% (1.5 GB).
    expect(diskLevel({ mount: "E:", freeMb: 8000, totalMb: 30_720 })).toBeNull();
    expect(diskLevel({ mount: "E:", freeMb: 5000, totalMb: 30_720 })).toBe("warning");
    expect(diskLevel({ mount: "E:", freeMb: 1000, totalMb: 30_720 })).toBe("critical");
  });

  it("gives each alert of before with the same fields, and no severity outside the disk alerts", () => {
    const low = { ...memory, availableMb: 400.4, commitMb: 75_000, kernelNonpagedMb: 3500, kernelPagedMb: 4600 };
    const alerts = detect({ ...input([], {}), memory: low, poolHourAgoMb: 2800, pagedHourAgoMb: 4700, load: { processes: 1240, userObjects: null, gdiObjects: null } });
    expect(alerts).toStrictEqual([
      { id: "memory", kind: "memory", subject: "memory", pid: null, mb: 400, message: "Only 400 MB of memory is available" },
      { id: "commit", kind: "commit", subject: "commit", pid: null, mb: 75_000, message: "The commit charge is 73.2 GB of its limit 78.1 GB" },
      { id: "pool", kind: "pool", subject: "non-paged pool", pid: null, mb: 3500, message: "The non-paged kernel pool is 3.4 GB, 700 MB more than one hour ago. A driver can leak it." },
      { id: "pool:paged", kind: "pool", subject: "paged pool", pid: null, mb: 4600, message: "The paged kernel pool is 4.5 GB. A file system filter can leak it." },
      {
        id: "desktop", kind: "desktop", subject: "session", pid: null, mb: 0,
        message: "1240 processes run in this session. With this many, a new process can stop at its start with 0xC0000142, because the desktop heap runs out.",
      },
    ]);
  });

  it("gives one alert for each process: a large orphan with no lease is a runaway", () => {
    const alerts = detect(input([p(7, 99, "grep.exe", 6000)], { 7: ["other", "other"] }));
    expect(alerts).toStrictEqual([{ id: "runaway:7", kind: "runaway", subject: "grep.exe (7)", pid: 7, mb: 6000, message: "grep.exe (7) of other holds 5.9 GB with no lease" }]);
    const orphan = detect(input([p(7, 99, "grep.exe", 2000)], { 7: ["other", "other"] }));
    expect(orphan[0]).toStrictEqual({ id: "orphan:7", kind: "orphan", subject: "grep.exe (7)", pid: 7, mb: 2000, message: "grep.exe (7) holds 2.0 GB, and its parent (99) stopped" });
  });

  it("uses the limits of the rules that the caller gives, and no commit alert without a commit limit", () => {
    const strict = { ...DEFAULT_ALERT_RULES, availableMb: 10_000, diskWarnMb: 300_000 };
    const alerts = detect({ ...input([], {}), disks: [{ mount: "C:", freeMb: 265_000, totalMb: 1_774_000 }] }, strict);
    expect(alerts.map((alert) => [alert.id, alert.severity])).toEqual([["memory", undefined], ["disk:C:", "warning"]]);
    expect(diskLevel({ mount: "C:", freeMb: 265_000, totalMb: 1_774_000 }, strict)).toBe("warning");
    expect(detect({ ...input([], {}), memory: { ...memory, commitMb: 9000, commitLimitMb: 0 } })).toEqual([]);
  });
});
