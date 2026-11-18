import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES } from "./alerts.ts";
import type { Lease } from "./broker.ts";
import { normalPath, parseContainers, upMinMs, type DockerRead } from "./docker.ts";
import { Engine } from "./engine.ts";
import { leaseContainers, leaseMemoryMb, type LeasedContainer } from "./lease-containers.ts";
import { overText } from "./lease-use.ts";
import { jobTree, jobTreeMb } from "./owners.ts";
import { leaseUses } from "./resources.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";
import type { ProcessInfo } from "./types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const AT = 10_000_000;
const HOME = "C:\\Users\\Me";
const forms = (path: string): readonly string[] => [normalPath(path, HOME)];
const WIDE = [normalPath(HOME, HOME)];

function lease(id: string, fields: Partial<Lease> = {}): Lease {
  return {
    id, holder: "shop", job: id, amounts: { memory: 500 }, priority: 0, pid: null, ttlMs: 0, state: "granted",
    requestedAt: AT - 2 * MINUTE, grantedAt: AT - 2 * MINUTE, endedAt: null, heartbeatAt: 0, reason: null, peakMb: null, ...fields,
  };
}

const p = (pid: number, ppid: number, name: string, privateMb: number): ProcessInfo => ({ pid, ppid, name, privateMb, workingMb: privateMb });

const container = (id: string, fields: Partial<LeasedContainer> = {}): LeasedContainer => ({
  id, name: id, state: "running", workingDir: "D:\\work\\Shop\\deploy", memoryMb: 3000, upMinMs: MINUTE, ...fields,
});

// The lease 10 runs docker compose. The lease 20 has no container client. The lease 30 runs a second compose.
const PROCESSES = [
  p(10, 1, "node.exe", 400), p(11, 10, "docker.exe", 50),
  p(20, 1, "node.exe", 100),
  p(30, 1, "pwsh.exe", 80), p(31, 30, "docker-compose.exe", 40),
];
const SHOP = lease("shop", { pid: 10, folder: "D:\\work\\Shop" });

describe("upMinMs (H62)", () => {
  it("gives the least run time of each status text of the engine", () => {
    expect(upMinMs("Up Less than a second")).toBe(0);
    expect(upMinMs("Up 1 second")).toBe(1000);
    expect(upMinMs("Up 45 seconds")).toBe(45_000);
    expect(upMinMs("Up About a minute")).toBe(MINUTE);
    expect(upMinMs("Up 5 minutes (health: starting)")).toBe(5 * MINUTE);
    expect(upMinMs("Up About an hour")).toBe(HOUR);
    // The engine rounds hours, days, weeks and months to the nearest hour.
    expect(upMinMs("Up 2 hours")).toBe(2 * HOUR - 30 * MINUTE);
    expect(upMinMs("Up 3 days (healthy)")).toBe(72 * HOUR - 30 * MINUTE);
    expect(upMinMs("Up 2 weeks")).toBe(336 * HOUR - 30 * MINUTE);
    expect(upMinMs("Up 3 months")).toBe(2160 * HOUR - 30 * MINUTE);
    // The engine cuts years, so the count of years is the least time.
    expect(upMinMs("Up 2 years")).toBe(2 * 8760 * HOUR);
  });

  it("gives null for a container that does not run, and for a text that it does not know", () => {
    expect(upMinMs("Exited (0) 5 minutes ago")).toBeNull();
    expect(upMinMs("Created")).toBeNull();
    expect(upMinMs("Up forever")).toBeNull();
    expect(upMinMs("Up 5 minutesago")).toBeNull();
    expect(upMinMs(null)).toBeNull();
  });

  it("reads the label headroom.lease and the status text of the list, and adds no field when they are absent", () => {
    const listed = parseContainers([
      { Id: "a1", Names: ["/shop-mongo-1"], Image: "mongo:7", State: "running", Status: "Up 5 minutes", Labels: { "headroom.lease": "lease-1" } },
      { Id: "b2", Names: ["/plain"], Image: "x", State: "exited", Status: "Exited (0) 2 hours ago", Labels: { "headroom.lease": "" } },
    ]);
    expect(listed[0]).toMatchObject({ id: "a1", leaseLabel: "lease-1", upMinMs: 5 * MINUTE });
    expect(listed[1]).toEqual({ id: "b2", name: "plain", image: "x", state: "exited", project: null, workingDir: null });
  });
});

