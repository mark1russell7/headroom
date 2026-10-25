import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attribute, childrenOf, fileTimeMs, isParent, kernelOwners, readSessions, titleOf, treeMb, unattributedMb, unattributedRow } from "./owners.ts";
import type { ProcessInfo } from "./types.ts";

const p = (pid: number, ppid: number, name: string, privateMb: number): ProcessInfo => ({ pid, ppid, name, privateMb, workingMb: privateMb / 2 });

const processes: ProcessInfo[] = [
  p(1, 0, "explorer.exe", 100),
  p(10, 1, "Code.exe", 300),
  p(11, 10, "claude.exe", 900),
  p(12, 11, "node.exe", 50),
  p(13, 12, "node.exe", 40),
  p(20, 1, "chrome.exe", 500),
  p(21, 20, "chrome.exe", 200),
  p(30, 4, "vmmemWSL", 800),
  p(40, 10, "node.exe", 60),
  p(50, 99, "mystery.exe", 10),
];

describe("attribute", () => {
  it("gives each process tree to its session, its rule or other", () => {
    const sessions = [{ pid: 11, name: "graph", sessionId: "s1", status: "busy", cwd: null }];
    const memory = { totalMb: 0, availableMb: 0, commitMb: 0, commitLimitMb: 0, kernelPagedMb: 1000, kernelNonpagedMb: 5000 };
    const { owners, ownerOf } = attribute(processes, sessions, memory);
    expect(ownerOf.get(13)).toBe("session:graph");
    expect(ownerOf.get(21)).toBe("browser");
    expect(ownerOf.get(30)).toBe("docker");
    expect(ownerOf.get(40)).toBe("editor");
    expect(ownerOf.get(50)).toBe("other");
    expect(owners[0]).toEqual({ owner: "kernel", kind: "kernel", privateMb: 6000, workingMb: 6000, processes: 0 });
    expect(owners.find((owner) => owner.owner === "session:graph")).toMatchObject({ privateMb: 990, processes: 3 });
  });

  it("gives the process tree of a gateway server to mcp:<name>", () => {
    const { owners, ownerOf } = attribute(processes, [], undefined, undefined, new Map([[40, "vex"]]));
    expect(ownerOf.get(40)).toBe("mcp:vex");
    expect(ownerOf.get(10)).toBe("editor");
    expect(owners.find((owner) => owner.owner === "mcp:vex")).toMatchObject({ kind: "mcp", privateMb: 60, processes: 1 });
  });

  it("follows a parent only when it started at or before its child, so a parent ID in use again does not decide the owner (H29)", () => {
    const at = (info: ProcessInfo, startedAt: number): ProcessInfo => ({ ...info, startedAt });
    const sessions = [{ pid: 11, name: "client", sessionId: "s1", status: "busy", cwd: null }];
    // The session started at 5000. The real parent of 61 and 62 ended, and the session got its ID later.
    const tree = [
      at(p(11, 1, "claude.exe", 900), 5000),
      at(p(12, 11, "bash.exe", 5), 6000),
      at(p(61, 11, "gh.exe", 5), 4000),
      at(p(62, 11, "chrome.exe", 5), 4000),
      at(p(63, 61, "tr.exe", 1), 4500),
      p(64, 11, "base64.exe", 1),
    ];
    const { ownerOf } = attribute(tree, sessions);
    expect(ownerOf.get(12)).toBe("session:client");
    // The process goes to the owner of its own part of the tree: no owner, or its own rule.
    expect(ownerOf.get(61)).toBe("other");
    expect(ownerOf.get(62)).toBe("browser");
    expect(ownerOf.get(63)).toBe("other");
    // Without a start, the link counts, as before.
    expect(ownerOf.get(64)).toBe("session:client");
    expect(isParent(tree[0] as ProcessInfo, tree[1] as ProcessInfo)).toBe(true);
    expect(isParent(tree[0] as ProcessInfo, tree[2] as ProcessInfo)).toBe(false);
    // The tree of a process and the leases follow the same rule.
    expect(treeMb(11, tree)).toBe(906);
    expect([...(childrenOf(tree).get(11) ?? [])].map((info) => info.pid)).toEqual([12, 64]);
  });

  it("survives a cycle in the parents", () => {
    const { ownerOf } = attribute([p(1, 2, "a.exe", 1), p(2, 1, "b.exe", 1)], []);
    expect(ownerOf.get(1)).toBe("other");
  });

  it("gives a Node process with a title under the system, and its descendants, to service:<title>", () => {
    const titled = (pid: number, ppid: number, title: string): ProcessInfo => ({ ...p(pid, ppid, "node.exe", 70), title });
    const list = [
      p(60, 0, "svchost.exe", 20),
      p(61, 60, "conhost.exe", 5),
      titled(62, 61, "headroom-daemon"),
      p(63, 62, "netsh.exe", 3),
      titled(64, 62, "headroom-mcp-vex"),
      ...processes,
      titled(14, 12, "headroom-cli"),
      titled(41, 10, "fleet-site"),
      titled(70, 999, "headroom-cli"),
    ];
    const sessions = [{ pid: 11, name: "graph", sessionId: "s1", status: null, cwd: null }];
    const { owners, ownerOf } = attribute(list, sessions, undefined, undefined, new Map([[64, "vex"]]));
    // The title is nearer than the rule of svchost.
    expect(ownerOf.get(62)).toBe("service:headroom-daemon");
    expect(ownerOf.get(63)).toBe("service:headroom-daemon");
    expect(ownerOf.get(61)).toBe("system");
    // A server of the gateway and a session win over a title.
    expect(ownerOf.get(64)).toBe("mcp:vex");
    expect(ownerOf.get(14)).toBe("session:graph");
    // A title replaces only the rule system. An orphan with a title stays other.
    expect(ownerOf.get(41)).toBe("editor");
    expect(ownerOf.get(70)).toBe("other");
    expect(owners.find((owner) => owner.owner === "service:headroom-daemon")).toMatchObject({ kind: "service", privateMb: 73, processes: 2 });
  });

  it("gives each minimal process of Windows its own owner, and sums the owners with the kernel owners (H49)", () => {
    // The values of a read on 2026-10-25: the system read gives the memory of these processes, with no open.
    const minimal: ProcessInfo[] = [
      { pid: 4, ppid: 0, name: "System", privateMb: 0, workingMb: 0 },
      { pid: 180, ppid: 4, name: "Registry", privateMb: 7, workingMb: 2 },
      { pid: 3140, ppid: 4, name: "Memory Compression", privateMb: 5, workingMb: 197 },
      { pid: 160, ppid: 4, name: "Secure System", privateMb: 0, workingMb: 113 },
      { pid: 2200, ppid: 900, name: "svchost.exe", privateMb: 3861, workingMb: 3071 },
      { pid: 900, ppid: 4, name: "services.exe", privateMb: 10, workingMb: 4 },
    ];
    const memory = { totalMb: 28_310, availableMb: 5959, commitMb: 37_992, commitLimitMb: 60_000, kernelPagedMb: 1500, kernelNonpagedMb: 4718, kernelPagedResidentMb: 766, cacheMb: 1913, driversMb: 60 };
    const { owners, ownerOf } = attribute(minimal, [], memory);
    expect(ownerOf.get(3140)).toBe("system:memory compression");
    expect(ownerOf.get(180)).toBe("system:registry");
    expect(ownerOf.get(160)).toBe("system:secure system");
    expect(ownerOf.get(2200)).toBe("system");
    expect(owners.find((owner) => owner.owner === "system:memory compression")).toEqual({ owner: "system:memory compression", kind: "system", privateMb: 5, workingMb: 197, processes: 1 });
    expect(owners.find((owner) => owner.owner === "system")).toMatchObject({ privateMb: 3871, workingMb: 3075, processes: 3 });
    // The owners in RAM: the processes 3387 MB, the kernel 5484 MB, the cache 1913 MB and the drivers 60 MB.
    expect(owners.reduce((sum, owner) => sum + owner.workingMb, 0)).toBe(10_844);
    expect(unattributedMb(memory, owners)).toBe(28_310 - 5959 - 10_844);
  });
});

