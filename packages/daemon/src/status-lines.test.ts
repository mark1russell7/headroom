import { Engine, NO_USAGE_FILE_WAIT, Store, type Sampler } from "@headroom/core";
import { describe, expect, it } from "vitest";
import { leaseRow, problemLines, rolesFileLine, usageFileLine } from "./status-lines.ts";

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
