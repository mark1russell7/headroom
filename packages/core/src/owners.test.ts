import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attribute, readSessions, treeMb } from "./owners.ts";
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
