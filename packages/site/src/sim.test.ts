import { describe, expect, it } from "vitest";
import { BURST, KINDS, machineOf, START } from "./catalog.ts";
import { memoryAt, Simulation } from "./sim.ts";

const laptop = machineOf("laptop");

function started(): Simulation {
  const sim = new Simulation(laptop);
  for (const [kind, holder] of START) sim.add(kind, holder);
  return sim;
}

describe("the start scenario", () => {
  it("grants the test suite and the browser test, and queues the other two", () => {
    const view = started().view();
    expect(view.running.map((row) => row.job)).toEqual(["pnpm test", "pnpm e2e"]);
    expect(view.waiting.map((row) => row.job)).toEqual(["vitest --pool forks", "pnpm build"]);
  });

  it("gives the reasons of the broker for each wait", () => {
    const [churn, build] = started().view().waiting;
    expect(churn?.heavy).toBe(true);
    expect(churn?.reason).toMatch(/^waits for the browser tests of web \(pnpm e2e\) to end: .*browsers can fail to start beside it$/);
    expect(build?.reason).toBe("waits for cpu: needs 6, 4 free");
  });

  it("keeps 2 cores out of the leases", () => {
    const sim = started();
    expect(sim.free()["cpu"]).toBe(12 - 2 - 4 - 2);
  });
});

describe("the queue", () => {
  it("keeps the build in the queue beside a browser test while the sum of the start rates is above the limit", () => {
    const sim = started();
    sim.step(40);
    const view = sim.view();
    expect(view.ended.map((row) => row.job)).toContain("pnpm test");
    const build = view.waiting.find((row) => row.job === "pnpm build");
    expect(build?.reason).toMatch(/^waits for the browser tests of web \(pnpm e2e\) to end: this job .* above the limit of 600/);
  });

  it("starts the waiting jobs when the browser test ends", () => {
    const sim = started();
    sim.step(50);
    expect(sim.view().running.map((row) => row.job).sort()).toEqual(["pnpm build", "vitest --pool forks"]);
  });

  it("starts the spawn-heavy job only after the browser test ends", () => {
    const sim = started();
    sim.step(49);
    expect(sim.view().waiting.map((row) => row.job)).toContain("vitest --pool forks");
    sim.step(1);
    expect(sim.view().running.map((row) => row.job)).toContain("vitest --pool forks");
  });

  it("cancels a waiting lease", () => {
    const sim = started();
    const waiting = sim.view().waiting[1];
    sim.cancel(waiting?.id ?? "");
    const view = sim.view();
    expect(view.waiting).toHaveLength(1);
    expect(view.ended[0]?.outcome).toBe("cancelled");
  });

  it("lets the burst fill the queue", () => {
    const sim = new Simulation(laptop);
    for (const [kind, holder] of BURST) sim.add(kind, holder);
    expect(sim.view().waiting.length).toBeGreaterThan(0);
    sim.step(400);
    const view = sim.view();
    expect(view.waiting).toHaveLength(0);
    expect(view.running).toHaveLength(0);
    expect(view.ended).toHaveLength(BURST.length);
  });
});

describe("the memory limit", () => {
  it("stops a job that grows past its lease", () => {
    const sim = new Simulation(laptop, true);
    sim.add("leak");
    sim.step(15);
    const [row] = sim.view().ended;
    expect(row?.outcome).toBe("stopped");
    expect(row?.reason).toMatch(/memory limit stopped it/);
    expect(row?.peakMb).toBeLessThanOrEqual(1024);
  });

  it("without the limit, the leak takes the free memory until the system stops it", () => {
    const sim = new Simulation(laptop, false);
    sim.add("leak");
    sim.step(15);
    expect(sim.view().running).toHaveLength(1);
    sim.step(200);
    const [row] = sim.view().ended;
    expect(row?.reason).toMatch(/ran out of memory/);
  });

  it("without the limit, a new job waits for the memory that the leak took", () => {
    const sim = new Simulation(laptop, false);
    sim.add("leak");
    sim.step(80);
    const lease = sim.add("build");
    expect(lease.state).toBe("waiting");
    expect(lease.reason).toMatch(/^waits for memory: needs 4096/);
  });
});

describe("the computers", () => {
  it("on a small laptop, a build waits for memory while a browser test runs", () => {
    const sim = new Simulation(machineOf("small"));
    sim.add("e2e");
    const lease = sim.add("build");
    expect(lease.reason).toMatch(/^waits for memory: needs 4096/);
  });

  it("gives the default computer for an unknown id", () => {
    expect(machineOf("none").id).toBe("laptop");
  });
});

describe("the memory of a job", () => {
  it("ramps up to the peak of its kind", () => {
    const test = KINDS[0];
    if (test === undefined) throw new Error("no kind");
    expect(memoryAt(test, 0)).toBe(0);
    expect(memoryAt(test, 20)).toBeLessThanOrEqual(test.peakMb);
    expect(memoryAt(test, 20)).toBeGreaterThan(test.peakMb * 0.85);
  });
});

describe("the steps of the site probe", () => {
  it("gives the states that check-probe.ts checks", () => {
    const sim = new Simulation(laptop);
    sim.add("leak");
    sim.step(10);
    expect(sim.view().ended[0]?.outcome).toBe("stopped");
    sim.add("e2e");
    expect(sim.view().running.map((row) => row.job)).toEqual(["pnpm e2e"]);
    sim.add("churn");
    expect(sim.view().waiting[0]?.reason).toMatch(/browsers can fail to start beside it$/);
    for (const [kind, holder] of BURST) sim.add(kind, holder);
    const waiting = sim.view().waiting;
    expect(waiting.length).toBeGreaterThanOrEqual(3);
    expect(waiting.every((row) => /^waits /.test(row.reason ?? ""))).toBe(true);
    sim.step(60);
    const view = sim.view();
    expect(view.ended.some((row) => row.outcome === "done")).toBe(true);
    expect(view.running.length).toBeGreaterThan(0);
  });
});
