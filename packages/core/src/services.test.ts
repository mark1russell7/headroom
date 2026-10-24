import { describe, expect, it } from "vitest";
import { checkHealth, nextHealth, ServiceMonitor, type ServiceCheck, type ServiceProbe } from "./services.ts";

const ok = (latencyMs: number): ServiceProbe => ({ state: "ok", latencyMs, error: null });
const down = (error: string): ServiceProbe => ({ state: "down", latencyMs: null, error });

/** A fake check: it gives the next probe of its list at each run, and counts its runs. */
function fake(name: string, probes: (ServiceProbe | "hang")[], critical = true): ServiceCheck & { runs: number } {
  const check = {
    name, type: "docker" as const, title: `The service ${name}`, target: null, critical, runs: 0,
    run: (signal: AbortSignal): Promise<ServiceProbe> => {
      const probe = probes[Math.min(check.runs, probes.length - 1)] ?? ok(1);
      check.runs += 1;
      if (probe !== "hang") return Promise.resolve(probe);
      // A hung engine: no answer, and the abort of the monitor does not end it.
      void signal;
      return new Promise<ServiceProbe>(() => undefined);
    },
  };
  return check;
}

describe("nextHealth", () => {
  const check = fake("docker", []);
  it("counts the checks in a row with the same state, and keeps the start of the state", () => {
    const first = nextHealth(undefined, check, down("connect ENOENT"), 1000);
    expect(first).toMatchObject({ state: "down", checks: 1, since: 1000, okAt: null, error: "connect ENOENT", errorAt: 1000 });
    const second = nextHealth(first, check, down("No answer in 3 s"), 31_000);
    expect(second).toMatchObject({ state: "down", checks: 2, since: 1000, error: "No answer in 3 s", errorAt: 31_000 });
    const back = nextHealth(second, check, ok(12), 61_000);
    expect(back).toMatchObject({ state: "ok", checks: 1, since: 61_000, okAt: 61_000, latencyMs: 12, error: "No answer in 3 s", errorAt: 31_000 });
  });

  it("makes an answer above the limit slow", () => {
    expect(nextHealth(undefined, check, ok(1500), 0).state).toBe("slow");
    expect(nextHealth(undefined, check, ok(900), 0).state).toBe("ok");
    expect(nextHealth(undefined, check, ok(400), 0, 300).state).toBe("slow");
  });
});

describe("ServiceMonitor", () => {
  it("runs each check one time in each round, and drops a check that the list no longer has", async () => {
    let now = 0;
    const docker = fake("docker", [ok(5), down("connect ECONNREFUSED")]);
    const site = fake("fleet-site", [ok(3)], false);
    let checks: ServiceCheck[] = [docker, site];
    const monitor = new ServiceMonitor({ checks: () => checks, now: () => now });
    expect(monitor.list()).toEqual([]);
    await monitor.check();
    expect(monitor.list().map((each) => [each.name, each.state])).toEqual([["docker", "ok"], ["fleet-site", "ok"]]);
    now = 30_000;
    checks = [docker];
    await monitor.check();
    expect(monitor.list()).toMatchObject([{ name: "docker", state: "down", checks: 1, since: 30_000, okAt: 0, error: "connect ECONNREFUSED" }]);
    expect([docker.runs, site.runs]).toEqual([2, 1]);
  });

  it("gives down at the time limit, and does not start a check again before the last one ends", async () => {
    let now = 0;
    const docker = fake("docker", ["hang"]);
    const monitor = new ServiceMonitor({ checks: () => [docker], now: () => now, timeoutMs: 20 });
    await monitor.check();
    expect(monitor.list()).toMatchObject([{ state: "down", checks: 1, error: "No answer in 0.02 s" }]);
    now = 30_000;
    await monitor.check();
    expect(monitor.list()).toMatchObject([{ state: "down", checks: 2, since: 0, error: "The check of the last round has not ended" }]);
    expect(docker.runs).toBe(1);
  });

  it("gives down for a check that throws, and one round for two calls at the same time", async () => {
    const broken: ServiceCheck = {
      name: "broken", type: "url", title: "The service broken", target: "http://127.0.0.1:1/", critical: false,
      run: () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:1\nat TCPConnectWrap");
      },
    };
    const monitor = new ServiceMonitor({ checks: () => [broken] });
    const [first, second] = await Promise.all([monitor.check(), monitor.check()]);
    expect(first).toBe(second);
    expect(monitor.list()).toMatchObject([{ state: "down", checks: 1, error: "connect ECONNREFUSED 127.0.0.1:1" }]);
  });
});

describe("checkHealth", () => {
  it("gives each URL in its normal form, and refuses a bad name or a URL that is not http", () => {
    expect(checkHealth({ "fleet-site": "http://127.0.0.1:4731" })).toEqual({ "fleet-site": "http://127.0.0.1:4731/" });
    expect(() => checkHealth({ "mcp:vex": "http://127.0.0.1/" })).toThrow(/not valid/);
    expect(() => checkHealth({ site: "file:///C:/x" })).toThrow(/not http or https/);
    expect(() => checkHealth({ site: "not a url" })).toThrow(/not valid/);
  });
});
