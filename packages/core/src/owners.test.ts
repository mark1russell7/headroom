import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attribute, kernelOwners, readSessions, titleOf, treeMb } from "./owners.ts";
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
});
