import { Engine, NO_USAGE_FILE_WAIT, Store, type Sampler } from "@headroom/core";
import { describe, expect, it } from "vitest";
import { leaseRow, leaseUseText, problemLines, rolesFileLine, usageFileLine } from "./status-lines.ts";

const sampler: Sampler = {
  memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
  processes: () => [],
  close: () => undefined,
};

const engineOf = (): Engine => new Engine({ sampler, store: new Store(":memory:"), now: () => 1_000_000, sessionsDir: "/nowhere" });

describe("a job with usage<N and no usage file in `headroom status` (H57)", () => {
  it("shows the reason with the command in the row of the lease and in a Problem line", () => {
    const engine = engineOf();
    try {
      const job = engine.request({ holder: "shop", job: "pnpm bench", amounts: {}, ttlMs: 60_000, when: ["usage<80"] });
      expect(job.state).toBe("waiting");
      const leases = engine.status().leases;
      const row = leaseRow(leases.find((lease) => lease.id === job.id)!, "0 MB", null);
      expect(row).toContain("[when usage<80]");
      expect(row).toContain("(waits for the usage data: no usage file is set. Set it with: headroom config usage-file <path>)");
      expect(problemLines(leases)).toEqual(["Problem: pnpm bench waits for the usage data: no usage file is set. Set it with: headroom config usage-file <path>"]);
    } finally {
      engine.close();
    }
  });

  it("gives no Problem line for a job with another reason, and none for a job that runs", () => {
    const engine = engineOf();
    try {
      engine.request({ holder: "shop", job: "pnpm test", amounts: {}, ttlMs: 60_000 });
      const leases = engine.status().leases;
      expect(problemLines(leases)).toEqual([]);
      expect(problemLines(leases.map((lease) => ({ ...lease, state: "waiting" as const, reason: "waits for memory" })))).toEqual([]);
      expect(problemLines(leases.map((lease) => ({ ...lease, reason: NO_USAGE_FILE_WAIT })))).toEqual([]);
    } finally {
      engine.close();
    }
  });
});

describe("the lines of the settings with no default (H57)", () => {
  it("tells that a setting is not set, with its command", () => {
    expect(usageFileLine(null)).toBe("usage-file: not set. A job with the condition usage<N waits. Set it with: headroom config usage-file <path>");
    expect(rolesFileLine(null)).toBe("roles-file: not set. The roles are unknown. Set it with: headroom config roles-file <path>");
  });

  it("gives the path of a stored setting", () => {
    expect(usageFileLine("/nowhere/usage.json")).toContain("/nowhere/usage.json");
    expect(rolesFileLine("/nowhere/roles.json")).toContain("/nowhere/roles.json");
  });
});

describe("the memory use of a lease in `headroom status` (H62)", () => {
  const use = { id: "l1", holder: "shop", job: "share-stack", statedMb: 500, usedMb: 1200, peakMb: 3300, times: 6.6, over: true };

  it("gives the use, the peak and the over flag", () => {
    expect(leaseUseText(use)).toBe("uses 1.2 GB, peak 3.2 GB, over: 6.6 times its amount");
    expect(leaseUseText({ ...use, peakMb: 1300, times: 2.6, over: false })).toBe("uses 1.2 GB, peak 1.3 GB");
    expect(leaseUseText({ ...use, usedMb: null })).toBe("no measure now, peak 3.2 GB, over: 6.6 times its amount");
    expect(leaseUseText({ ...use, usedMb: null, peakMb: null, times: null, over: false })).toBeNull();
    // H62 part 2: the containers of a compose job count in its use.
    expect(leaseUseText({ ...use, containers: ["share-mongo-1"] })).toBe("uses 1.2 GB with 1 container, peak 3.2 GB, over: 6.6 times its amount");
    expect(leaseUseText({ ...use, containers: ["a", "b"] })).toBe("uses 1.2 GB with 2 containers, peak 3.2 GB, over: 6.6 times its amount");
    expect(leaseUseText(undefined)).toBeNull();
  });

  it("puts the use after the amounts in the row", () => {
    const engine = engineOf();
    try {
      const job = engine.request({ holder: "shop", job: "share-stack", amounts: { memory: 500 }, ttlMs: 60_000 });
      const row = leaseRow(job, "memory 500 MB", null, leaseUseText(use));
      expect(row).toContain("memory 500 MB  uses 1.2 GB, peak 3.2 GB, over: 6.6 times its amount");
      expect(leaseRow(job, "memory 500 MB", null)).not.toContain("uses");
    } finally {
      engine.close();
    }
  });
});
