import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES } from "./alerts.ts";
import type { Lease } from "./broker.ts";
import { isOver, leaseUse, overText, type LeaseUse } from "./lease-use.ts";
import { leaseUses } from "./resources.ts";
import { Engine } from "./engine.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";
import type { ProcessInfo } from "./types.ts";

const rules = { overFactor: 2, overMinMb: 1024 };

function lease(id: string, fields: Partial<Lease> = {}): Lease {
  return {
    id, holder: "shop", job: id, amounts: { memory: 500 }, priority: 0, pid: null, ttlMs: 0, state: "granted",
    requestedAt: 0, grantedAt: 0, endedAt: null, heartbeatAt: 0, reason: null, peakMb: null, ...fields,
  };
}

const p = (pid: number, ppid: number, name: string, privateMb: number): ProcessInfo => ({ pid, ppid, name, privateMb, workingMb: privateMb });

describe("isOver (H62)", () => {
  it("needs both the factor and the floor", () => {
    expect(isOver(500, 3072, rules)).toBe(true);
    // 2 times the amount, but only 600 MB above it: a small job stays off the list.
    expect(isOver(600, 1200, rules)).toBe(false);
    // 1024 MB above the amount, but under 2 times it.
    expect(isOver(4096, 5120, rules)).toBe(false);
    expect(isOver(1024, 2048, rules)).toBe(true);
    expect(isOver(500, null, rules)).toBe(false);
    expect(isOver(0, 1024, rules)).toBe(true);
    expect(isOver(0, 1023, rules)).toBe(false);
  });

  it("uses the defaults of the alert rules", () => {
    expect(DEFAULT_ALERT_RULES.overFactor).toBe(2);
    expect(DEFAULT_ALERT_RULES.overMinMb).toBe(1024);
  });
});

describe("leaseUse (H62)", () => {
  it("gives the peak, the times and the over flag of a granted lease", () => {
    expect(leaseUse(lease("share-stack"), 2900.4, 3050.6, rules)).toEqual({
      id: "share-stack", holder: "shop", job: "share-stack", statedMb: 500, usedMb: 2900, peakMb: 3051, times: 6.1, over: true,
    });
  });

  it("takes the use at this time as the peak when it is larger", () => {
    expect(leaseUse(lease("a"), 1800, 1200, rules)?.peakMb).toBe(1800);
    expect(leaseUse(lease("a"), 1800, null, rules)?.peakMb).toBe(1800);
    expect(leaseUse(lease("a"), null, 1200, rules)?.peakMb).toBe(1200);
    expect(leaseUse(lease("a"), null, null, rules)).toMatchObject({ usedMb: null, peakMb: null, times: null, over: false });
  });

  it("gives null for a waiting lease and a lease with no memory amount", () => {
    expect(leaseUse(lease("w", { state: "waiting" }), 5000, 5000, rules)).toBeNull();
    expect(leaseUse(lease("c", { amounts: { cpu: 2 } }), 5000, 5000, rules)).toBeNull();
  });

  it("gives no times for a stated memory of 0", () => {
    expect(leaseUse(lease("z", { amounts: { memory: 0 } }), 2000, 2000, rules)).toMatchObject({ times: null, over: true });
  });
});

describe("overText (H62)", () => {
  const use = (job: string, statedMb: number, peakMb: number): LeaseUse => ({
    id: job, holder: "shop", job, statedMb, usedMb: peakMb, peakMb, times: Math.round((peakMb / statedMb) * 10) / 10, over: isOver(statedMb, peakMb, rules),
  });

  it("names one lease", () => {
    expect(overText([use("share-stack", 500, 3072), use("small", 500, 600)])).toEqual({
      subject: "share-stack",
      mb: 2572,
      message:
        "A lease uses far more memory than it states. The lease share-stack of shop states 500 MB and used up to 3 GB, 6.1 times its amount. The free memory for new leases counts this use. Give the job a larger --mem, or --mem auto.",
    });
  });

  it("names the 3 largest excesses first, and counts the rest", () => {
    const text = overText([use("a", 500, 2000), use("b", 500, 5000), use("c", 1000, 3000), use("d", 500, 4000), use("e", 100, 1500)]);
    expect(text.subject).toBe("leases");
    expect(text.mb).toBe(1500 + 4500 + 2000 + 3500 + 1400);
    expect(text.message.startsWith("5 leases use far more memory than they state. The lease b of shop")).toBe(true);
    expect(text.message.indexOf("The lease b ")).toBeLessThan(text.message.indexOf("The lease d "));
    expect(text.message.indexOf("The lease d ")).toBeLessThan(text.message.indexOf("The lease c "));
    expect(text.message).not.toContain("The lease a ");
    expect(text.message).toContain(" 2 more leases are over.");
  });
});

describe("leaseUses (H62)", () => {
  it("measures the job tree and takes the peak of the broker", () => {
    const processes = [p(10, 1, "node.exe", 400), p(11, 10, "node.exe", 2700), p(20, 1, "node.exe", 100)];
    const uses = leaseUses(
      { leases: [lease("stack", { pid: 10 }), lease("small", { pid: 20, amounts: { memory: 2048 } })], processes, leasePeaks: new Map([["stack", 3500]]) },
      rules,
    );
    expect(uses.map((each) => [each.id, each.usedMb, each.peakMb, each.over])).toEqual([
      ["stack", 3100, 3500, true],
      ["small", 100, 100, false],
    ]);
  });

  it("gives no measure for a job tree with a container client (H187)", () => {
    const processes = [p(10, 1, "node.exe", 400), p(11, 10, "docker.exe", 50)];
    expect(leaseUses({ leases: [lease("stack", { pid: 10 })], processes }, rules)[0]).toMatchObject({ usedMb: null, peakMb: null, over: false });
  });
});

describe("Engine over finding (H62)", () => {
  it("gives the use and the peak of a lease in the status, and the over alert while the lease holds", () => {
    let now = 1_000_000;
    const job = process.pid;
    let list: ProcessInfo[] = [p(4, 0, "System", 1), p(job, 4, "node.exe", 300)];
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 12_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => list,
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    try {
      const stack = engine.request({ holder: "shop", job: "share-stack", amounts: { memory: 500 }, ttlMs: 600_000, pid: job });
      expect(stack.state).toBe("granted");
      engine.tick();
      expect(engine.status().leaseUse).toEqual([{ id: stack.id, holder: "shop", job: "share-stack", statedMb: 500, usedMb: 300, peakMb: 300, times: 0.6, over: false }]);
      expect(engine.status().alerts.map((alert) => alert.kind)).not.toContain("over");
      // The job grows to 3.3 GB, then falls to 1.2 GB: the peak stays.
      now += 10_000;
      list = [...list, p(job + 1, job, "mongod.exe", 3000)];
      engine.tick();
      now += 10_000;
      list = [p(4, 0, "System", 1), p(job, 4, "node.exe", 300), p(job + 1, job, "mongod.exe", 900)];
      engine.tick();
      const status = engine.status();
      expect(status.leaseUse?.[0]).toMatchObject({ usedMb: 1200, peakMb: 3300, times: 6.6, over: true });
      expect(status.alerts.find((alert) => alert.kind === "over")).toMatchObject({ id: "over", subject: "share-stack", mb: 2800 });
      // The end of the lease ends the alert.
      engine.release(stack.id, "the job ended with code 0");
      now += 10_000;
      engine.tick();
      expect(engine.status().leaseUse).toEqual([]);
      expect(engine.status().alerts.map((alert) => alert.kind)).not.toContain("over");
    } finally {
      engine.close();
    }
  });
});
