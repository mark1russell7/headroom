import { describe, expect, it } from "vitest";
import type { Lease } from "./broker.ts";
import { isConditionWait, waitsForRoom } from "./conditions.ts";
import type { Forecast } from "./forecast.ts";
import {
  autoDrainEndedText,
  drainAlerts,
  drainLine,
  drainName,
  drainStatus,
  drainWait,
  nextClock,
  parseDrain,
  poolsPoints,
  REBOOT_KEYS,
  rebootAdvice,
  rebootBudget,
  rebootLines,
  windowsReboot,
  type AutoDrainBudget,
  type Drain,
  type KeyState,
  type PoolBudget,
} from "./reboot.ts";

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);
const NOW = Date.UTC(2026, 9, 25, 1, 40);

function forecastIn(minutes: number, amount: number): Forecast {
  return { minutes, at: NOW + minutes * 60_000, target: { on: "used", amount, name: "warning" }, rate: 300, confidence: 0.9, source: "fit" };
}

function pools(nonpaged: Partial<PoolBudget> = {}, paged: Partial<PoolBudget> = {}): PoolBudget[] {
  return [
    { id: "pool:nonpaged", usedMb: 1500, alertMb: 3072, growthMbPerHour: 40, growthLimitMb: 500, forecast: null, ...nonpaged },
    { id: "pool:paged", usedMb: 1200, alertMb: 4096, growthMbPerHour: 5, growthLimitMb: 500, forecast: null, ...paged },
  ];
}

const NO_UPDATE = { pending: false, sources: [] };
const UPDATE = { pending: true, sources: ["Windows Update"] };