describe("jobTree (H62)", () => {
  it("gives the memory of the tree and the mark of a container client", () => {
    expect(jobTree(10, PROCESSES)).toEqual({ mb: 450, client: true });
    expect(jobTree(20, PROCESSES)).toEqual({ mb: 100, client: false });
    expect(jobTree(99, PROCESSES)).toBeNull();
    // jobTreeMb keeps its answer: no measure for a tree with a client (H187).
    expect(jobTreeMb(10, PROCESSES)).toBeNull();
    expect(jobTreeMb(20, PROCESSES)).toBe(100);
  });
});

describe("leaseContainers (H62)", () => {
  const of = (containers: readonly LeasedContainer[], leases: readonly Lease[] = [SHOP]) => leaseContainers(containers, leases, PROCESSES, AT, forms, WIDE);

  it("gives a container of a compose project in the folder of a lease that runs a container client", () => {
    const found = of([container("mongo"), container("api", { memoryMb: null, workingDir: "D:\\work\\Shop" })]);
    expect(found.leaseOf.get("mongo")).toEqual({ lease: "shop", from: "folder" });
    expect(found.leaseOf.get("api")).toEqual({ lease: "shop", from: "folder" });
    // A container with no memory read adds 0.
    expect(found.byLease.get("shop")).toEqual({ mb: 3000, names: ["mongo", "api"] });
  });

  it("needs the folder, the container client and a start after the grant", () => {
    // A folder that starts with the same letters is a different folder.
    expect(of([container("other", { workingDir: "D:\\work\\Shopping" })]).leaseOf.size).toBe(0);
    // The lease 20 has no container client.
    expect(of([container("mongo")], [lease("plain", { pid: 20, folder: "D:\\work\\Shop" })]).leaseOf.size).toBe(0);
    // The container runs for 10 minutes, and the lease has its grant from 2 minutes ago.
    expect(of([container("old", { upMinMs: 10 * MINUTE })]).leaseOf.size).toBe(0);
    // 30 s of slack before the grant.
    expect(of([container("edge", { upMinMs: 2 * MINUTE + 30_000 })]).leaseOf.get("edge")).toEqual({ lease: "shop", from: "folder" });
    expect(of([container("late", { upMinMs: 2 * MINUTE + 31_000 })]).leaseOf.size).toBe(0);
    // No run time, no folder or no running state: no lease.
    expect(of([container("a", { upMinMs: null }), container("b", { workingDir: null }), container("c", { state: "exited" })]).leaseOf.size).toBe(0);
    // A lease with no folder, or a waiting lease.
    expect(of([container("mongo")], [lease("shop", { pid: 10 })]).leaseOf.size).toBe(0);
    expect(of([container("mongo")], [{ ...SHOP, state: "waiting" }]).leaseOf.size).toBe(0);
  });

  it("gives no lease when two leases match", () => {
    const second = lease("tests", { pid: 30, folder: "D:\\work\\Shop" });
    expect(of([container("mongo")], [SHOP, second]).leaseOf.size).toBe(0);
    // The start time tells them apart: the second lease has its grant after the start of the container.
    const later = { ...second, grantedAt: AT - 10_000 };
    expect(of([container("mongo")], [SHOP, later]).leaseOf.get("mongo")).toEqual({ lease: "shop", from: "folder" });
  });

  it("does not use the home folder or a root as the folder of a lease", () => {
    const home = lease("home", { pid: 10, folder: HOME });
    expect(of([container("mongo", { workingDir: "C:\\Users\\Me\\proj" })], [home]).leaseOf.size).toBe(0);
    expect(of([container("mongo")], [lease("root", { pid: 10, folder: "D:\\" })]).leaseOf.size).toBe(0);
    expect(of([container("mongo", { workingDir: "/srv/shop" })], [lease("slash", { pid: 10, folder: "/" })]).leaseOf.size).toBe(0);
  });

  it("gives a container with the label to the lease that it names, with no other fact", () => {
    const plain = lease("lease-1", { pid: 20 });
    const found = of([container("db", { leaseLabel: "lease-1", workingDir: null, upMinMs: 5 * HOUR })], [plain]);
    expect(found.leaseOf.get("db")).toEqual({ lease: "lease-1", from: "label" });
    // A label of an ended lease gives no lease, also when the folder rule matches.
    expect(of([container("mongo", { leaseLabel: "gone" })]).leaseOf.size).toBe(0);
  });
});

