import { describe, expect, it } from "vitest";
import { machineOf, START } from "./catalog.ts";
import { Simulation } from "./sim.ts";
import { lanesOf, segmentsOf, timelineOf, windowOf } from "./timeline.ts";

describe("the timeline", () => {
  it("starts its window at 0 until the clock passes its length", () => {
    expect(windowOf(20)).toEqual({ start: 0, end: 180 });
    expect(windowOf(300)).toEqual({ start: 120, end: 300 });
  });

  it("gives a wait segment and a run segment to a lease that waited", () => {
    const sim = new Simulation(machineOf("laptop"));
    for (const [kind, holder] of START) sim.add(kind, holder);
    sim.step(60);
    const view = sim.view();
    const build = view.all.find((row) => row.job === "pnpm build");
    if (build === undefined) throw new Error("no build");
    const segments = segmentsOf(build, view.now, 0, 180);
    expect(segments.map((segment) => segment.kind)).toEqual(["wait", "run"]);
    expect(segments[0]?.left).toBe(0);
  });

  it("draws one lane for each lease and an axis", () => {
    const sim = new Simulation(machineOf("laptop"));
    for (const [kind, holder] of START) sim.add(kind, holder);
    const view = sim.view();
    expect(lanesOf(view)).toHaveLength(4);
    expect(timelineOf(view).match(/class="lane /g)).toHaveLength(5);
  });

  it("tells that it is empty with no lease", () => {
    expect(timelineOf(new Simulation(machineOf("laptop")).view())).toMatch(/class="empty"/);
  });
});