describe("rebootAdvice (H34)", () => {
  it("tells to reboot within the hours of a near forecast, at the time of the forecast", () => {
    const advice = rebootAdvice(pools({ forecast: forecastIn(6 * 60 + 20, 3072) }), NO_UPDATE, { clock });
    expect(advice).toEqual({ level: "soon", by: NOW + 380 * 60_000, text: "Reboot within 6 hours: the non-paged pool reaches its alert level at 08:00." });
    expect(rebootAdvice(pools({ forecast: forecastIn(50, 3072) }), NO_UPDATE, { clock }).text).toBe("Reboot within 50 minutes: the non-paged pool reaches its alert level at 02:30.");
  });

  it("names the nearest pool when both pools have a forecast", () => {
    const advice = rebootAdvice(pools({ forecast: forecastIn(600, 3072) }, { forecast: forecastIn(180, 4096) }), NO_UPDATE, { clock });
    expect(advice.text).toBe("Reboot within 3 hours: the paged pool reaches its alert level at 04:40.");
  });

  it("gives no reboot for a far forecast, and names the time", () => {
    const advice = rebootAdvice(pools({ forecast: forecastIn(3 * 24 * 60, 3072) }), NO_UPDATE, { clock });
    expect(advice).toEqual({ level: "none", by: null, text: "No reboot needed. The non-paged pool reaches its alert level in 3 days." });
  });

  it("gives no reboot with no forecast and no update", () => {
    expect(rebootAdvice(pools(), NO_UPDATE, { clock })).toEqual({ level: "none", by: null, text: "No reboot needed." });
    expect(rebootAdvice(pools(), null, { clock }).text).toBe("No reboot needed.");
  });

  it("tells about a pending update alone, and adds it to a pool reason", () => {
    expect(rebootAdvice(pools(), UPDATE, { clock })).toEqual({ level: "update", by: null, text: "Reboot when it suits you: a Windows update waits for a reboot." });
    expect(rebootAdvice(pools({ forecast: forecastIn(6 * 60, 3072) }), UPDATE, { clock }).text).toBe(
      "Reboot within 6 hours: the non-paged pool reaches its alert level at 07:40. A Windows update waits for a reboot too.",
    );
  });

  it("tells to reboot soon for a pool above its alert level, before each forecast", () => {
    const one = rebootAdvice(pools({ usedMb: 4710, forecast: forecastIn(30, 3072) }), NO_UPDATE, { clock });
    expect(one).toEqual({ level: "overdue", by: null, text: "Reboot soon: the non-paged pool is at 4.6 GB, above its alert level of 3.0 GB." });
    const two = rebootAdvice(pools({ usedMb: 4710 }, { usedMb: 4300 }), UPDATE, { clock });
    expect(two.text).toBe("Reboot soon: the non-paged pool (4.6 GB) and the paged pool (4.2 GB) are above their alert levels. A Windows update waits for a reboot too.");
  });

  it("tells to plan a reboot for a fast growth with no forecast", () => {
    expect(rebootAdvice(pools({ growthMbPerHour: 620 }), NO_UPDATE, { clock })).toEqual({ level: "plan", by: null, text: "Plan a reboot: the non-paged pool grows 620 MB an hour." });
  });

  it("counts the level of the automatic drain as one more limit", () => {
    const auto = { levelMb: 6144, poolsMb: 5000, forecast: forecastIn(120, 6144) };
    // The forecast to the automatic level comes before the forecast of a pool.
    const soon = rebootAdvice(pools({ forecast: forecastIn(300, 3072) }), NO_UPDATE, { clock, auto });
    expect(soon).toEqual({ level: "soon", by: NOW + 120 * 60_000, text: "Reboot within 2 hours: the kernel pools reach the level of the automatic drain (6.0 GB) at 03:40." });
    expect(rebootAdvice(pools({ forecast: forecastIn(60, 3072) }), NO_UPDATE, { clock, auto }).text).toBe("Reboot within 60 minutes: the non-paged pool reaches its alert level at 02:40.");
    const far = rebootAdvice(pools(), NO_UPDATE, { clock, auto: { ...auto, forecast: forecastIn(3 * 24 * 60, 6144) } });
    expect(far.text).toBe("No reboot needed. The kernel pools reach the level of the automatic drain (6.0 GB) in 3 days.");
    // The pools at or above the level give overdue, alone or after a pool above its alert level.
    const over = { levelMb: 6144, poolsMb: 6300, forecast: null };
    expect(rebootAdvice(pools(), NO_UPDATE, { clock, auto: over })).toEqual({
      level: "overdue",
      by: null,
      text: "Reboot soon: the kernel pools are at 6.2 GB, at or above the level of the automatic drain (6.0 GB).",
    });
    expect(rebootAdvice(pools({ usedMb: 4710 }), UPDATE, { clock, auto: over }).text).toBe(
      "Reboot soon: the non-paged pool is at 4.6 GB, above its alert level of 3.0 GB. The kernel pools are at 6.2 GB, at or above the level of the automatic drain (6.0 GB). A Windows update waits for a reboot too.",
    );
    // With the rule off, the level is not a limit.
    expect(rebootAdvice(pools(), NO_UPDATE, { clock, auto: { ...over, levelMb: 0 } }).text).toBe("No reboot needed.");
  });

  it("adds the two pools at the same times", () => {
    expect(
      poolsPoints(
        [[1, 100, 5], [2, 110, 4], [3, null, 3]],
        [[1, 50, 9], [3, 60, 8]],
      ),
    ).toEqual([[1, 150, null]]);
  });
});

describe("windowsReboot (H34)", () => {
  it("reads the two keys with a fake probe, and counts a probe that throws as unknown", () => {
    const fake = (states: Record<string, KeyState>) => (path: string): KeyState => {
      const state = states[path];
      if (state === undefined) throw new Error("no access");
      return state;
    };
    const [update, servicing] = REBOOT_KEYS.map((key) => key.path) as [string, string];
    expect(windowsReboot(fake({ [update]: "absent", [servicing]: "absent" }))).toEqual({ pending: false, sources: [] });
    expect(windowsReboot(fake({ [update]: "present", [servicing]: "absent" }))).toEqual({ pending: true, sources: ["Windows Update"] });
    expect(windowsReboot(fake({ [servicing]: "present" }))).toEqual({ pending: true, sources: ["Component Based Servicing"] });
    expect(windowsReboot(fake({}))).toBeNull();
    expect(windowsReboot(() => "unknown")).toBeNull();
    expect(REBOOT_KEYS.map((key) => key.path)).toEqual([
      "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired",
      "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending",
    ]);
  });
});

