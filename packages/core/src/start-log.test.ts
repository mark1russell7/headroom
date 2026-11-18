import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { random } from "@mark1russell7/rigor-generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filetimeMs,
  lastStartBefore,
  msFiletime,
  openStartLog,
  parentsOf,
  rankStarters,
  START_LOG_EXIT_SPAN_MS,
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

  it("counts an adoption apart: no start, no lag and no place in the ranking", () => {
    let now = T0;
    const writer = new StartLogWriter(path, { now: () => now });
    // At the start of the daemon, the trace puts the live processes in jobs. This claude.exe ran for 2 hours.
    const adopted = row(T0, 10, 1, "C:\\claude.exe", "claude", { created: msFiletime(T0 - 2 * HOUR) });
    writer.write([adopted, row(T0, 12, 10, "C:\\git.exe", "git status")], []);
    // The engine put this process in a job 900 ms after its creation: it is a new process.
    now = T0 + S;
    writer.write([row(T0 + S, 11, 10, "C:\\bash.exe", "bash", { created: msFiletime(T0 + 100) })], []);
    const stats = writer.stats();
    writer.close();
    expect(stats).toMatchObject({ starts: 2, withCommand: 2, withCreated: 2, adopted: 1 });
    // git.exe: created at T0 - 50, on the disk at T0. bash.exe: created at T0 + 100, on the disk at T0 + 1000.
    expect(stats.slowestLagMs).toBe(900);
    const db = openStartLog(path);
    const ranking = rankStarters(db, HOUR);
    const [claude] = startsOfPid(db, 10);
    const [git] = startsOfPid(db, 12);
    db.close();
    expect(ranking).toMatchObject({ starts: 2, adopted: 1, reusedUnder60s: 0 });
    expect(ranking?.images.map((each) => each.text).sort()).toEqual(["C:\\bash.exe", "C:\\git.exe"]);
    expect(claude?.adopted).toBe(true);
    expect(git?.adopted).toBe(false);
  });

  it("gives no ranking for an empty log", () => {
    new StartLogWriter(path).close();
    const db = openStartLog(path);
    expect(rankStarters(db, HOUR)).toBeNull();
    expect(startLogSpan(db)).toEqual({ from: null, to: null, starts: 0, exits: 0 });
    db.close();
  });
});

describe("the search of the exits of a batch (H206)", () => {
  /**
   * A log of 40 minutes from a seed: 30 pids, so each pid gets new processes. Some exits come more than the span of the
   * batch after their start, some have no creation time, and some have the creation time of another process.
   */
  function randomLog(seed: string): void {
    const draw = random(seed);
    const starts: StartRow[] = [];
    const exits: ExitRow[] = [];
    let at = T0;
    while (at < T0 + 40 * MIN) {
      at += draw.int(1, 4000);
      const pid = draw.int(1, 30);
      const start = row(at, pid, draw.int(1, 30), "C:\x.exe", `x ${pid}`, draw.chance(0.1) ? { created: null } : {});
      starts.push(start);
      if (draw.chance(0.15)) continue;
      const life = draw.chance(0.2) ? draw.int(START_LOG_EXIT_SPAN_MS, 3 * START_LOG_EXIT_SPAN_MS) : draw.int(0, 30 * S);
      const created = draw.chance(0.2) ? null : draw.chance(0.05) ? msFiletime(at + 7) : start.created;
      exits.push(ended(at + life, pid, draw.int(0, 2), created));
    }
    exits.sort((a, b) => a.at - b.at);
    // The writer gets the rows in the order of time, in batches of 20 seconds, as the reader thread writes them.
    const writer = new StartLogWriter(path, { now: () => T0 });
    for (let from = T0; from < T0 + 80 * MIN; from += 20 * S) {
      const inBatch = (each: { at: number }): boolean => each.at >= from && each.at < from + 20 * S;
      writer.write(starts.filter(inBatch), exits.filter(inBatch));
    }
    writer.close();
  }

  it("gives the exits of the search of one start, for 20 seeds", () => {
    for (let seed = 1; seed <= 20; seed++) {
      randomLog(`h206-${seed}`);
      const db = openStartLog(path);
      const draw = random(`h206-window-${seed}`);
      const from = T0 + draw.int(0, 30 * MIN);
      const batch = startsBetween(db, from, from + draw.int(0, 10 * MIN));
      expect(batch.length).toBeGreaterThan(0);
      for (const start of batch) {
        // `startsOfPid` keeps the search of one start: the reference.
        const one = startsOfPid(db, start.pid, 10_000).find((each) => each.at === start.at && each.created === start.created);
        expect(start.exit, `seed ${seed}, pid ${start.pid} at ${start.at - T0} ms`).toEqual(one?.exit);
      }
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("reads no row after `until`: an exit of the next boot is not the exit of an old process with its pid", () => {
    const writer = new StartLogWriter(path, { now: () => T0 });
    writer.write([row(T0, 7, 1, "C:\old.exe", "old")], []);
    // The boot after a bugcheck: a new process 7, and an exit of pid 7 with no creation time.
    writer.write([row(T0 + 10 * MIN, 7, 1, "C:\new.exe", "new", { created: msFiletime(T0 + 9 * MIN) })], [ended(T0 + 11 * MIN, 7, 0)]);
    writer.close();
    const db = openStartLog(path);
    expect(startsBetween(db, T0, T0, undefined, T0)).toMatchObject([{ command: "old", exit: null }]);
    // With no end, the next start of pid 7 comes before the exit, so the exit is not of the old process either.
    expect(startsBetween(db, T0, T0)).toMatchObject([{ command: "old", exit: null }]);
    db.close();
  });

  it("gives the newest start before a time with a binary search", () => {
    const writer = new StartLogWriter(path, { now: () => T0 });
    writer.write([row(T0, 1, null, null, null), row(T0 + S, 2, null, null, null)], []);
    writer.write([row(T0 + 5 * S, 3, null, null, null)], []);
    writer.close();
    const db = openStartLog(path);
    expect(lastStartBefore(db, T0)).toBeNull();
    expect(lastStartBefore(db, T0 + 1)).toBe(T0);
    expect(lastStartBefore(db, T0 + 5 * S)).toBe(T0 + S);
    expect(lastStartBefore(db, T0 + HOUR)).toBe(T0 + 5 * S);
    db.close();
  });
});
