import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, detect, type AlertInput } from "./alerts.ts";
import {
  fitTrend,
  forecast,
  forecastFrom,
  forecastLine,
  forecastText,
  rateText,
  spanText,
  type Forecast,
  type ForecastTarget,
  type ResourcePoint,
} from "./forecast.ts";
import { batteryForecast, forecastsOf, forecastTargets, measure, withKinds, type Measurement } from "./resources.ts";
import type { BatteryState } from "./power.ts";
import type { OwnerKind, ProcessInfo } from "./types.ts";

const MINUTE = 60_000;
const T0 = 1_800_000_000_000;

/** This function gives one point each minute for `count` minutes. `free` gives the free part of minute `i`. */
function line(count: number, free: (i: number) => number, start = T0): ResourcePoint[] {
  return Array.from({ length: count }, (_, i) => [start + i * MINUTE, 100_000 - free(i), free(i)] as const);
}

/** A fixed noise from -1 to 1, so the tests give the same result each time. */
function noise(i: number): number {
  const x = Math.sin(i * 12.9898) * 43_758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

const critical: ForecastTarget = { on: "free", amount: 5120, name: "critical" };

describe("fitTrend and forecast", () => {
  it("fits a steady line, and gives the time to the target from the last point", () => {
    // 100 MB less each minute: 6000 MB an hour, from 30000 MB.
    const points = line(41, (i) => 30_000 - 100 * i);
    const trend = fitTrend(points, "free");
    expect(trend).toMatchObject({ on: "free", confidence: 1, value: 26_000, points: 41, spanMs: 40 * MINUTE });
    expect(trend?.rate).toBeCloseTo(-6000, 6);
    const result = forecast(points, critical);
    // (26000 - 5120) / 100 = 208.8 minutes after the last point.
    expect(result).toMatchObject({ minutes: 209, target: critical, rate: -6000, confidence: 1, source: "fit" });
    expect(result?.at).toBe(T0 + 40 * MINUTE + 208.8 * MINUTE);
    // A later time and a measured value at that time move the start.
    expect(forecast(points, critical, { now: T0 + 50 * MINUTE })?.minutes).toBe(199);
    const fitted = trend === null ? null : forecastFrom(trend, critical, T0 + 41 * MINUTE, 25_000);
    expect(fitted?.minutes).toBe(199);
  });

  it("keeps the slope of a line with one large outlier", () => {
    const points = line(41, (i) => (i === 30 ? 2000 : 30_000 - 100 * i));
    expect(fitTrend(points, "free")?.rate).toBeCloseTo(-6000, 0);
  });

  it("fits a noisy line with a clear trend, with a confidence below 1", () => {
    const points = line(60, (i) => 30_000 - 100 * i + 400 * noise(i));
    const trend = fitTrend(points, "free");
    expect(trend).not.toBeNull();
    expect(trend?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(trend?.confidence).toBeLessThan(1);
    expect(trend?.rate).toBeLessThan(-4000);
    expect(trend?.rate).toBeGreaterThan(-8000);
  });

  it("gives no trend for a line with more noise than trend", () => {
    const points = line(60, (i) => 30_000 - 10 * i + 2000 * noise(i));
    expect(fitTrend(points, "free")).toBeNull();
    expect(forecast(points, critical)).toBeNull();
  });

  it("gives no trend for a flat line", () => {
    expect(fitTrend(line(60, () => 30_000), "free")).toBeNull();
    expect(fitTrend(line(60, () => 30_000), "used")).toBeNull();
  });

  it("gives no forecast when the trend moves away from the target", () => {
    const rising = line(41, (i) => 30_000 + 100 * i);
    expect(fitTrend(rising, "free")?.rate).toBeCloseTo(6000, 6);
    expect(forecast(rising, critical)).toBeNull();
    // The used part falls, so a target of the used part is also out of reach.
    expect(forecast(rising, { on: "used", amount: 90_000, name: "warning" })).toBeNull();
  });

  it("gives no forecast at or past the target, or more than 30 days away", () => {
    expect(forecast(line(41, (i) => 5000 - 10 * i), critical)).toBeNull();
    // 1 MB less each hour: 5120 MB free in more than 30 days.
    expect(forecast(line(41, (i) => 30_000 - i / 60), critical)).toBeNull();
  });

  it("does not fit across a gap, and starts after the time of a wake", () => {
    // A steep fall, a gap of 20 minutes, then 40 minutes of a slow fall.
    const before = line(30, (i) => 60_000 - 500 * i);
    const after = line(41, (i) => 40_000 - 10 * i, T0 + 50 * MINUTE);
    const trend = fitTrend([...before, ...after], "free");
    expect(trend?.rate).toBeCloseTo(-600, 6);
    expect(trend?.points).toBe(41);
    // 20 minutes after the gap is too short a span.
    expect(fitTrend([...before, ...after.slice(0, 21)], "free")).toBeNull();
    // A wake at minute 70 leaves 20 minutes of points.
    expect(fitTrend([...before, ...after], "free", { since: T0 + 70 * MINUTE })).toBeNull();
  });

  it("gives no trend for a single step, or with too few points", () => {
    expect(fitTrend(line(60, (i) => (i < 30 ? 30_000 : 20_000)), "free")).toBeNull();
    expect(fitTrend(line(41, (i) => 30_000 - 100 * i).filter((_, i) => i % 5 === 0), "free")).toBeNull();
  });

  it("uses only the window of the last 60 minutes", () => {
    const old = line(60, (i) => 90_000 - 1000 * i);
    const recent = line(60, (i) => 30_000 - 100 * i, T0 + 60 * MINUTE);
    expect(fitTrend([...old, ...recent], "free")?.rate).toBeCloseTo(-6000, 6);
  });
});

const disk = (free: number, total = 974_848): Measurement => ({ id: "disk:C:", capacity: total, used: total - free, free });

describe("forecastTargets", () => {
  it("gives the limits of the level rules of each kind, and an empty drive", () => {
    expect(forecastTargets(disk(100_000), DEFAULT_ALERT_RULES)).toEqual([
      { on: "free", amount: 20_480, name: "warning" },
      { on: "free", amount: 5120, name: "critical" },
      { on: "free", amount: 0, name: "empty" },
    ]);
    // On a drive of 50 GB, the limits are 20% and 5% of its size.
    expect(forecastTargets(disk(30_000, 51_200), DEFAULT_ALERT_RULES).map((each) => each.amount)).toEqual([10_240, 2560, 0]);
    const memory = { totalMb: 28_000, availableMb: 8000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 };
    const byId = new Map(
      measure({
        at: 0, memory, processes: [], previous: [], disks: [], load: { processes: 10, userObjects: null, gdiObjects: null }, processors: 16, pools: { browser: 1 }, granted: {},
        tcp: { dynamic: { first: 49_152, count: 16_384 }, connections: [] }, cores: [],
      }).map((each) => [each.id, forecastTargets(each, DEFAULT_ALERT_RULES)]),
    );
    expect(byId.get("pool:nonpaged")).toEqual([{ on: "used", amount: 3072, name: "warning" }]);
    expect(byId.get("pool:paged")).toEqual([{ on: "used", amount: 4096, name: "warning" }]);
    expect(byId.get("commit")).toEqual([{ on: "used", amount: 72_000, name: "warning" }]);
    expect(byId.get("memory")).toEqual([{ on: "free", amount: 1024, name: "warning" }]);
    expect(byId.get("ports:tcp")).toEqual([
      { on: "used", amount: 13_107.2, name: "warning" },
      { on: "used", amount: 15_564.8, name: "critical" },
    ]);
    // The processors, the desktop and the slots have no forecast.
    for (const id of ["cpu", "desktop", "browser"]) expect(byId.get(id)).toEqual([]);
  });
});

describe("forecastsOf", () => {
  it("gives the forecast to each target, the nearest first", () => {
    const trend = fitTrend(line(41, (i) => 30_000 - 100 * i), "free");
    const now = T0 + 40 * MINUTE;
    const list = forecastsOf(disk(26_000), (part) => (part === "free" ? trend : null), DEFAULT_ALERT_RULES, now);
    expect(list.map((each) => [each.target.name, each.minutes])).toEqual([
      ["warning", 55],
      ["critical", 209],
      ["empty", 260],
    ]);
    // Below the warning limit, the critical limit is the nearest target.
    expect(forecastsOf(disk(15_000), () => trend, DEFAULT_ALERT_RULES, now)[0]?.target.name).toBe("critical");
    expect(forecastsOf(disk(26_000), () => null, DEFAULT_ALERT_RULES, now)).toEqual([]);
  });

  it("passes the time left of Windows through for the battery, on battery only", () => {
    const state = (fields: Partial<BatteryState>): Measurement => ({
      id: "battery", capacity: 50, used: 20, free: 30, battery: { ac: false, charging: false, percent: 60, rateW: -15.2, minutesLeft: 110, ...fields },
    });
    expect(forecastsOf(state({}), () => null, DEFAULT_ALERT_RULES, T0)).toEqual([
      { minutes: 110, at: T0 + 110 * MINUTE, target: { on: "free", amount: 0, name: "empty" }, rate: -15.2, confidence: 1, source: "windows" },
    ]);
    expect(batteryForecast(state({ ac: true, minutesLeft: null }), T0)).toBeNull();
    expect(batteryForecast(state({ minutesLeft: null }), T0)).toBeNull();
    // The battery has no targets for a fit.
    expect(forecastTargets(state({}), DEFAULT_ALERT_RULES)).toEqual([]);
  });

  it("adds the nearest forecast to each instance of the status", () => {
    const soon: Forecast = { minutes: 55, at: T0, target: { on: "free", amount: 20_480, name: "warning" }, rate: -6000, confidence: 1, source: "fit" };
    const [entry] = withKinds([disk(26_000)], undefined, new Map([["disk:C:", [soon]]]));
    expect(entry?.forecast).toEqual(soon);
    expect(withKinds([disk(26_000)])[0]).not.toHaveProperty("forecast");
  });
});

describe("the text of a forecast", () => {
  const entry = (id: string, kind: "disk" | "pool" | "commit" | "battery" | "ports" | "memory", forecast: Forecast, capacity: number | null = null) =>
    ({ id, kind, unit: kind === "battery" ? ("Wh" as const) : kind === "ports" ? ("count" as const) : ("MB" as const), capacity, forecast });
  const f = (minutes: number, target: ForecastTarget, rate: number, source: "fit" | "windows" = "fit"): Forecast => ({ minutes, at: T0, target, rate, confidence: 0.82, source });

  it("gives the time and the rate for a person", () => {
    expect(spanText(45)).toBe("45 min");
    expect(spanText(190)).toBe("3 h 10 min");
    expect(spanText(9 * 1440 + 100)).toBe("9 days");
    expect(rateText(-4198, "MB")).toBe("4.1 GB an hour");
    expect(rateText(-38.4, "MB")).toBe("922 MB a day");
    expect(rateText(-1.5 * 1024 / 24, "MB")).toBe("1.5 GB a day");
    expect(rateText(150, "count")).toBe("150 an hour");
  });

  it("gives one sentence for each kind, and the line of the status under 24 hours", () => {
    const drive = entry("disk:C:", "disk", f(9 * 1440, { on: "free", amount: 0, name: "empty" }, -1.5 * 1024 / 24), 974_848);
    expect(forecastText(drive)).toBe("Drive C: full in 9 days (at 1.5 GB a day, confidence 0.82).");
    const pool = entry("pool:nonpaged", "pool", f(360, { on: "used", amount: 3072, name: "warning" }, 45));
    expect(forecastText(pool)).toBe("Non-paged pool: 3.0 GB (its alert level) in 6 h (at 1.1 GB a day, confidence 0.82).");
    const commit = entry("commit", "commit", f(25, { on: "used", amount: 72_000, name: "warning" }, 1200), 80_000);
    expect(forecastText(commit)).toBe("Commit charge: 90% of its limit in 25 min (at 1.2 GB an hour, confidence 0.82).");
    const battery = entry("battery", "battery", f(110, { on: "free", amount: 0, name: "empty" }, -15.2, "windows"));
    expect(forecastText(battery)).toBe("Battery: empty in 1 h 50 min (the estimate of Windows).");
    const ports = entry("ports:tcp", "ports", f(120, { on: "used", amount: 13_107.2, name: "warning" }, 150), 16_384);
    expect(forecastText(ports)).toBe("TCP ports: 80% in use in 2 h (at 150 an hour, confidence 0.82).");
    const memory = entry("memory", "memory", f(40, { on: "free", amount: 1024, name: "warning" }, -1300), 28_000);
    expect(forecastText(memory)).toBe("Memory: 1 GB available in 40 min (at 1.3 GB an hour, confidence 0.82).");
    expect(forecastLine([drive, pool, battery, commit])).toBe(
      "Forecast (24 h): Commit charge: 90% of its limit in 25 min, Battery: empty in 1 h 50 min, Non-paged pool: 3.0 GB (its alert level) in 6 h.",
    );
    expect(forecastLine([drive])).toBeNull();
  });
});

describe("the forecast alerts", () => {
  const p = (pid: number, privateMb: number): ProcessInfo => ({ pid, ppid: 0, name: "node.exe", privateMb, workingMb: privateMb });
  const memory = { totalMb: 28_000, availableMb: 8000, commitMb: 60_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 2500 };
  const owners: Record<number, [string, OwnerKind]> = { 1: ["session:graph", "session"], 2: ["docker", "docker"] };
  const input = (forecasts: Record<string, Forecast[]>, extra: Partial<AlertInput> = {}): AlertInput => ({
    memory,
    processes: [p(1, 6200), p(2, 4096)],
    ownerOf: new Map(Object.entries(owners).map(([pid, [owner]]) => [Number(pid), owner])),
    kindOf: new Map(Object.values(owners).map(([owner, kind]) => [owner, kind])),
    leases: [],
    disks: [{ mount: "C:", freeMb: 26_000, totalMb: 974_848 }],
    writes: [{ owner: "session:graph", kind: "session", mbLastHour: 3277, mbPerMin: 55 }],
    forecasts: new Map(Object.entries(forecasts)),
    ...extra,
  });
  const at = Date.UTC(2026, 9, 25, 6, 40);
  const fit = (minutes: number, target: ForecastTarget, rate: number): Forecast => ({ minutes, at, target, rate, confidence: 0.9, source: "fit" });
  const toCritical = (minutes: number): Forecast => fit(minutes, { on: "free", amount: 5120, name: "critical" }, -4198);
  const forecastAlerts = (alerts: ReturnType<typeof detect>) => alerts.filter((alert) => alert.kind === "forecast");

  it("warns when a drive reaches its critical level within 24 hours, with the rate and the top writers", () => {
    const warning: Forecast = fit(55, { on: "free", amount: 20_480, name: "warning" }, -4198);
    const [alert, ...rest] = forecastAlerts(detect(input({ "disk:C:": [warning, toCritical(190)] })));
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ id: "forecast:disk:C:", kind: "forecast", severity: "warning", subject: "drive C:", mb: 26_000 });
    expect(alert?.message).toBe(
      "Drive C: loses 4.1 GB an hour. At this rate, it has 5 GB free in 3 h 10 min, at 06:40 UTC. Most writes in the last hour: session:graph 3.2 GB. Run `headroom disk report` to see what uses the space.",
    );
    // The warning level alone does not alert, and a critical level after 24 hours does not alert.
    expect(forecastAlerts(detect(input({ "disk:C:": [warning] })))).toEqual([]);
    expect(forecastAlerts(detect(input({ "disk:C:": [toCritical(25 * 60)] })))).toEqual([]);
  });

  it("keeps an active alert up to 1.25 times its horizon", () => {
    const active = [{ id: "forecast:disk:C:", severity: "warning" as const }];
    expect(forecastAlerts(detect(input({ "disk:C:": [toCritical(29 * 60)] }, { active })))).toHaveLength(1);
    expect(forecastAlerts(detect(input({ "disk:C:": [toCritical(31 * 60)] }, { active })))).toEqual([]);
  });

  it("warns when a kernel pool reaches its alert level within 2 hours", () => {
    const pool = (minutes: number): Forecast => fit(minutes, { on: "used", amount: 3072, name: "warning" }, 300);
    const [alert] = forecastAlerts(detect(input({ "pool:nonpaged": [pool(100)] })));
    expect(alert).toMatchObject({ id: "forecast:pool:nonpaged", subject: "non-paged pool", mb: 2500 });
    expect(alert?.message).toBe("The non-paged kernel pool grows 300 MB an hour. At this rate, it reaches its alert level of 3.0 GB in 1 h 40 min, at 06:40 UTC. A driver can leak it.");
    expect(forecastAlerts(detect(input({ "pool:nonpaged": [pool(3 * 60)] })))).toEqual([]);
    const [paged] = forecastAlerts(detect(input({ "pool:paged": [fit(90, { on: "used", amount: 4096, name: "warning" }, 2000)] })));
    expect(paged?.id).toBe("forecast:pool:paged");
  });

  it("warns when the commit charge reaches 90% within 30 minutes, with the owners of the most private memory", () => {
    const commit = (minutes: number): Forecast => fit(minutes, { on: "used", amount: 72_000, name: "warning" }, 30_000);
    const [alert] = forecastAlerts(detect(input({ commit: [commit(24)] })));
    expect(alert).toMatchObject({ id: "forecast:commit", subject: "commit", mb: 60_000 });
    expect(alert?.message).toBe(
      "The commit charge grows 29.3 GB an hour. At this rate, it reaches 90% of its limit (70.3 GB) in 24 min, at 06:40 UTC. Most private memory: session:graph 6.1 GB, docker 4.0 GB. At the limit, new allocations fail.",
    );
    expect(forecastAlerts(detect(input({ commit: [commit(45)] })))).toEqual([]);
  });

  it("gives no forecast alert for the memory, or for a forecast with no fit", () => {
    const memoryForecast = fit(5, { on: "free", amount: 1024, name: "warning" }, -9000);
    const windows: Forecast = { ...toCritical(5), source: "windows" };
    expect(forecastAlerts(detect(input({ memory: [memoryForecast], "disk:C:": [windows] })))).toEqual([]);
  });
});