function lease(id: string, state: Lease["state"], job: string, holder: string, duringDrain = false): Lease {
  return {
    id, holder, job, amounts: {}, priority: 0, pid: null, ttlMs: 60_000, state, requestedAt: NOW, grantedAt: null, endedAt: null, heartbeatAt: NOW, reason: null, peakMb: null,
    ...(duringDrain ? { conditions: { when: [], duringDrain: true } } : {}),
  };
}

describe("the drain (H34)", () => {
  const drain: Drain = { at: NOW + 50 * 60_000, until: NOW + 5 * 3_600_000, setAt: NOW, startedAt: null, readyAt: null };

  it("holds a lease from its time to its end, except a lease of --during-drain", () => {
    const plain = lease("a", "waiting", "pnpm test", "graph");
    expect(drainWait(plain, drain, NOW, clock)).toBeNull();
    const reason = drainWait(plain, drain, drain.at, clock);
    expect(reason).toBe("waits for the planned reboot at 02:30 (headroom drain)");
    expect(reason?.startsWith("waits for memory")).toBe(false);
    expect(isConditionWait(reason)).toBe(true);
    expect(waitsForRoom({ state: "waiting", reason })).toBe(false);
    expect(drainWait(lease("b", "waiting", "tsc", "vex", true), drain, drain.at, clock)).toBeNull();
    expect(drainWait(plain, drain, drain.until ?? 0, clock)).toBeNull();
    expect(drainWait(plain, null, drain.at, clock)).toBeNull();
  });

  it("gives the status line and the alerts of the drain", () => {
    const leases = [lease("a", "granted", "pnpm test", "graph"), lease("b", "granted", "vitest", "vex"), lease("c", "waiting", "tsc", "client"), lease("d", "waiting", "ok", "x", true)];
    expect(drainLine(drainStatus(drain, leases, NOW), clock)).toBe("Drain planned for the reboot at 02:30: from 02:30, new jobs wait. The drain ends at 06:40 if no reboot comes.");
    expect(drainAlerts(drainStatus(drain, leases, NOW), clock)).toEqual([]);
    const active = drainStatus(drain, leases, drain.at);
    expect(active).toMatchObject({ state: "active", waiting: 1, running: [{ id: "a", job: "pnpm test", holder: "graph" }, { id: "b", job: "vitest", holder: "vex" }] });
    expect(drainLine(active, clock)).toBe("Drain for the reboot at 02:30: 2 jobs still run. 1 job waits for the reboot. The drain ends at 06:40 if no reboot comes.");
    const alerts = drainAlerts(active, clock);
    expect(alerts.map((alert) => alert.id)).toEqual(["drain"]);
    expect(alerts[0]).toMatchObject({ kind: "drain", message: "The drain for the planned reboot at 02:30 started: new jobs wait. 2 jobs still run: pnpm test (graph), vitest (vex)." });
    const ready = drainStatus({ ...drain, until: null }, [], drain.at);
    expect(drainLine(ready, clock)).toBe("Drain for the reboot at 02:30: no job runs, ready for the reboot.");
    expect(drainAlerts(ready, clock).map((alert) => alert.message)).toEqual([
      "The drain for the planned reboot at 02:30 started: new jobs wait. No job runs.",
      "Ready for the reboot: no job runs. New jobs wait for the reboot at 02:30. headroom does not reboot the computer: Mark does it.",
    ]);
    expect(drainStatus(drain, leases, drain.until ?? 0)).toBeNull();
  });

  it("reads a drain from the settings, and refuses a bad value", () => {
    expect(parseDrain(JSON.stringify(drain))).toEqual(drain);
    expect(parseDrain(JSON.stringify({ at: 5, setAt: 1 }))).toEqual({ at: 5, until: null, setAt: 1, startedAt: null, readyAt: null });
    for (const bad of [undefined, null, "", "{", "null", JSON.stringify({ at: "x", setAt: 1 }), JSON.stringify({ at: 1 }), JSON.stringify({ at: 1, setAt: 1, until: "y" })]) {
      expect(parseDrain(bad)).toBeNull();
    }
  });

  it("gives the reason, the line, the alerts and the end of an automatic drain", () => {
    const auto: Drain = { at: NOW, until: null, setAt: NOW, startedAt: NOW, readyAt: null, auto: { levelMb: 6144, poolsMb: 6250 } };
    const plain = { ...lease("a", "waiting", "playwright test", "graph"), amounts: { browser: 1 } };
    const heavy = "and this job is heavy: it runs browser tests (headroom drain, automatic: heavy jobs wait)";
    expect(drainWait(plain, auto, NOW, clock, 6400)).toBe(`waits for a reboot: the kernel pools are at 6.3 GB, ${heavy}`);
    expect(drainWait(plain, auto, NOW, clock)).toBe(`waits for a reboot: the kernel pools are at 6.1 GB, ${heavy}`);
    // A light lease does not wait in an automatic drain, and the drain does not count it.
    const light = lease("c", "waiting", "pnpm lint", "graph");
    expect(drainWait(light, auto, NOW, clock)).toBeNull();
    expect(drainName(auto, clock)).toBe("the automatic drain of 01:40");
    expect(drainName({ ...auto, auto: null }, clock)).toBe("the drain for the reboot at 01:40");
    const status = drainStatus(auto, [lease("b", "granted", "vitest", "vex"), plain, light], NOW);
    expect(drainLine(status, clock)).toBe(
      "Automatic drain since 01:40 (automatic: heavy jobs wait, and light jobs start). The kernel pools were at 6.1 GB. 1 job still runs. " +
        "1 heavy job waits for a reboot. A reboot or `headroom drain --cancel` ends it. It also ends after 10 minutes with the pools under 5.7 GB.",
    );
    const alerts = drainAlerts(drainStatus(auto, [], NOW), clock);
    expect(alerts.map((alert) => [alert.id, alert.subject])).toEqual([["drain", "kernel pools"], ["drain:ready", "kernel pools"]]);
    expect(alerts[0]?.message).toBe(
      "The kernel pools reached 6.1 GB and stayed at or above 6.0 GB for 2 minutes. An automatic drain started at 01:40 (automatic: heavy jobs wait, and light jobs start). " +
        "A heavy job asks for 2 GB of memory or more, 4 cores or more, or the slot browser, or it is spawn-heavy. No job runs. " +
        "A reboot or `headroom drain --cancel` ends it. It also ends after 10 minutes with the pools under 5.7 GB.",
    );
    expect(alerts[1]?.message).toBe(
      "Ready for the reboot: no job runs. New heavy jobs wait for a reboot (automatic drain), and light jobs start. headroom does not reboot the computer: Mark does it.",
    );
    expect(autoDrainEndedText({ levelMb: 6144, poolsMb: 6250 })).toBe("The kernel pools stayed under 5.7 GB for 10 minutes, so the automatic drain ended. New jobs start again.");
    // The settings keep the facts of an automatic drain. A drain of an older version has none.
    expect(parseDrain(JSON.stringify(auto))).toEqual(auto);
    expect(parseDrain(JSON.stringify({ ...auto, auto: { levelMb: "x" } }))).toEqual({ ...auto, auto: undefined });
  });

  it("gives the next time of a local clock", () => {
    const after = new Date(2026, 9, 25, 1, 40).getTime();
    expect(nextClock("02:30", after)).toBe(new Date(2026, 9, 25, 2, 30).getTime());
    expect(nextClock("1:15", after)).toBe(new Date(2026, 9, 26, 1, 15).getTime());
    expect(nextClock("01:40", after)).toBe(new Date(2026, 9, 26, 1, 40).getTime());
    for (const bad of ["24:00", "2:3", "now", "02:60", "x2:30"]) expect(() => nextClock(bad, after)).toThrow(RangeError);
  });
});