describe("leaseMemoryMb (H62)", () => {
  const found = leaseContainers([container("mongo"), container("db", { leaseLabel: "plain", memoryMb: 1000 })], [SHOP, lease("plain", { pid: 20 }), lease("rows")], PROCESSES, AT, forms, WIDE);

  it("adds the containers to the job tree", () => {
    expect(leaseMemoryMb(SHOP, PROCESSES, found)).toBe(450 + 3000);
    expect(leaseMemoryMb({ id: "plain", pid: 20 }, PROCESSES, found)).toBe(100 + 1000);
  });

  it("gives no measure for a container client with no container, and for a process that is not in the read", () => {
    expect(leaseMemoryMb({ id: "other", pid: 10 }, PROCESSES, found)).toBeNull();
    expect(leaseMemoryMb(SHOP, PROCESSES, undefined)).toBeNull();
    expect(leaseMemoryMb({ id: "shop", pid: 99 }, PROCESSES, found)).toBeNull();
  });

  it("counts only the containers of a lease with no process", () => {
    const rows = leaseContainers([container("db", { leaseLabel: "rows", memoryMb: 700 })], [lease("rows")], PROCESSES, AT, forms, WIDE);
    expect(leaseMemoryMb({ id: "rows", pid: null }, PROCESSES, rows)).toBe(700);
    expect(leaseMemoryMb({ id: "rows", pid: null }, PROCESSES, undefined)).toBeNull();
  });

  it("names the containers in the use of a lease and in the over alert", () => {
    const uses = leaseUses({ leases: [SHOP], processes: PROCESSES, leaseContainers: found }, DEFAULT_ALERT_RULES);
    expect(uses).toEqual([{ id: "shop", holder: "shop", job: "shop", statedMb: 500, usedMb: 3450, peakMb: 3450, times: 6.9, over: true, containers: ["mongo"] }]);
    expect(overText(uses).message).toContain("used up to 3.4 GB, 6.9 times its amount. Its use holds the container mongo.");
  });
});

describe("the folder of a lease (H62)", () => {
  it("keeps the folder in the store", () => {
    const store = new Store(":memory:");
    try {
      store.saveLease(lease("a", { folder: "D:\\work\\Shop" }));
      store.saveLease(lease("b"));
      expect(store.lease("a")?.folder).toBe("D:\\work\\Shop");
      expect(store.lease("b")).not.toHaveProperty("folder");
    } finally {
      store.close();
    }
  });
});

describe("Engine containers of a lease (H62)", () => {
  it("counts the containers of a compose job in its use, its over alert and its hold", () => {
    let now = 1_000_000;
    const job = process.pid;
    const list: ProcessInfo[] = [p(4, 0, "System", 1), p(job, 4, "node.exe", 300), p(job + 1, job, "docker.exe", 50)];
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 12_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => list,
      close: () => undefined,
    };
    let read: DockerRead | undefined;
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere", docker: () => read });
    try {
      const stack = engine.request({ holder: "shop", job: "share-stack", amounts: { memory: 500 }, ttlMs: 600_000, pid: job, folder: "D:\\work\\Shop" });
      expect(stack).toMatchObject({ state: "granted", folder: "D:\\work\\Shop" });
      engine.tick();
      // The tree holds a container client and no container yet: no measure (H187).
      expect(engine.status().leaseUse?.[0]).toMatchObject({ usedMb: null, over: false });
      now += 20_000;
      const mongo = { id: "m1", name: "share-mongo-1", image: "mongo:7", state: "running", project: "share", workingDir: "D:\\work\\Shop\\deploy" };
      read = {
        at: now, version: "29.9.2", api: "1.56", disk: null, readMs: 40,
        containers: [{ ...mongo, upMinMs: 5000, memoryMb: 3000, limitMb: null, cores: 0.2, sizeRwMb: 0 }],
      };
      engine.tick();
      const status = engine.status();
      expect(status.leaseUse?.[0]).toMatchObject({ usedMb: 3350, peakMb: 3350, over: true, containers: ["share-mongo-1"] });
      expect(status.alerts.find((alert) => alert.kind === "over")?.message).toContain("Its use holds the container share-mongo-1.");
      // The hold of the lease is its stated amount less its use, so the free memory does not count the container two times.
      expect(status.free["memory"]).toBe(12_000 - status.reserveMb);
    } finally {
      engine.close();
    }
  });
});
