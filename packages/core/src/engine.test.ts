import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES } from "./alerts.ts";
import { Engine } from "./engine.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";
import type { PoolTag } from "./types.ts";

describe("Engine stop alerts", () => {
  it("flags clients of headroom run that stop without a release, for 15 minutes", () => {
    let now = 1_000_000;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    // Process IDs that do not exist: the broker ends each lease at once, as after a stop of its client.
    engine.request({ holder: "client", job: "vitest", amounts: {}, pid: 2_000_000_001 });
    expect(engine.alerts().active).toEqual([]);
    engine.request({ holder: "jarvis", job: "tsc", amounts: {}, pid: 2_000_000_003 });
    const [alert] = engine.alerts().active;
    expect(alert).toMatchObject({ id: "stop:clients", kind: "stop" });
    expect(alert?.message).toContain("2 clients of headroom run stopped without a release in 2 minutes (holders: client, jarvis)");
    now += 16 * 60_000;
    engine.tick();
    expect(engine.alerts().active).toEqual([]);
    expect(engine.alerts().ended[0]?.id).toBe("stop:clients");
    engine.close();
  });
});

describe("Engine pool tags", () => {
  it("names the pool tag that grows in the pool alert", () => {
    let now = 1_000_000;
    let tags: PoolTag[] = [
      { tag: "DAL3", nonPagedMb: 270, pagedMb: 0 },
      { tag: "File", nonPagedMb: 80, pagedMb: 0 },
    ];
    let nonPagedMb = 1000;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: nonPagedMb }),
      processes: () => [],
      poolTags: () => tags,
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere", alertRules: { ...DEFAULT_ALERT_RULES, poolMb: 1200 } });
    engine.tick();
    expect(engine.alerts().active).toEqual([]);

    now += 6 * 60_000;
    tags = [
      { tag: "DAL3", nonPagedMb: 570, pagedMb: 0 },
      { tag: "File", nonPagedMb: 82, pagedMb: 0 },
    ];
    nonPagedMb = 1300;
    engine.tick();
    expect(engine.poolTags().growing.map((row) => [row.tag, row.growthMb])).toEqual([
      ["DAL3", 300],
      ["File", 2],
    ]);
    const [alert] = engine.alerts().active;
    expect(alert?.kind).toBe("pool");
    expect(alert?.message).toContain("The tags that grow: DAL3 +300 MB, File +2 MB.");
    engine.close();
  });
});