describe("rebootBudget and rebootLines (H34)", () => {
  it("gives the uptime, the advice and the lines for a person", () => {
    const bootedAt = NOW - (3 * 24 * 60 + 70) * 60_000;
    const budget = rebootBudget({
      at: NOW,
      pools: pools({ usedMb: 4710, growthMbPerHour: 120 }, { growthMbPerHour: null, forecast: forecastIn(600, 4096) }),
      windows: UPDATE,
      bootedAt,
      drain: null,
      resumePlan: { path: "C:\\Users\\<you>\\.headroom\\resume-plan.md", at: NOW - 25 * 60_000 },
      clock,
    });
    expect(budget.uptimeMinutes).toBe(3 * 24 * 60 + 70);
    expect(budget.advice.level).toBe("overdue");
    const lines = rebootLines(budget, clock);
    expect(lines[0]).toBe("Reboot: Reboot soon: the non-paged pool is at 4.6 GB, above its alert level of 3.0 GB. A Windows update waits for a reboot too.");
    expect(lines[1]).toBe("Kernel pools: non-paged 4.6 GB (alert level 3.0 GB, +120 MB in the last hour), paged 1.2 GB (alert level 4.0 GB, at its alert level in 10 h).");
    expect(lines[2]).toBe("Windows: an update waits for a reboot (Windows Update).");
    expect(lines[3]).toMatch(/^Uptime: 3 days, since \d+ Oct \d\d:\d\d\.$/);
    expect(lines[4]).toBe("Drain: none. `headroom drain --at 02:30` plans one.");
    expect(lines[5]).toMatch(/^Resume plan: C:\\Users\\<you>\\\.headroom\\resume-plan\.md, written 25 min ago \(\d+ Oct \d\d:\d\d\)\. A drain writes it again at its start\.$/);
    const bare = rebootLines(rebootBudget({ at: NOW, pools: pools(), windows: null, bootedAt: null, drain: null, resumePlan: null, clock }), clock);
    expect(bare).toEqual([
      "Reboot: No reboot needed.",
      "Kernel pools: non-paged 1.5 GB (alert level 3.0 GB, +40 MB in the last hour), paged 1.2 GB (alert level 4.0 GB, +5 MB in the last hour).",
      "Windows: headroom cannot read the reboot state of Windows.",
      "Drain: none. `headroom drain --at 02:30` plans one.",
      "Resume plan: none yet. `headroom resume-plan` writes it, and a drain writes it at its start.",
    ]);
  });

  it("adds the level of the automatic drain and the time of its forecast", () => {
    const lines = (autoDrain: AutoDrainBudget): string[] =>
      rebootLines(rebootBudget({ at: NOW, pools: pools(), windows: null, bootedAt: null, drain: null, resumePlan: null, autoDrain, clock }), clock);
    const near = lines({ levelMb: 6144, poolsMb: 5300, forecast: forecastIn(190, 6144) });
    expect(near[0]).toBe("Reboot: Reboot within 3 hours: the kernel pools reach the level of the automatic drain (6.0 GB) at 04:50.");
    expect(near[2]).toMatch(/^Automatic drain: at 6\.0 GB of the kernel pools together, now 5\.2 GB\. The forecast reaches it at \d+ Oct 04:50, in 3 h 10 min\.$/);
    expect(lines({ levelMb: 6144, poolsMb: 5300, forecast: null })[2]).toBe("Automatic drain: at 6.0 GB of the kernel pools together, now 5.2 GB. No forecast: the pools show no clear trend.");
    expect(lines({ levelMb: 6144, poolsMb: 6300, forecast: null })[2]).toBe(
      "Automatic drain: at 6.0 GB of the kernel pools together, now 6.2 GB. After 2 minutes at or above the level, new jobs wait for a reboot.",
    );
    expect(lines({ levelMb: 0, poolsMb: 6300, forecast: null })[2]).toBe("Automatic drain: off. `headroom config auto-drain 6GB` turns it on.");
  });
});
