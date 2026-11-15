import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, detect } from "./alerts.ts";
import { COMMAND_CUT, COMMAND_MAX, commandText, keepEnds, OwnerRecords, ownerText, RECORD_AFTER_MS, shortCommand, type ProcessRecord, type RecordChanges } from "./orphans.ts";
import { attribute, baseOwner, isOrphan, processKey } from "./owners.ts";
import { Store } from "./store.ts";
import type { ProcessInfo, SessionInfo } from "./types.ts";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const p = (pid: number, ppid: number, name: string, startedAt: number, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({
  pid, ppid, name, privateMb: 10, workingMb: 10, startedAt, ...extra,
});
const sessions: SessionInfo[] = [{ pid: 11, name: "harbor-crane tools", sessionId: "s1", status: "busy", cwd: null }];
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
function read(records: OwnerRecords, store: FakeStore, now: number, processes: readonly ProcessInfo[], live: readonly SessionInfo[] = sessions, lines = commandOf) {
  const attribution = attribute(processes, live, undefined, undefined, undefined, records.byKey());
  store.saveProcessOwners(records.observe(now, processes, attribution.ownerOf, lines, attribution.sessionOf));
  return attribution;
}

describe("shortCommand (H48)", () => {
  it("gives the name of the program with no folder and no .exe, then the arguments, with no cut at 200 characters (H182)", () => {
    expect(shortCommand(FIND)).toBe("find / -name WIRE-PROTOCOL.md -path *procedures*");
    expect(shortCommand("C:\\Windows\\system32\\cmd.exe /c dir")).toBe("cmd /c dir");
    expect(shortCommand("/usr/bin/find / -name x")).toBe("find / -name x");
    expect(shortCommand("node")).toBe("node");
    expect(shortCommand(`node ${"x".repeat(300)}`)).toHaveLength(305);
  });
});

describe("keepEnds (H182)", () => {
  /** A half of a pair of UTF-16 code units with no other half. */
  const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  /** One character that is a pair of UTF-16 code units: U+1F600. */
  const PAIR = "\u{1F600}";

  it("cuts before a pair at the start, and after a pair at the end", () => {
    const text = `ab${PAIR}${"c".repeat(40)}${PAIR}yz`;
    // The head of 3 ends inside the first pair, so the start keeps 2 characters and the end keeps the last pair.
    expect(keepEnds(text, 11, 3)).toBe(`ab${COMMAND_CUT}${PAIR}yz`);
    // The end starts inside the last pair, so the end keeps only "yz".
    expect(keepEnds(text, 10, 2)).toBe(`ab${COMMAND_CUT}yz`);
  });

  it("does not cut a pair of UTF-16 code units for each length and each head", () => {
    // With a letter first or last, the pairs start at odd and at even positions.
    for (const text of [PAIR.repeat(30), `a${PAIR.repeat(30)}`, `${PAIR.repeat(30)}z`]) {
      for (let max = COMMAND_CUT.length; max <= 40; max += 1) {
        for (let head = 0; head <= max; head += 1) {
          const cut = keepEnds(text, max, head);
          expect(cut).not.toMatch(LONE_HALF);
          expect(cut.length).toBeLessThanOrEqual(max);
          const [first = "", last = ""] = cut.split(COMMAND_CUT);
          expect(text.startsWith(first) && text.endsWith(last)).toBe(true);
        }
      }
    }
  });
});

describe("owner records and orphans (H48)", () => {
  it("keeps the owner of a process after its parent ends, with the label (orphan) and the kind other", () => {
    const records = new OwnerRecords();
    const store = new FakeStore();
    expect(read(records, store, T0, tree).ownerOf.get(13)).toBe("session:harbor-crane tools");
    expect(records.get(tree[3] as ProcessInfo)).toMatchObject({ pid: 13, owner: "session:harbor-crane tools", command: "find / -name WIRE-PROTOCOL.md -path *procedures*", firstSeen: T0 });
    // The shell ends. Without the record, find.exe has no owner.
    expect(attribute(withoutShell, sessions).ownerOf.get(13)).toBe("other");
    const { owners, ownerOf } = read(records, store, T0 + 10_000, withoutShell);
    expect(ownerOf.get(13)).toBe("session:harbor-crane tools (orphan)");
    expect(owners.find((each) => each.owner === "session:harbor-crane tools (orphan)")).toMatchObject({ kind: "other", processes: 1 });
    expect(isOrphan(withoutShell[2] as ProcessInfo, new Map(withoutShell.map((info) => [info.pid, info])))).toBe(true);
    // The record keeps the owner without the label.
    expect(records.get(withoutShell[2] as ProcessInfo)?.owner).toBe("session:harbor-crane tools");
  });

  it("gives the label to the descendants of an orphan, and keeps a later owner while the parent runs", () => {
    const records = new OwnerRecords();
    const store = new FakeStore();
    // The session file is absent at the first read, so the rule of System gives the owner. The record then follows the owner.
    read(records, store, T0, tree, []);
    expect(records.get(tree[3] as ProcessInfo)?.owner).toBe("system");
    read(records, store, T0 + 10_000, [...tree, p(14, 13, "grep.exe", T0)]);
    expect(records.get(tree[3] as ProcessInfo)?.owner).toBe("session:harbor-crane tools");
    const { ownerOf } = read(records, store, T0 + 20_000, [...withoutShell, p(14, 13, "grep.exe", T0)]);
    expect(ownerOf.get(13)).toBe("session:harbor-crane tools (orphan)");
    expect(ownerOf.get(14)).toBe("session:harbor-crane tools (orphan)");
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
    expect(ownerOf.get(13)).toBe("session:harbor-crane tools (orphan)");
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
    const record = (pid: number, owner: string): ProcessRecord => ({
      pid, created: T0 + pid, ppid: 4, parentCreated: T0, owner, session: null, sessionId: null, command: `cmd ${pid}`, firstSeen: T0,
    });
    store.saveProcessOwners({ save: [record(1, "session:a"), record(2, "session:b"), record(3, "other")], ended: [] });
    store.saveProcessOwners({ save: [{ ...record(2, "session:c"), command: null }], ended: [record(1, "session:a"), record(3, "other")] });
    expect(store.processOwners()).toEqual([{ pid: 2, created: T0 + 2, ppid: 4, parentCreated: T0, owner: "session:c", session: null, sessionId: null, command: null, firstSeen: T0 }]);
    store.close();
  });

  it("names an orphan in the CPU runaway alert of H23", () => {
    const owners = new Map([[13, "session:shop (orphan)"]]);
    const trail = Array.from({ length: 61 }, (_, step) => ({ at: step * 10_000, value: 6 }));
    const [alert] = detect({
      memory: { totalMb: 28_000, availableMb: 8000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 },
      processes: [p(13, 12, "find.exe", 0)],
      ownerOf: owners,
      kindOf: new Map([["session:shop (orphan)", "other"]]),
      leases: [],
      at: 610_000,
      processors: 16,
      trees: [{ pid: 13, processes: 1, trail }],
    }, DEFAULT_ALERT_RULES).filter((each) => each.id === "runaway:cpu:13");
    expect(alert?.message).toBe("find.exe (13) of session:shop (orphan) uses 6 cores with no lease, above 4 cores for 10 minutes. Run such work with headroom run --cpu.");
  });

  it("writes the owner of an orphan for an alert", () => {
    expect(ownerText("session:shop", true)).toBe("session:shop (orphan, parent ended)");
    expect(ownerText("session:shop (orphan)", true)).toBe("session:shop (orphan, parent ended)");
    expect(ownerText("session:shop (orphan)", false)).toBe("session:shop (orphan)");
    expect(baseOwner("mcp:vex (orphan)")).toBe("mcp:vex");
  });
});

describe("the process table proves ownership (H182)", () => {
  const byPidOf = (list: readonly ProcessInfo[]): Map<number, ProcessInfo> => new Map(list.map((info) => [info.pid, info]));

  it("reads a reused parent ID (the same ID, a later start) as gone, also when the read has no start of the child", () => {
    const records = new OwnerRecords();
    const store = new FakeStore();
    // The read gives no start of find.exe, so the rule of H29 cannot compare the starts.
    const find: ProcessInfo = { pid: 13, ppid: 12, name: "find.exe", privateMb: 10, workingMb: 10 };
    const before = [p(4, 0, "System", 0), p(11, 4, "claude.exe", T0 - 60 * MIN), p(12, 11, "bash.exe", T0 - 2 * MIN), find];
    read(records, store, T0, before);
    expect(records.get(find)).toMatchObject({ ppid: 12, parentCreated: T0 - 2 * MIN, session: "harbor-crane tools", sessionId: "s1" });
    // The parent with its own start runs: find.exe is not an orphan.
    expect(isOrphan(find, byPidOf(before), records.get(find))).toBe(false);
    // The shell ends, and a new process gets the ID 12 with a later start. Only the record shows that the parent is gone.
    const node = p(12, 4, "node.exe", T0 + 5000);
    const after = [...before.filter((info) => info.pid !== 12), node];
    expect(isOrphan(find, byPidOf(after))).toBe(false);
    expect(isOrphan(find, byPidOf(after), records.get(find))).toBe(true);
    const { ownerOf, sessionOf } = read(records, store, T0 + 10_000, after);
    expect(ownerOf.get(13)).toBe("session:harbor-crane tools (orphan)");
    expect(sessionOf.get(13)).toEqual({ name: "harbor-crane tools", id: "s1" });
    // The new process with the ID 12 is not an orphan: its own parent runs.
    expect(isOrphan(node, byPidOf(after), records.get(node))).toBe(false);
    // A process with the ID of the parent and no start in the read is not a proof: the parent is not proven gone.
    const unread: ProcessInfo = { pid: 12, ppid: 11, name: "bash.exe", privateMb: 1, workingMb: 1 };
    expect(isOrphan(find, byPidOf([...before.slice(0, 2), unread, find]), records.get(find))).toBe(false);
  });

  it("reads a reused parent ID as gone for a child with a start, and a new parent ID of Linux as gone", () => {
    const records = new OwnerRecords();
    read(records, new FakeStore(), T0, tree);
    const find = tree[3] as ProcessInfo;
    const reused = [...withoutShell, p(12, 4, "node.exe", T0 + 5000)];
    expect(isOrphan(find, byPidOf(reused), records.get(find))).toBe(true);
    // Linux gives an orphan the parent init (1) when its parent ends. The record keeps the first parent, 12.
    const moved = [p(1, 0, "systemd", T0 - 90 * MIN), p(11, 1, "claude", T0 - 60 * MIN), { ...find, ppid: 1 }];
    expect(isOrphan(moved[2] as ProcessInfo, byPidOf(moved))).toBe(false);
    expect(isOrphan(moved[2] as ProcessInfo, byPidOf(moved), records.get(find))).toBe(true);
    expect(attribute(moved, sessions, undefined, undefined, undefined, records.byKey()).ownerOf.get(13)).toBe("session:harbor-crane tools (orphan)");
  });

  it("gives a process the session of its claude.exe ancestor, and keeps it after the parent ends", () => {
    const records = new OwnerRecords();
    const store = new FakeStore();
    const live: SessionInfo[] = [
      { pid: 11, name: "kestrel", sessionId: "6f1c-kestrel", status: "busy", cwd: null },
      { pid: 21, name: "otter", sessionId: "9a2d-otter", status: "idle", cwd: null },
    ];
    const grep = p(13, 12, "grep.exe", T0 - MIN);
    const list = [p(4, 0, "System", 0), p(11, 4, "claude.exe", T0 - 60 * MIN), p(12, 11, "bash.exe", T0 - 2 * MIN), grep];
    const other = [p(21, 4, "claude.exe", T0 - 30 * MIN), p(22, 21, "bash.exe", T0 - MIN), p(30, 4, "explorer.exe", T0 - 90 * MIN)];
    read(records, store, T0, [...list, ...other], live);
    expect(records.get(grep)).toMatchObject({ owner: "session:kestrel", session: "kestrel", sessionId: "6f1c-kestrel" });
    expect(records.get(other[1] as ProcessInfo)).toMatchObject({ session: "otter", sessionId: "9a2d-otter" });
    expect(records.get(other[2] as ProcessInfo)).toMatchObject({ session: null, sessionId: null });
    // The session file of kestrel goes away while its shell runs. The ancestors of grep.exe do not change, so it keeps the session.
    read(records, store, T0 + 10_000, [...list, ...other], live.slice(1));
    expect(records.get(grep)).toMatchObject({ session: "kestrel", sessionId: "6f1c-kestrel" });
    // The shell ends. grep.exe keeps its session, and a child that it starts later gets the same session.
    const sort = p(14, 13, "sort.exe", T0 + 20_000);
    const { sessionOf } = read(records, store, T0 + 20_000, [list[0] as ProcessInfo, grep, sort, ...other], live.slice(1));
    expect(records.get(grep)).toMatchObject({ session: "kestrel", sessionId: "6f1c-kestrel", ppid: 12, parentCreated: T0 - 2 * MIN });
    expect(sessionOf.get(14)).toEqual({ name: "kestrel", id: "6f1c-kestrel" });
    expect(records.get(sort)).toMatchObject({ session: "kestrel", sessionId: "6f1c-kestrel" });
  });

  it("keeps the last path of a command line of 4 KB, in the record, in the store and in the text of an alert", () => {
    const transcript = "C:\\Users\\<you>\\.claude\\projects\\D--work-kestrel\\2b7e1c55-0d4f-4c1e-9a65-3f2f8f1d9c10.jsonl";
    const program = '"C:\\Program Files\\Git\\usr\\bin\\grep.exe"';
    const line = `${program} -n ${"-e pattern ".repeat(370)}${transcript}`;
    expect(line.length).toBeGreaterThan(4096);
    const records = new OwnerRecords();
    read(records, new FakeStore(), T0, tree, sessions, (pid) => (pid === 13 ? line : null));
    const command = records.get(tree[3] as ProcessInfo)?.command ?? "";
    expect(command).toBe(`grep${line.slice(program.length)}`);
    expect(command.endsWith(transcript)).toBe(true);
    // The store keeps the full line.
    const store = new Store(":memory:");
    const record: ProcessRecord = { pid: 27308, created: T0, ppid: 12, parentCreated: T0 - MIN, owner: "session:kestrel", session: "kestrel", sessionId: "6f1c-kestrel", command, firstSeen: T0 };
    store.saveProcessOwners({ save: [record], ended: [] });
    expect(store.processOwners()).toEqual([record]);
    store.close();
    // The text of an alert has at most 200 characters, and it keeps the end.
    expect(commandText(command, 200)).toHaveLength(200);
    expect(commandText(command, 200).endsWith(transcript)).toBe(true);
    expect(commandText("grep -n x", 200)).toBe("grep -n x");
    // A line longer than the limit keeps its start, the mark and its end.
    const long = shortCommand(`grep ${"x".repeat(20_000)} ${transcript}`);
    expect(long).toHaveLength(COMMAND_MAX);
    expect(long.startsWith("grep xxx")).toBe(true);
    expect(long).toContain(COMMAND_CUT);
    expect(long.endsWith(transcript)).toBe(true);
  });

  it("adds the new columns to a file of version 1, takes the session from the owner, and fills the parent at the next read", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-owners-")), "old.db");
    // A file of version 1: the schema of today without the columns of H182.
    new Store(path).close();
    const old = new DatabaseSync(path);
    for (const column of ["ppid", "parent_created", "session", "session_id"]) old.exec(`ALTER TABLE process_owners DROP COLUMN ${column}`);
    old.exec(`INSERT INTO process_owners (pid, created, owner, command, first_seen) VALUES (13, ${T0 - MIN}, 'session:harbor-crane tools', 'find / -name x', ${T0}), (30, ${T0}, 'system', NULL, ${T0})`);
    old.exec("PRAGMA user_version = 1");
    old.close();
    const store = new Store(path);
    const rows = store.processOwners().sort((a, b) => a.pid - b.pid);
    store.close();
    expect(rows).toEqual([
      { pid: 13, created: T0 - MIN, ppid: 0, parentCreated: 0, owner: "session:harbor-crane tools", session: "harbor-crane tools", sessionId: null, command: "find / -name x", firstSeen: T0 },
      { pid: 30, created: T0, ppid: 0, parentCreated: 0, owner: "system", session: null, sessionId: null, command: null, firstSeen: T0 },
    ]);
    const records = new OwnerRecords();
    records.restore(rows);
    read(records, new FakeStore(), T0 + 10_000, tree);
    expect(records.get(tree[3] as ProcessInfo)).toMatchObject({ ppid: 12, parentCreated: T0 - 2 * MIN, session: "harbor-crane tools", sessionId: "s1" });
  });
});
