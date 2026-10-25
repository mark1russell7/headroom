import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, detect, type AlertInput } from "./alerts.ts";
import { HANDLES_FLOOR, HandleTracker, handlesLines, handleStatus } from "./handles.ts";
import type { ProcessRecord } from "./orphans.ts";
import { RESOURCES } from "./resources.ts";
import type { ProcessInfo } from "./types.ts";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const memory = { totalMb: 28_000, availableMb: 8000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 };
const p = (pid: number, ppid: number, name: string, handles?: number, startedAt = T0 - 44 * MIN): ProcessInfo => ({
  pid, ppid, name, privateMb: 10, workingMb: 10, startedAt, ...(handles === undefined ? {} : { handles }),
});

// find.exe (27056) is an orphan: its parent bash.exe (900) ended. The record keeps the session as its owner.
const find = p(27056, 900, "find.exe", 1_313_105);
const record: ProcessRecord = {
  pid: 27056, created: find.startedAt ?? 0, owner: "session:server-stack tools", command: "find / -name WIRE-PROTOCOL.md -path *procedures*", firstSeen: T0 - 44 * MIN,
};

/** This function gives a trail with one point each minute, the last at `at`. */
const trailOf = (values: readonly number[], at = T0, stepMs = MIN): { at: number; value: number }[] =>
  values.map((value, index) => ({ at: at - (values.length - 1 - index) * stepMs, value }));

function handleAlerts(values: readonly number[], active: AlertInput["active"] = [], extra: Partial<AlertInput> = {}, stepMs = MIN) {
  const processes = extra.processes ?? [find];
  return detect({
    memory,
    processes,
    ownerOf: new Map([[27056, "session:server-stack tools (orphan)"]]),
    kindOf: new Map([["session:server-stack tools (orphan)", "other"]]),
    leases: [],
    at: T0,
    handles: [{ pid: 27056, trail: trailOf(values, T0, stepMs) }],
    recordOf: (info) => (info.pid === 27056 ? record : undefined),
    active,
    ...extra,
  }).filter((alert) => alert.kind === "handles");
}

describe("the handles alert (H48)", () => {
  it("names the process, its handles, its gain, its age, its owner and its command", () => {
    const values = [0, 1, 2, 3, 4, 5].map((minute) => 1_113_105 + minute * 40_000);
    expect(handleAlerts(values)).toEqual([
      {
        id: "runaway:handles:27056",
        kind: "handles",
        subject: "find.exe (27056)",
        pid: 27056,
        mb: 0,
        severity: "critical",
        message:
          "find.exe (pid 27056) holds 1,313,105 handles, +40,000 a minute. It started 44 min ago. Owner: session:server-stack tools (orphan, parent ended)." +
          " Command: find / -name WIRE-PROTOCOL.md -path *procedures*. The owner stops it by its pid.",
      },
    ]);
  });

  it("gives a warning above 100,000 handles and a critical alert above 500,000", () => {
    expect(handleAlerts([100_000, 100_000])).toEqual([]);
    expect(handleAlerts([100_001, 100_001])).toMatchObject([{ severity: "warning" }]);
    expect(handleAlerts([500_000, 500_000])).toMatchObject([{ severity: "warning" }]);
    expect(handleAlerts([500_001, 500_001])).toMatchObject([{ severity: "critical" }]);
    // A flat count has no gain, so the text gives no rate.
    expect(handleAlerts([150_000, 150_000])[0]?.message).toContain("holds 150,000 handles. It started");
  });

  it("gives a warning for a gain above 20,000 handles in 5 minutes", () => {
    expect(handleAlerts([10_000, 30_000])).toEqual([]);
    expect(handleAlerts([10_000, 30_001])).toMatchObject([{ severity: "warning" }]);
    // 4,000 handles each minute: the gain in any 5 minutes is 20,000, not more.
    expect(handleAlerts([10_000, 14_000, 18_000, 22_000, 26_000, 30_000, 34_000])).toEqual([]);
    expect(handleAlerts([10_000, 14_100, 18_200, 22_300, 26_400, 30_500])).toMatchObject([{ severity: "warning" }]);
  });

  it("keeps an active alert for 2 minutes under its line, and clears it after", () => {
    const warning = [{ id: "runaway:handles:27056", severity: "warning" as const }];
    const step = 10_000;
    const over = Array.from({ length: 12 }, () => 120_000);
    expect(handleAlerts([...over, ...Array.from({ length: 11 }, () => 90_000)], warning, {}, step)).toMatchObject([{ severity: "warning" }]);
    expect(handleAlerts([...over, ...Array.from({ length: 13 }, () => 90_000)], warning, {}, step)).toEqual([]);
    // With no active alert, the count under the line gives no alert.
    expect(handleAlerts([...over, ...Array.from({ length: 11 }, () => 90_000)], [], {}, step)).toEqual([]);
    // A critical alert falls to a warning after 2 minutes under 500,000.
    const critical = [{ id: "runaway:handles:27056", severity: "critical" as const }];
    expect(handleAlerts([...Array.from({ length: 6 }, () => 600_000), ...Array.from({ length: 11 }, () => 300_000)], critical, {}, step)).toMatchObject([{ severity: "critical" }]);
    expect(handleAlerts([...Array.from({ length: 6 }, () => 600_000), ...Array.from({ length: 13 }, () => 300_000)], critical, {}, step)).toMatchObject([{ severity: "warning" }]);
  });

  it("clears the alert when the process ends, and names a process with a parent and no record", () => {
    const critical = [{ id: "runaway:handles:27056", severity: "critical" as const }];
    expect(handleAlerts([600_000, 600_000], critical, { processes: [] })).toEqual([]);
    const child = { ...find, ppid: 1 };
    const [alert] = handleAlerts([200_000, 200_000], [], { processes: [p(1, 0, "bash.exe", 10), child], recordOf: () => undefined });
    expect(alert?.message).toBe("find.exe (pid 27056) holds 200,000 handles. It started 44 min ago. Owner: session:server-stack tools (orphan). The owner stops it by its pid.");
  });
});

