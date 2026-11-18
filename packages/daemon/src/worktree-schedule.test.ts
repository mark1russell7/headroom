import { describe, expect, it } from "vitest";
import { worktreeRulesKey, type WorktreePlan, type WorktreeRecord } from "./worktree-cli.ts";
import { launchArgs, WORKTREE_PLAN_RETRY_MS, WorktreeSchedule, type WorktreeRun, type WorktreeScheduleOptions } from "./worktree-schedule.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 8, 12);
const VERSION = "0.2.4";
const KEY = "rules-a";

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

function planAt(at: number, key: string | undefined = KEY, version = VERSION): WorktreePlan {
  return {
    at: new Date(at).toISOString(),
    roots: ["D:\\git"],
    counts: counts(0),
    repos: [],
    version,
    key,
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
  /** False: a dry run writes no plan, as a run that the daemon stopped. */
  writes?: boolean;
}

function schedule(setup: Setup, overrides: Partial<WorktreeScheduleOptions> = {}) {
  const calls = { launched: [] as string[], notes: [] as string[], ended: [] as string[], log: [] as string[] };
  let clock = NOW;
  let record = setup.last === undefined ? recordAt(NOW - 2 * HOUR) : setup.last;
  let plan = setup.plan === undefined ? null : setup.plan;
  const state = { auto: setup.auto ?? false, key: KEY };
  const batches = [...(setup.batches ?? [])];
  const options: WorktreeScheduleOptions = {
    roots: () => ["D:\\git"],
    disks: () => [{ mount: "D:", freeMb: setup.freeMb ?? 100_000 }],
    autoClean: () => state.auto,
    key: () => state.key,
    launch: async (run: WorktreeRun) => {
      calls.launched.push(`${run.mode}:${run.reason}`);
      if (run.mode === "plan" && setup.writes !== false) plan = planAt(clock, state.key);
      else if (run.mode === "clean") record = recordAt(clock, 150, batches.shift() ?? 0);
      return 0;
    },
    record: () => record,
    plan: () => plan,
    note: (alert) => calls.notes.push(alert.id),
    endNote: (id) => calls.ended.push(id),
    log: (line) => calls.log.push(line),
    now: () => clock,
    platform: "win32",
    ...overrides,
  };
  return { schedule: new WorktreeSchedule(options), calls, state, advance: (ms: number) => (clock += ms), plan: () => plan };
}

const settle = (): Promise<void> => new Promise((done) => setImmediate(done));

describe("WorktreeSchedule", () => {
  it("starts with a dry run when the file has no plan, gives a note, and removes nothing while the setting is off", async () => {
    const { schedule: plan, calls, advance } = schedule({});
    expect(plan.tick()).toEqual({ mode: "plan", reason: "no-plan" });
    await settle();
    expect(calls.notes).toContain("worktree:plan");
    expect(calls.log.at(-1)).toContain("remove 354");
    advance(5 * 60_000);
    expect(plan.tick()).toBeNull();
    advance(23 * HOUR);
    expect(plan.tick()).toBeNull();
    advance(HOUR);
    expect(plan.tick()).toEqual({ mode: "plan", reason: "daily" });
    await settle();
    expect(calls.launched).toEqual(["plan:no-plan", "plan:daily"]);
  });

  it("starts no dry run at a restart when the plan in the file has the key, also when a different version wrote it (H198)", async () => {
    // The first daemon writes the plan. The second daemon is a restart of a new version with the same rules.
    const first = schedule({});
    first.schedule.tick();
    await settle();
    const restart = schedule({ plan: { ...(first.plan() as WorktreePlan), version: "0.2.5" } });
    expect(restart.schedule.tick()).toBeNull();
    restart.advance(23 * HOUR);
    expect(restart.schedule.tick()).toBeNull();
    // The daily run counts from the time of the plan in the file, not from the start of the daemon.
    restart.advance(HOUR);
    expect(restart.schedule.tick()).toEqual({ mode: "plan", reason: "daily" });
    expect(first.calls.launched).toEqual(["plan:no-plan"]);
    expect(restart.calls.launched).toEqual(["plan:daily"]);
  });

  it("starts one dry run when a rule or a setting changes, also with the setting on, and then cleans (H198)", async () => {
    const { schedule: plan, calls, state, advance } = schedule({ auto: true, last: recordAt(NOW - 25 * HOUR), plan: planAt(NOW - HOUR) });
    state.key = "rules-b";
    expect(plan.tick()).toEqual({ mode: "plan", reason: "new-rules" });
    await settle();
    advance(5 * 60_000);
    expect(plan.tick()).toEqual({ mode: "clean", reason: "daily" });
    await settle();
    expect(calls.launched).toEqual(["plan:new-rules", "clean:daily"]);
  });

  it("gives a plan from before H198, with no key, one new dry run", async () => {
    const { schedule: plan } = schedule({ plan: { ...planAt(NOW - HOUR), key: undefined } });
    expect(plan.tick()).toEqual({ mode: "plan", reason: "new-rules" });
  });

  it("starts a dry run that wrote no plan again only after an hour, and does not log the numbers of the old plan", async () => {
    const { schedule: plan, calls, advance } = schedule({ plan: planAt(NOW - 3 * HOUR, "rules-old"), writes: false });
    expect(plan.tick()).toEqual({ mode: "plan", reason: "new-rules" });
    await settle();
    const end = calls.log.at(-1) ?? "";
    expect(end).toContain("wrote no new plan");
    expect(end).toContain(new Date(NOW - 3 * HOUR).toISOString());
    expect(end).not.toContain("remove 354");
    expect(calls.notes).not.toContain("worktree:plan");
    advance(WORKTREE_PLAN_RETRY_MS - 60_000);
    expect(plan.tick()).toBeNull();
    advance(60_000);
    expect(plan.tick()).toEqual({ mode: "plan", reason: "new-rules" });
  });

  it("logs a new plan with a key that is not the key of the daemon, gives no note, and waits an hour", async () => {
    // The dry run writes the key rules-a, but the daemon has the key rules-x: for example, the roots of the two differ.
    const { schedule: plan, calls, advance } = schedule({}, { key: () => "rules-x" });
    expect(plan.tick()).toEqual({ mode: "plan", reason: "no-plan" });
    await settle();
    expect(calls.log.at(-1)).toContain("its key rules-a is not the key rules-x of the daemon");
    expect(calls.notes).not.toContain("worktree:plan");
    advance(5 * 60_000);
    expect(plan.tick()).toBeNull();
    advance(WORKTREE_PLAN_RETRY_MS);
    expect(plan.tick()).toEqual({ mode: "plan", reason: "new-rules" });
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
    expect(calls.launched).toEqual(["plan:no-plan", "clean:daily", "clean:batch", "clean:batch"]);
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
    expect(calls.launched).toEqual(["plan:no-plan", "clean:low-space", "clean:low-space"]);
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

describe("launchArgs", () => {
  it("gives the git gap to each run, and --dry-run to a plan", () => {
    expect(launchArgs("cli.ts", { mode: "plan", reason: "no-plan" })).toEqual(["cli.ts", "worktree", "clean", "--git-gap", "500ms", "--dry-run"]);
    expect(launchArgs("cli.ts", { mode: "clean", reason: "daily" }, 250)).toEqual(["cli.ts", "worktree", "clean", "--git-gap", "250ms"]);
  });
});

describe("worktreeRulesKey", () => {
  const settings = { roots: ["D:\\git"], idleMs: 24 * HOUR };

  it("gives the same key for the same rules and settings, and a new key for a change of a rule, a root or the idle time", () => {
    const rules = "export function classifyWorktree() { return 'keep'; }";
    const key = worktreeRulesKey(settings, rules);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(worktreeRulesKey({ roots: ["D:/git/"], idleMs: 24 * HOUR }, rules)).toBe(key);
    expect(worktreeRulesKey(settings, `${rules} `)).not.toBe(key);
    expect(worktreeRulesKey({ ...settings, roots: ["E:\\git"] }, rules)).not.toBe(key);
    expect(worktreeRulesKey({ ...settings, idleMs: 12 * HOUR }, rules)).not.toBe(key);
  });

  it("reads the rules from the core module when no text is given", () => {
    expect(worktreeRulesKey(settings)).toBe(worktreeRulesKey(settings));
    expect(worktreeRulesKey(settings)).not.toBe(worktreeRulesKey(settings, ""));
  });
});
