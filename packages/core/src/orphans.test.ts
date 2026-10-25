import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, detect } from "./alerts.ts";
import { OwnerRecords, ownerText, RECORD_AFTER_MS, shortCommand, type ProcessRecord, type RecordChanges } from "./orphans.ts";
import { attribute, baseOwner, isOrphan, processKey } from "./owners.ts";
import { Store } from "./store.ts";
import type { ProcessInfo, SessionInfo } from "./types.ts";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const p = (pid: number, ppid: number, name: string, startedAt: number, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({
  pid, ppid, name, privateMb: 10, workingMb: 10, startedAt, ...extra,
});
const sessions: SessionInfo[] = [{ pid: 11, name: "server-stack tools", sessionId: "s1", status: "busy", cwd: null }];
const FIND = '"C:\\Program Files\\Git\\usr\\bin\\find.exe" / -name WIRE-PROTOCOL.md -path *procedures*';
const commandOf = (pid: number): string | null => (pid === 13 ? FIND : pid === 12 ? "bash.exe -c find" : null);

// The tree of a session: claude.exe (11), its shell bash.exe (12), and find.exe (13) that the shell started.
const tree = [p(4, 0, "System", 0), p(11, 4, "claude.exe", T0 - 60 * MIN), p(12, 11, "bash.exe", T0 - 2 * MIN), p(13, 12, "find.exe", T0 - MIN)];
const withoutShell = tree.filter((info) => info.pid !== 12);

/** A fake store of the owner records: it keeps the rows in a map, as the table `process_owners` does. */
class FakeStore {
  readonly rows = new Map<string, ProcessRecord>();
  deletes = 0;
  processOwners(): ProcessRecord[] {
    return [...this.rows.values()];
  }
  saveProcessOwners(changes: RecordChanges): void {
    if (changes.ended.length > 0) this.deletes += 1;
    for (const record of changes.ended) this.rows.delete(`${record.pid}:${record.created}`);
    for (const record of changes.save) this.rows.set(`${record.pid}:${record.created}`, record);
  }
}

/** One read of the engine: the attribution with the records, then the records of the read. */
function read(records: OwnerRecords, store: FakeStore, now: number, processes: readonly ProcessInfo[], live: readonly SessionInfo[] = sessions) {
  const attribution = attribute(processes, live, undefined, undefined, undefined, records.byKey());
  store.saveProcessOwners(records.observe(now, processes, attribution.ownerOf, commandOf));
  return attribution;
}

describe("shortCommand (H48)", () => {
  it("gives the name of the program with no folder and no .exe, then the arguments, cut to 200 characters", () => {
    expect(shortCommand(FIND)).toBe("find / -name WIRE-PROTOCOL.md -path *procedures*");
    expect(shortCommand("C:\\Windows\\system32\\cmd.exe /c dir")).toBe("cmd /c dir");
    expect(shortCommand("/usr/bin/find / -name x")).toBe("find / -name x");
    expect(shortCommand("node")).toBe("node");
    expect(shortCommand(`node ${"x".repeat(300)}`)).toHaveLength(200);
  });
});

describe("owner records and orphans (H48)", () => {
  it("keeps the owner of a process after its parent ends, with the label (orphan) and the kind other", () => {
    const records = new OwnerRecords();
    const store = new FakeStore();
    expect(read(records, store, T0, tree).ownerOf.get(13)).toBe("session:server-stack tools");
    expect(records.get(tree[3] as ProcessInfo)).toMatchObject({ pid: 13, owner: "session:server-stack tools", command: "find / -name WIRE-PROTOCOL.md -path *procedures*", firstSeen: T0 });
    // The shell ends. Without the record, find.exe has no owner.
    expect(attribute(withoutShell, sessions).ownerOf.get(13)).toBe("other");
    const { owners, ownerOf } = read(records, store, T0 + 10_000, withoutShell);
    expect(ownerOf.get(13)).toBe("session:server-stack tools (orphan)");
    expect(owners.find((each) => each.owner === "session:server-stack tools (orphan)")).toMatchObject({ kind: "other", processes: 1 });
    expect(isOrphan(withoutShell[2] as ProcessInfo, new Map(withoutShell.map((info) => [info.pid, info])))).toBe(true);
    // The record keeps the owner without the label.
    expect(records.get(withoutShell[2] as ProcessInfo)?.owner).toBe("session:server-stack tools");
  });

  it("gives the label to the descendants of an orphan, and keeps a later owner while the parent runs", () => {
    const records = new OwnerRecords();
    const store = new FakeStore();
    // The session file is absent at the first read, so the rule of System gives the owner. The record then follows the owner.
    read(records, store, T0, tree, []);
    expect(records.get(tree[3] as ProcessInfo)?.owner).toBe("system");
    read(records, store, T0 + 10_000, [...tree, p(14, 13, "grep.exe", T0)]);
    expect(records.get(tree[3] as ProcessInfo)?.owner).toBe("session:server-stack tools");
    const { ownerOf } = read(records, store, T0 + 20_000, [...withoutShell, p(14, 13, "grep.exe", T0)]);
    expect(ownerOf.get(13)).toBe("session:server-stack tools (orphan)");
    expect(ownerOf.get(14)).toBe("session:server-stack tools (orphan)");
  });

  it("gives no label when the record gives the same owner or other", () => {
    const records = new OwnerRecords();
    const store = new FakeStore();
    // explorer.exe is an orphan at its first read, so its record has the owner of its rule.
    const list = [p(4, 0, "System", 0), p(30, 999, "explorer.exe", T0 - MIN), p(31, 30, "notepad.exe", T0), p(40, 998, "mystery.exe", T0)];
    read(records, store, T0, list);
    const { ownerOf } = read(records, store, T0 + 10_000, list);
    expect(ownerOf.get(30)).toBe("system");
    expect(ownerOf.get(31)).toBe("system");
    expect(ownerOf.get(40)).toBe("other");
  });

  it("writes a record to the store after one minute, keeps it over a restart, and prunes the records of ended processes", () => {
    const store = new FakeStore();
    const before = new OwnerRecords();
    const pids = (): number[] => [...store.rows.values()].map((row) => row.pid).sort((a, b) => a - b);
    read(before, store, T0, tree);
    // claude.exe and bash.exe are older than one minute. find.exe starts one minute before T0, so it is one minute old too.
    // The read has no start of System, so its age counts from its first read.
    expect(pids()).toEqual([11, 12, 13]);
    const young = p(15, 11, "node.exe", T0);
    read(before, store, T0 + 10_000, [...tree, young]);
    expect(store.rows.has(processKey(young))).toBe(false);
    read(before, store, T0 + RECORD_AFTER_MS, [...tree, young]);
    expect(store.rows.has(processKey(young))).toBe(true);
    expect(pids()).toEqual([4, 11, 12, 13, 15]);
    // The shell and the session end, and the daemon restarts. The new records come from the store.
    const after = new OwnerRecords();
    after.restore(store.processOwners());
    expect(after.size).toBe(5);
    const { ownerOf } = read(after, store, T0 + 2 * MIN, withoutShell.filter((info) => info.pid !== 11), []);
    expect(ownerOf.get(13)).toBe("session:server-stack tools (orphan)");
    // The read removed the records of claude.exe, bash.exe and node.exe from the memory and from the store.
    expect(after.size).toBe(2);
    expect(pids()).toEqual([4, 13]);
    expect(store.deletes).toBe(1);
    // A new process with the ID of find.exe is a different process: it gets no record of the old one.
    const reused = p(13, 4, "node.exe", T0 + 3 * MIN);
    const next = read(after, store, T0 + 3 * MIN, [p(4, 0, "System", 0), reused], []);
    expect(next.ownerOf.get(13)).toBe("system");
    expect(store.rows.has(`13:${T0 - MIN}`)).toBe(false);
  });

  it("writes and prunes the records in the SQLite store with one statement for the ended processes", () => {
    const store = new Store(":memory:");
    const record = (pid: number, owner: string): ProcessRecord => ({ pid, created: T0 + pid, owner, command: `cmd ${pid}`, firstSeen: T0 });
    store.saveProcessOwners({ save: [record(1, "session:a"), record(2, "session:b"), record(3, "other")], ended: [] });
    store.saveProcessOwners({ save: [{ ...record(2, "session:c"), command: null }], ended: [record(1, "session:a"), record(3, "other")] });
    expect(store.processOwners()).toEqual([{ pid: 2, created: T0 + 2, owner: "session:c", command: null, firstSeen: T0 }]);
    store.close();
  });

  it("names an orphan in the CPU runaway alert of H23", () => {
    const owners = new Map([[13, "session:graph (orphan)"]]);
    const trail = Array.from({ length: 61 }, (_, step) => ({ at: step * 10_000, value: 6 }));
    const [alert] = detect({
      memory: { totalMb: 28_000, availableMb: 8000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 },
      processes: [p(13, 12, "find.exe", 0)],
      ownerOf: owners,
      kindOf: new Map([["session:graph (orphan)", "other"]]),
      leases: [],
      at: 610_000,
      processors: 16,
      trees: [{ pid: 13, processes: 1, trail }],
    }, DEFAULT_ALERT_RULES).filter((each) => each.id === "runaway:cpu:13");
    expect(alert?.message).toBe("find.exe (13) of session:graph (orphan) uses 6 cores with no lease, above 4 cores for 10 minutes. Run such work with headroom run --cpu.");
  });

  it("writes the owner of an orphan for an alert", () => {
    expect(ownerText("session:graph", true)).toBe("session:graph (orphan, parent ended)");
    expect(ownerText("session:graph (orphan)", true)).toBe("session:graph (orphan, parent ended)");
    expect(ownerText("session:graph (orphan)", false)).toBe("session:graph (orphan)");
    expect(baseOwner("mcp:vex (orphan)")).toBe("mcp:vex");
  });
});
