import { describe, expect, it } from "vitest";
import type { WorktreePlan, WorktreeRecord } from "./worktree-cli.ts";
import { WorktreeSchedule, type WorktreeRun, type WorktreeScheduleOptions } from "./worktree-schedule.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 8, 12);
const VERSION = "0.2.4";

function counts(keep: number) {
  return { active: 0, removable: 0, keep, broken: 0, orphan: 0 };
}

function recordAt(at: number, keep = 0, remaining = 0): WorktreeRecord {
  return {
    at: new Date(at).toISOString(),
    roots: ["D:\\git"],
    counts: counts(keep),
    repos: [{ repo: "app", counts: counts(keep), nodeModulesBytes: null }],
    clean: { at: new Date(at).toISOString(), removed: 0, nodeModules: 0, pruned: 0, failed: 0, remaining, stopped: remaining > 0 ? "max" : null, freeBefore: {}, freeAfter: {} },
  };
}

function planAt(at: number, version = VERSION): WorktreePlan {
  return {
    at: new Date(at).toISOString(),
    roots: ["D:\\git"],
    counts: counts(0),
    repos: [],
    version,
    plan: { remove: 354, nodeModules: 83, prune: 0, skipped: 0 },
    actions: [],
    orphans: [],
  };
}

interface Setup {
  freeMb?: number;
  last?: WorktreeRecord | null;
  plan?: WorktreePlan | null;
  auto?: boolean;
  /** The trees that each real run leaves for the next batch. */
  batches?: number[];
}

function schedule(setup: Setup, overrides: Partial<WorktreeScheduleOptions> = {}) {
  const calls = { launched: [] as string[], notes: [] as string[], ended: [] as string[] };
  let clock = NOW;
  let record = setup.last === undefined ? recordAt(NOW - 2 * HOUR) : setup.last;
  let plan = setup.plan === undefined ? null : setup.plan;
  const state = { auto: setup.auto ?? false };
  const batches = [...(setup.batches ?? [])];
  const options: WorktreeScheduleOptions = {
    roots: () => ["D:\\git"],
    disks: () => [{ mount: "D:", freeMb: setup.freeMb ?? 100_000 }],
    autoClean: () => state.auto,
    version: VERSION,
    launch: async (run: WorktreeRun) => {
      calls.launched.push(`${run.mode}:${run.reason}`);
      if (run.mode === "plan") plan = planAt(clock);
      else record = recordAt(clock, 150, batches.shift() ?? 0);
      return 0;
    },
    record: () => record,
    plan: () => plan,
    note: (alert) => calls.notes.push(alert.id),
    endNote: (id) => calls.ended.push(id),
    log: () => undefined,
    now: () => clock,
    platform: "win32",
    ...overrides,
  };
  return { schedule: new WorktreeSchedule(options), calls, state, advance: (ms: number) => (clock += ms) };
}

const settle = (): Promise<void> => new Promise((done) => setImmediate(done));

describe("WorktreeSchedule", () => {
  it("starts with a dry run that writes the plan and gives a note, and removes nothing while the setting is off", async () => {
    const { schedule: plan, calls, advance } = schedule({ plan: planAt(NOW - HOUR) });
    expect(plan.tick()).toEqual({ mode: "plan", reason: "update" });
    await settle();
    expect(calls.notes).toContain("worktree:plan");
    advance(5 * 60_000);
    expect(plan.tick()).toBeNull();
    advance(23 * HOUR);
    expect(plan.tick()).toBeNull();
    advance(HOUR);
    expect(plan.tick()).toEqual({ mode: "plan", reason: "daily" });
    await settle();
    expect(calls.launched).toEqual(["plan:update", "plan:daily"]);
  });

  it("makes a new plan when the plan file is of a different version, also with the setting on", async () => {
    const { schedule: plan, calls } = schedule({ auto: true, plan: planAt(NOW - HOUR, "0.2.3") });
    expect(plan.tick()).toEqual({ mode: "plan", reason: "update" });
    await settle();
    expect(calls.launched).toEqual(["plan:update"]);
  });

  it("starts the real cleanup only after the plan and with the setting on, then runs the next batch at each check", async () => {
    const { schedule: plan, calls, state, advance } = schedule({ last: recordAt(NOW - 25 * HOUR), batches: [334, 314, 0] });
    expect(plan.tick()?.mode).toBe("plan");
    await settle();
    advance(5 * 60_000);
    expect(plan.tick()).toBeNull();
    state.auto = true;
    expect(plan.tick()).toEqual({ mode: "clean", reason: "daily" });
    await settle();
    expect(calls.ended).toContain("worktree:plan");
    advance(5 * 60_000);
    expect(plan.tick()).toEqual({ mode: "clean", reason: "batch" });
    await settle();
    advance(5 * 60_000);
    expect(plan.tick()).toEqual({ mode: "clean", reason: "batch" });
    await settle();
    advance(5 * 60_000);
    expect(plan.tick()).toBeNull();
    expect(calls.launched).toEqual(["plan:update", "clean:daily", "clean:batch", "clean:batch"]);
  });

  it("runs early when the drive of a root has less than 20 GB free, at most once an hour", async () => {
    const { schedule: plan, calls, advance } = schedule({ freeMb: 10 * 1024, auto: true });
    expect(plan.lowSpace()).toBe(true);
    expect(plan.tick()?.mode).toBe("plan");
    await settle();
    expect(plan.tick()).toEqual({ mode: "clean", reason: "low-space" });
    await settle();
    advance(30 * 60_000);
    expect(plan.tick()).toBeNull();
    advance(31 * 60_000);
    expect(plan.tick()).toEqual({ mode: "clean", reason: "low-space" });
    expect(calls.launched).toEqual(["plan:update", "clean:low-space", "clean:low-space"]);
  });

  it("alerts above 100 keep trees, and ends the alert at 100 or fewer", async () => {
    const { schedule: plan, calls } = schedule({ last: null, auto: true });
    expect(plan.tick()?.mode).toBe("plan");
    await settle();
    expect(plan.tick()).toEqual({ mode: "clean", reason: "daily" });
    await settle();
    expect(calls.notes).toContain("worktree:keep");
    const quiet = schedule({ last: recordAt(NOW - HOUR, 100) });
    expect(quiet.calls.ended).toEqual(["worktree:keep"]);
  });
});