describe("unattributedMb (H49)", () => {
  const memory = { totalMb: 28_000, availableMb: 6000 };

  it("gives the memory in use less the memory in RAM of the owners", () => {
    const owners = [
      { owner: "kernel", kind: "kernel" as const, privateMb: 6000, workingMb: 5400, processes: 0 },
      { owner: "browser", kind: "browser" as const, privateMb: 2700, workingMb: 1600, processes: 40 },
      { owner: "docker (VM)", kind: "docker" as const, privateMb: 2200, workingMb: 1400, processes: 3 },
    ];
    expect(unattributedMb(memory, owners)).toBe(22_000 - 8400);
    expect(unattributedMb(memory, [])).toBe(22_000);
  });

  it("gives a negative value when the owners count more than the memory in use", () => {
    expect(unattributedMb(memory, [{ workingMb: 23_000 }])).toBe(-1000);
  });
});

describe("unattributedRow (H49)", () => {
  const mb = (value: number): string => (Math.abs(value) >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`);

  it("gives the row of the table of the owners, with no private memory", () => {
    expect(unattributedRow(4200, mb)).toBe(`  ${"unattributed".padEnd(32)}         -    4.1 GB  in use, in no owner: mostly the pages that processes share`);
    expect(unattributedRow(-600, mb)).toContain("-600 MB  the owners count more than the memory in use");
  });

  it("gives no row without an amount, for example from a daemon of an older version", () => {
    expect(unattributedRow(null, mb)).toBeNull();
    expect(unattributedRow(undefined, mb)).toBeNull();
  });
});

describe("titleOf", () => {
  it("reads the option --title of a Node command line", () => {
    expect(titleOf("C:\\nvm4w\\nodejs\\node.exe --title=fleet-site C:\\fleet\\cli.ts serve")).toBe("fleet-site");
    expect(titleOf('"C:\\Program Files\\nodejs\\node.exe" --title "my server" app.js')).toBe("my server");
    expect(titleOf('node.exe "--title=quoted" app.js')).toBe("quoted");
    expect(titleOf("node.exe app.js")).toBeNull();
    expect(titleOf("node.exe --title= app.js")).toBeNull();
    expect(titleOf("node.exe --titles=x app.js")).toBeNull();
  });
});

describe("kernelOwners", () => {
  const memory = { totalMb: 28_000, availableMb: 7000, commitMb: 31_000, commitLimitMb: 80_000, kernelPagedMb: 1482, kernelNonpagedMb: 1433 };

  it("gives the pools in RAM, the file cache and the drivers when the platform gives them", () => {
    expect(kernelOwners({ ...memory, kernelPagedResidentMb: 1278, cacheMb: 10_100, driversMb: 60 })).toEqual([
      { owner: "kernel", kind: "kernel", privateMb: 2915, workingMb: 2711, processes: 0 },
      { owner: "kernel:cache", kind: "kernel", privateMb: 10_100, workingMb: 10_100, processes: 0 },
      { owner: "kernel:drivers", kind: "kernel", privateMb: 60, workingMb: 60, processes: 0 },
    ]);
  });

  it("gives the locked pages, the PFN database and the page tables of Windows 11 22H2 and later (H49)", () => {
    const owners = kernelOwners({ ...memory, kernelPagedResidentMb: 1278, cacheMb: 1913, driversMb: 60, driverLockedMb: 410, pfnDatabaseMb: 336, pageTablesMb: 148 });
    expect(owners.map((owner) => [owner.owner, owner.workingMb])).toEqual([
      ["kernel", 2711],
      ["kernel:cache", 1913],
      ["kernel:drivers", 60],
      ["kernel:driver locked", 410],
      ["kernel:pfn database", 336],
      ["kernel:page tables", 148],
    ]);
  });

  it("gives only the pools without the amounts in RAM", () => {
    expect(kernelOwners(memory)).toEqual([{ owner: "kernel", kind: "kernel", privateMb: 2915, workingMb: 2915, processes: 0 }]);
  });
});

describe("treeMb", () => {
  it("sums a process and its descendants", () => {
    expect(treeMb(11, processes)).toBe(990);
    expect(treeMb(999, processes)).toBe(0);
  });
});

describe("readSessions", () => {
  it("reads the session files and skips the bad ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-"));
    writeFileSync(join(dir, "11.json"), JSON.stringify({ pid: 11, sessionId: "abcdef12-0000", name: "graph", status: "idle", cwd: "C:\\x" }));
    writeFileSync(join(dir, "12.json"), JSON.stringify({ pid: 12, sessionId: "1234567890" }));
    writeFileSync(join(dir, "13.json"), "{ not json");
    const sessions = readSessions(dir).sort((a, b) => a.pid - b.pid);
    expect(sessions).toEqual([
      { pid: 11, name: "graph", sessionId: "abcdef12-0000", status: "idle", cwd: "C:\\x" },
      { pid: 12, name: "12345678", sessionId: "1234567890", status: null, cwd: null },
    ]);
    expect(readSessions(join(dir, "missing"))).toEqual([]);
  });

  it("reads the start of the process of a Windows session file from procStart (H46)", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-"));
    // 134373587570538346 is a FILETIME: 2026-10-24 in units of 100 nanoseconds since 1601-01-01.
    writeFileSync(join(dir, "a.json"), JSON.stringify({ pid: 15, sessionId: "s", name: "crawler", procStart: "134373587570538346", pidDomain: "win32:host" }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ pid: 16, sessionId: "t", name: "linux", procStart: "12345", pidDomain: "linux:host" }));
    const sessions = readSessions(dir).sort((a, b) => a.pid - b.pid);
    expect(sessions[0]?.startedAt).toBe(fileTimeMs(134373587570538346n));
    expect(sessions[0]?.startedAt).toBe(1_792_885_157_054);
    expect(sessions[1]?.startedAt).toBeUndefined();
  });
});
