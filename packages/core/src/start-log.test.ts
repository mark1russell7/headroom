import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filetimeMs,
  msFiletime,
  openStartLog,
  parentsOf,
  rankStarters,
  START_LOG_KEEP_MS,
  startLogSpan,
  StartLogWriter,
  startsBetween,
  startsOfPid,
  type ExitRow,
  type StartRow,
} from "./start-log.ts";

const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 17, 7, 0, 0);

/** A start row: the creation time is 50 ms before the message. */
function row(at: number, pid: number, ppid: number | null, image: string | null, command: string | null, extra: Partial<StartRow> = {}): StartRow {
  return { at, key: 1, pid, ppid, created: msFiletime(at - 50), image, command, parentCommand: null, reuseMs: null, ...extra };
}
const ended = (at: number, pid: number, exitCode: number | null, created: bigint | null = null): ExitRow => ({ at, key: 1, pid, exitCode, created });

let folder = "";
let path = "";
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "headroom-start-log-"));
  path = join(folder, "starts.db");
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe("the FILETIME of a creation (H193)", () => {
  it("keeps all the digits of a FILETIME, and converts it to Unix ms and back", () => {
    const filetime = 134_392_866_164_130_000n;
    expect(filetime > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(msFiletime(filetimeMs(filetime))).toBe(filetime);
    expect(new Date(filetimeMs(filetime)).toISOString()).toBe("2026-11-16T07:10:16.413Z");
  });
});

describe("StartLogWriter (H193)", () => {
  it("writes with synchronous FULL in WAL mode, and keeps each text once", () => {
    let now = T0;
    const writer = new StartLogWriter(path, { now: () => now });
    const node = "C:\\Program Files\\nodejs\\node.exe";
    writer.write([row(T0, 31368, 15400, node, "node hook.mjs"), row(T0 + 10, 31370, 15400, node, "node hook.mjs")], [ended(T0 + 400, 31368, 0)]);
    now += 120;
    writer.write([row(T0 + 500, 31372, 15400, node, null)], []);
    writer.write([], []);
    const stats = writer.stats();
    writer.close();
    expect(stats).toMatchObject({ path, starts: 3, withCommand: 2, withCreated: 3, exits: 1, commits: 2, failure: null });
    // The row of T0 was created at T0 - 50 and written at T0: 50 ms. The row of T0 + 500 was created at T0 + 450, written at T0 + 120.
    expect(stats.slowestLagMs).toBe(50);
    const db = new DatabaseSync(path);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("SELECT count(*) AS n FROM texts").get()).toEqual({ n: 2 });
    db.close();
  });

  it("gives each start its exit, the exact creation time and the texts", () => {
    const writer = new StartLogWriter(path, { now: () => T0 });
    writer.write([row(T0, 31368, 15400, "C:\\nodejs\\node.exe", "node a.js", { parentCommand: "bash -c 'node a.js'", reuseMs: 812 })], []);
    writer.write([row(T0 + 5 * S, 31368, 15400, "C:\\nodejs\\node.exe", "node b.js")], [ended(T0 + 2 * S, 31368, 0xc000_0142)]);
    writer.close();
    const db = openStartLog(path);
    const starts = startsOfPid(db, 31368);
    db.close();
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ command: "node b.js", exit: null, reuseMs: null });
    expect(starts[1]).toMatchObject({
      at: T0,
      pid: 31368,
      ppid: 15400,
      created: msFiletime(T0 - 50).toString(),
      createdAt: T0 - 50,
      image: "C:\\nodejs\\node.exe",
      command: "node a.js",
      parentCommand: "bash -c 'node a.js'",
      reuseMs: 812,
      exit: { at: T0 + 2 * S, exitCode: 0xc000_0142 },
    });
  });

  it("joins an exit to its start by the pid and the creation time, also when a new process gets the pid in the same ms", () => {
    const writer = new StartLogWriter(path, { now: () => T0 });
    const old = row(T0, 20, 1, "C:\\old.exe", "old");
    // The new process got the pid 20 in the ms of the exit of the old one, so both messages have the same time.
    const next = row(T0 + S, 20, 1, "C:\\new.exe", "new", { created: msFiletime(T0 + S), reuseMs: 0 });
    writer.write([old], []);
    writer.write([next], [ended(T0 + S, 20, 0, old.created)]);
    writer.close();
    const db = openStartLog(path);
    const [newer, older] = startsOfPid(db, 20);
    db.close();
    expect(newer).toMatchObject({ command: "new", reuseMs: 0, exit: null });
    expect(older).toMatchObject({ command: "old", exit: { at: T0 + S, exitCode: 0 } });
  });

  it("prunes the rows older than 24 hours before the newest row, and the texts that no kept row names", () => {
    let now = T0;
    const writer = new StartLogWriter(path, { now: () => now });
    for (let hour = 0; hour < 30; hour++) {
      now = T0 + hour * HOUR;
      writer.write([row(now, 100 + hour, 1, `C:\\tools\\once-${hour}.exe`, "x"), row(now, 200 + hour, 1, "C:\\tools\\each.exe", "y")], [ended(now, 100 + hour, 0)]);
    }
    expect(writer.prune()).toEqual({ starts: 10, exits: 5, texts: 4 });
    // A second prune with the same newest row deletes nothing.
    expect(writer.prune()).toEqual({ starts: 0, exits: 0, texts: 0 });
    writer.close();
    const db = openStartLog(path);
    const span = startLogSpan(db);
    // The newest row is at hour 29, so the kept rows start at hour 5. The texts keep one more hour: once-4 stays.
    expect(span).toEqual({ from: T0 + 5 * HOUR, to: T0 + 29 * HOUR, starts: 50, exits: 25 });
    expect(span.to! - span.from!).toBeLessThanOrEqual(START_LOG_KEEP_MS);
    expect(startsOfPid(db, 104)).toEqual([]);
    expect(startsOfPid(db, 105)[0]).toMatchObject({ image: "C:\\tools\\once-5.exe", exit: { at: T0 + 5 * HOUR, exitCode: 0 } });
    expect((db.prepare("SELECT count(*) AS n FROM texts").get() as { n: number }).n).toBe(29);
    db.close();
  });

  it("finds a text again after a new writer opens the file", () => {
    const first = new StartLogWriter(path, { now: () => T0 });
    first.write([row(T0, 1, null, "C:\\a.exe", "a")], []);
    first.close();
    const second = new StartLogWriter(path, { now: () => T0 + S });
    second.write([row(T0 + S, 2, null, "C:\\a.exe", "a")], []);
    second.close();
    const db = new DatabaseSync(path);
    expect(db.prepare("SELECT count(*) AS n FROM texts").get()).toEqual({ n: 2 });
    db.close();
  });
});