describe("HandleTracker (H48)", () => {
  it("keeps the processes at or above the floor for 7 minutes, and gives the trails of the processes above an amount", () => {
    const tracker = new HandleTracker();
    const old = p(10, 1, "find.exe", 30_000, T0 - 60 * MIN);
    tracker.read(T0 - 8 * MIN, [{ ...old, handles: 25_000 }]);
    tracker.read(T0 - 2 * MIN, [{ ...old, handles: 500 }, p(11, 1, "small.exe", 900)]);
    const late = p(12, 1, "late.exe", 40_000, T0 - MIN);
    tracker.read(T0, [old, p(11, 1, "small.exe", 900), late]);
    const trails = tracker.trails([old, p(11, 1, "small.exe", 900), late], 20_000);
    // The read of 8 minutes ago is out of the window. A count under the floor gives the floor, and a read before the start gives 0.
    expect(trails).toEqual([
      { pid: 10, trail: [{ at: T0 - 2 * MIN, value: HANDLES_FLOOR }, { at: T0, value: 30_000 }] },
      { pid: 12, trail: [{ at: T0 - 2 * MIN, value: 0 }, { at: T0, value: 40_000 }] },
    ]);
    expect(tracker.trails([old], 50_000)).toEqual([]);
  });
});

describe("the handles of the computer (H48)", () => {
  const processes = [p(4, 0, "System", 12_558), p(30, 999, "explorer.exe", 7466), p(31, 4, "dwm.exe", 3091), p(32, 4, "chrome.exe", 2972), p(33, 4, "bash.exe")];

  it("gives the sum in Status and the resource handles, with the owners", () => {
    const status = handleStatus(processes, new Map([[30, "system"]]), () => undefined, DEFAULT_ALERT_RULES.handlesWarn);
    expect(status).toMatchObject({ total: 26_087, warning: 100_000 });
    expect(status?.top.map((each) => [each.name, each.handles, each.owner])).toEqual([
      ["System", 12_558, "other"],
      ["explorer.exe", 7466, "system (orphan, parent ended)"],
      ["dwm.exe", 3091, "other"],
    ]);
    expect(RESOURCES.get("handles")?.measure.read({ processes } as never)).toEqual([{ id: "handles", capacity: null, used: 26_087, free: null }]);
    expect(RESOURCES.get("handles")?.measure.read({ processes: [{ pid: 1, ppid: 0, name: "a", privateMb: 0, workingMb: 0 }] } as never)).toEqual([]);
    expect(handleStatus([{ pid: 1, ppid: 0, name: "a", privateMb: 0, workingMb: 0 }], new Map(), () => undefined, 1)).toBeNull();
  });

  it("names the top 3 processes in headroom status only when one is above the warning line", () => {
    const quiet = handleStatus(processes, new Map(), () => undefined, DEFAULT_ALERT_RULES.handlesWarn);
    expect(handlesLines(quiet)).toEqual(["Handles: 26,087 in all."]);
    const loud = handleStatus([...processes, find], new Map([[27056, "session:server-stack tools (orphan)"]]), (info) => (info.pid === 27056 ? record : undefined), DEFAULT_ALERT_RULES.handlesWarn);
    expect(handlesLines(loud)).toEqual([
      "Handles: 1,339,192 in all. Most handles:",
      "  find.exe (27056)          1,313,105  session:server-stack tools (orphan, parent ended)  find / -name WIRE-PROTOCOL.md -path *procedures*",
      "  System (4)                   12,558  other",
      "  explorer.exe (30)             7,466  other (orphan, parent ended)",
    ]);
    expect(handlesLines(undefined)).toEqual([]);
  });
});
