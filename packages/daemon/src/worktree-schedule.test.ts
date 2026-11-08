import { describe, expect, it } from "vitest";
import type { WorktreeRecord } from "./worktree-cli.ts";
import { WorktreeSchedule, type WorktreeScheduleOptions } from "./worktree-schedule.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 8, 12);

function recordAt(at: number, keep = 0): WorktreeRecord {
  return {
    at: new Date(at).toISOString(),
    roots: ["D:\\git"],
    counts: { active: 0, removable: 0, keep, broken: 0, orphan: 0 },
    repos: [{ repo: "app", counts: { active: 0, removable: 0, keep, broken: 0, orphan: 0 }, nodeModulesBytes: null }],
    clean: { at: new Date(at).toISOString(), removed: 0, nodeModules: 0, pruned: 0, failed: 0, freeBefore: {}, freeAfter: {} },
  };
}

function schedule(overrides: Partial<WorktreeScheduleOptions> & { freeMb?: number; last?: WorktreeRecord | null }) {
  const calls = { launched: [] as string[], notes: [] as string[], ended: [] as string[] };
  let clock = NOW;
  let record = overrides.last === undefined ? recordAt(NOW - 2 * HOUR) : overrides.last;
  const options: WorktreeScheduleOptions = {
    roots: () => ["D:\\git"],
    disks: () => [{ mount: "D:", freeMb: overrides.freeMb ?? 100_000 }],
    launch: async (reason) => {
      calls.launched.push(reason);
      record = recordAt(clock, 150);
      return 0;
    },
    record: () => record,
    note: (alert) => calls.notes.push(alert.id),
    endNote: (id) => calls.ended.push(id),
    log: () => undefined,
    now: () => clock,
    platform: "win32",
    ...overrides,
  };
  return { schedule: new WorktreeSchedule(options), calls, advance: (ms: number) => (clock += ms) };
}

describe("WorktreeSchedule", () => {
  it("runs once a day, and not again while a run is not due", async () => {
    const { schedule: plan, calls, advance } = schedule({});
    expect(plan.tick()).toBeNull();
    advance(22 * HOUR);
    expect(plan.tick()).toBe("daily");
    await Promise.resolve();
    advance(HOUR);
    expect(plan.tick()).toBeNull();
    expect(calls.launched).toEqual(["daily"]);
  });

  it("runs early when the drive of a root has less than 20 GB free, at most once an hour", async () => {
    const { schedule: plan, calls, advance } = schedule({ freeMb: 10 * 1024 });
    expect(plan.lowSpace()).toBe(true);
    expect(plan.tick()).toBe("low-space");
    await new Promise((done) => setImmediate(done));
    advance(30 * 60_000);
    expect(plan.tick()).toBeNull();
    advance(31 * 60_000);
    expect(plan.tick()).toBe("low-space");
    expect(calls.launched).toEqual(["low-space", "low-space"]);
  });

  it("runs at the first check with no record, and alerts above 100 keep trees", async () => {
    const { schedule: plan, calls } = schedule({ last: null });
    expect(calls.ended).toEqual([]);
    expect(plan.tick()).toBe("daily");
    await new Promise((done) => setImmediate(done));
    expect(calls.notes).toEqual(["worktree:keep"]);
  });

  it("ends the alert when a record has 100 keep trees or fewer", () => {
    const { calls } = schedule({ last: recordAt(NOW - HOUR, 100) });
    expect(calls.ended).toEqual(["worktree:keep"]);
  });
});