describe("the reads of the start log (H193)", () => {
  it("gives the parents, the nearest first, and stops at an older process with the pid of a parent", () => {
    const writer = new StartLogWriter(path, { now: () => T0 });
    writer.write(
      [
        row(T0, 10, 1, "C:\\claude.exe", "claude"),
        // An older holder of pid 20 that ended before the bash of pid 20 started.
        row(T0 + S, 20, 10, "C:\\old.exe", "old"),
      ],
      [ended(T0 + 2 * S, 20, 0)],
    );
    writer.write([row(T0 + 3 * S, 20, 10, "C:\\bash.exe", "bash -c x"), row(T0 + 4 * S, 30, 20, "C:\\node.exe", "node x")], []);
    writer.write([row(T0 + 5 * S, 40, 99, "C:\\git.exe", "git status")], [ended(T0 + 6 * S, 40, 0)]);
    writer.write([row(T0 + 7 * S, 99, 1, "C:\\late.exe", "late")], []);
    writer.close();
    const db = openStartLog(path);
    const [node] = startsOfPid(db, 30);
    expect(parentsOf(db, node!).map((parent) => parent.command)).toEqual(["bash -c x", "claude"]);
    // The process 99 of the log started after the process 40, so it is not its parent.
    const [git] = startsOfPid(db, 40);
    expect(parentsOf(db, git!)).toEqual([]);
    expect(startsBetween(db, T0 + 3 * S, T0 + 5 * S).map((start) => start.pid)).toEqual([20, 30, 40]);
    db.close();
  });

  it("ranks the starters by program and by the command line of the parent, with the pid reuse", () => {
    const writer = new StartLogWriter(path, { now: () => T0 });
    const rows: StartRow[] = [];
    for (let index = 0; index < 60; index++) {
      const at = T0 + index * S;
      rows.push(row(at, 1000 + index, 77, "C:\\git.exe", `git status ${index}`, { parentCommand: "bash -c 'git status'", reuseMs: index < 6 ? 400 : index < 15 ? 30 * S : null }));
      if (index % 3 === 0) rows.push(row(at, 5000 + index, 88, "C:\\gh.exe", "gh pr list", { parentCommand: "node watcher.mjs" }));
    }
    // An old row, before the last hour.
    writer.write([row(T0 - 2 * HOUR, 9, 1, "C:\\old.exe", "old")], []);
    writer.write(rows, []);
    writer.close();
    const db = openStartLog(path);
    const ranking = rankStarters(db, HOUR, 20);
    const day = rankStarters(db, 24 * HOUR, 20);
    db.close();
    expect(ranking).toMatchObject({ from: T0 + 59 * S - HOUR, to: T0 + 59 * S, starts: 80, reusedUnder1s: 6, reusedUnder60s: 15 });
    expect(ranking?.images).toEqual([
      { text: "C:\\git.exe", starts: 60, perMinute: 1 },
      { text: "C:\\gh.exe", starts: 20, perMinute: 0.3 },
    ]);
    expect(ranking?.parents.map((each) => [each.text, each.starts])).toEqual([
      ["bash -c 'git status'", 60],
      ["node watcher.mjs", 20],
    ]);
    expect(day?.starts).toBe(81);
    expect(day?.images.at(-1)).toMatchObject({ text: "C:\\old.exe", starts: 1 });
  });

  it("gives no ranking for an empty log", () => {
    new StartLogWriter(path).close();
    const db = openStartLog(path);
    expect(rankStarters(db, HOUR)).toBeNull();
    expect(startLogSpan(db)).toEqual({ from: null, to: null, starts: 0, exits: 0 });
    db.close();
  });
});
