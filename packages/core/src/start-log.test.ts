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
  slowStepCause,
  slowStepsBetween,
  START_LOG_KEEP_MS,
  START_LOG_SPREAD_EVERY_MS,
  startLogSpan,
  startLogSpreads,
  StartLogWriter,
  startsBetween,
  startsOfPid,
  type ExitRow,
  type SlowStep,
  type SlowStepContext,
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

describe("the slow steps of the writer (H199)", () => {
  /** A monotonic clock that moves `step` ms at each read, so a write or a copy takes `step` ms. */
  function clock(): { monotonic: () => number; step: number } {
    const state = { at: 0, step: 1, monotonic: () => (state.at += state.step) };
    return state;
  }
  const read = (): ReturnType<typeof slowStepsBetween> => {
    const db = openStartLog(path);
    try {
      return slowStepsBetween(db, 0, Number.MAX_SAFE_INTEGER);
    } finally {
      db.close();
    }
  };

  it("writes a commit with a slow lag in the next transaction, with the parts of its lag", () => {
    let now = T0;
    const time = clock();
    const writer = new StartLogWriter(path, { now: () => now, monotonic: time.monotonic });
    writer.write([row(T0, 1, null, "C:\\fast.exe", "fast")], []);
    expect(writer.stats().slowSteps).toBe(0);
    // The message came at T0, 50 ms after the creation. The commit begins 2 s later: the rows waited in the queue.
    now = T0 + 2 * S;
    writer.write([row(T0, 2, null, "C:\\late.exe", "late"), row(T0 + S, 3, null, "C:\\fast.exe", "fast")], [ended(T0 + S, 1, 0)]);
    expect(writer.stats().slowSteps).toBe(1);
    expect(read()).toEqual([]);
    writer.write([row(now, 4, null, "C:\\fast.exe", "fast")], []);
    expect(read()).toEqual([
      { at: T0 + 2 * S, kind: "commit", ms: 1, starts: 2, exits: 1, texts: 2, frames: null, checkpointed: null, lagMs: 2050, messageLagMs: 50, queuedMs: 2000 },
    ]);
    writer.close();
  });

  it("writes a slow commit when the writer closes, and counts it", () => {
    const time = clock();
    const writer = new StartLogWriter(path, { now: () => T0, monotonic: time.monotonic });
    time.step = 600;
    writer.write([row(T0, 1, null, "C:\\a.exe", "a")], []);
    const stats = writer.stats();
    writer.close();
    expect(stats).toMatchObject({ slowSteps: 1, slowestWriteMs: 600 });
    expect(read()).toMatchObject([{ kind: "commit", ms: 600, starts: 1, exits: 0, lagMs: 50, messageLagMs: 50, queuedMs: 0 }]);
  });

  it("copies the WAL into the file only when a commit came since the last copy, and writes a slow copy", () => {
    const time = clock();
    const writer = new StartLogWriter(path, { now: () => T0, monotonic: time.monotonic });
    expect(writer.checkpoint()).toBeNull();
    writer.write([row(T0, 1, null, "C:\\a.exe", "a")], []);
    const copy = writer.checkpoint();
    expect(copy?.frames).toBeGreaterThan(0);
    expect(copy?.checkpointed).toBe(copy?.frames);
    expect(writer.checkpoint()).toBeNull();
    writer.write([row(T0, 2, null, "C:\\a.exe", "a")], []);
    time.step = 700;
    const slow = writer.checkpoint();
    const stats = writer.stats();
    writer.close();
    expect(stats).toMatchObject({ checkpoints: 2, slowestCheckpointMs: 700, slowSteps: 1 });
    expect(read()).toEqual([
      { at: T0, kind: "checkpoint", ms: 700, starts: null, exits: null, texts: null, frames: slow?.frames, checkpointed: slow?.checkpointed, lagMs: null, messageLagMs: null, queuedMs: null },
    ]);
  });

  it("prunes the slow steps with the rows", () => {
    let now = T0;
    const time = clock();
    const writer = new StartLogWriter(path, { now: () => now, monotonic: time.monotonic });
    time.step = 600;
    writer.write([row(T0, 1, null, "C:\\a.exe", "a")], []);
    time.step = 1;
    for (let hour = 1; hour < 30; hour++) {
      now = T0 + hour * HOUR;
      writer.write([row(now, 100 + hour, 1, "C:\\a.exe", "a")], []);
    }
    expect(read()).toHaveLength(1);
    writer.prune();
    writer.close();
    expect(read()).toEqual([]);
  });

  it("gives no slow step for a file of an older version", () => {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE starts (at INTEGER NOT NULL)");
    expect(slowStepsBetween(db, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(startLogSpreads(db, 0, Number.MAX_SAFE_INTEGER)).toEqual({ from: null, to: null, lag: null, write: null });
    db.close();
  });

  it("refuses a file of a newer version, and does not hold the file open", () => {
    const newer = new DatabaseSync(path);
    newer.exec("PRAGMA user_version = 99");
    newer.close();
    expect(() => new StartLogWriter(path, { now: () => T0 })).toThrow(/schema version 99/);
    // On Windows, a folder with a file that a process holds open cannot be removed.
    expect(() => rmSync(folder, { recursive: true, force: true })).not.toThrow();
  });
});

describe("the spreads of the lag and of the commits (H199)", () => {
  const spreads = (from = 0, to = Number.MAX_SAFE_INTEGER): ReturnType<typeof startLogSpreads> => {
    const db = openStartLog(path);
    try {
      return startLogSpreads(db, from, to);
    } finally {
      db.close();
    }
  };
  /** A start row whose process was created `lag` ms before `end`, the time of the commit. */
  const lagged = (end: number, pid: number, lag: number): StartRow => ({ ...row(end, pid, null, "C:\\a.exe", "a"), created: msFiletime(end - lag) });

  it("gives the p50, the p99 and the longest of the lag and of the commit time since the start of the writer", () => {
    const time = { at: 0, step: 2 };
    const writer = new StartLogWriter(path, { now: () => T0, monotonic: () => (time.at += time.step) });
    expect(writer.stats()).toMatchObject({ lagSpread: null, writeSpread: null });
    // 100 starts with a lag of 1 to 100 ms, in 10 commits of 2 ms each.
    for (let batch = 0; batch < 10; batch++) {
      writer.write(Array.from({ length: 10 }, (_, i) => lagged(T0, batch * 10 + i + 1, batch * 10 + i + 1)), []);
    }
    const stats = writer.stats();
    writer.close();
    expect(stats.lagSpread?.count).toBe(100);
    expect(stats.lagSpread?.max).toBe(100);
    expect(Math.abs((stats.lagSpread?.p50 ?? 0) - 50)).toBeLessThanOrEqual(0.5);
    expect(Math.abs((stats.lagSpread?.p99 ?? 0) - 99)).toBeLessThanOrEqual(1);
    expect(stats.writeSpread).toEqual({ count: 10, p50: 2, p99: 2, max: 2 });
  });

  it("does not count an adoption or a row with no creation time in the lag", () => {
    const writer = new StartLogWriter(path, { now: () => T0 });
    writer.write([lagged(T0, 1, 30), lagged(T0, 2, 5 * S), { ...row(T0, 3, null, "C:\\a.exe", "a"), created: null }], []);
    const stats = writer.stats();
    writer.close();
    expect(stats.lagSpread).toEqual({ count: 1, p50: 30, p99: 30, max: 30 });
  });

  it("writes the histograms of each 10 minutes, and the last ones when the writer closes", () => {
    let now = T0;
    const writer = new StartLogWriter(path, { now: () => now });
    writer.write([lagged(now, 1, 40)], []);
    now = T0 + 5 * MIN;
    writer.write([lagged(now, 2, 60)], []);
    expect(spreads().lag).toBeNull();
    // The first commit after 10 minutes writes the rows of the first 10 minutes. Its own rows go to the next time.
    now = T0 + START_LOG_SPREAD_EVERY_MS;
    writer.write([lagged(now, 3, 900)], []);
    const first = spreads();
    expect(first).toMatchObject({ from: T0, to: T0 + START_LOG_SPREAD_EVERY_MS, lag: { count: 2, max: 60 }, write: { count: 2 } });
    now = T0 + START_LOG_SPREAD_EVERY_MS + MIN;
    writer.close();
    expect(spreads()).toMatchObject({ from: T0, to: now, lag: { count: 3, max: 900 }, write: { count: 3 } });
    // A span that starts after the first rows gives only the last ones.
    expect(spreads(T0 + START_LOG_SPREAD_EVERY_MS + 1).lag).toMatchObject({ count: 1, max: 900 });
  });

  it("merges the histograms of two writers: a restart of the daemon keeps the spread of the span", () => {
    const first = new StartLogWriter(path, { now: () => T0 });
    first.write(Array.from({ length: 50 }, (_, i) => lagged(T0, i + 1, 10)), []);
    first.close();
    const second = new StartLogWriter(path, { now: () => T0 + HOUR });
    second.write(Array.from({ length: 50 }, (_, i) => lagged(T0 + HOUR, 100 + i, 1000)), []);
    second.close();
    const both = spreads();
    expect(both.lag?.count).toBe(100);
    expect(both.lag?.max).toBe(1000);
    expect(Math.abs((both.lag?.p50 ?? 0) - 10)).toBeLessThanOrEqual(0.2);
    expect(Math.abs((both.lag?.p99 ?? 0) - 1000)).toBeLessThanOrEqual(10);
  });

  it("skips a row of another shape, and prunes the rows with the starts", () => {
    let now = T0;
    const writer = new StartLogWriter(path, { now: () => now });
    writer.write([lagged(now, 1, 20)], []);
    for (let hour = 1; hour < 30; hour++) {
      now = T0 + hour * HOUR;
      writer.write([lagged(now, 100 + hour, 20)], []);
    }
    writer.prune();
    writer.close();
    const db = new DatabaseSync(path);
    const oldest = db.prepare("SELECT min(at) AS at FROM spreads").get() as { at: number };
    db.prepare("INSERT INTO spreads (at, since, kind, n, p50, p99, max, histogram) VALUES (?, ?, 'lag', 1, 1, 1, 1, ?)").run(now + 1, now, "{\"n\":1}");
    db.close();
    expect(oldest.at).toBe(now - START_LOG_KEEP_MS);
    // The rows of the last hour: the commits at 27 h and at 28 h, and the last commit at the close.
    expect(spreads(now - HOUR).lag).toMatchObject({ count: 3, max: 20 });
  });
});

describe("the cause of a slow step (H199)", () => {
  const commit = (parts: Partial<SlowStep>): SlowStep => ({
    at: T0, kind: "commit", ms: 3, starts: 4, exits: 2, texts: 1, frames: null, checkpointed: null, lagMs: 2327, messageLagMs: 60, queuedMs: 200, ...parts,
  });
  const context: SlowStepContext = { memoryFreeMb: 1536, commitFreeMb: 10_610, coresUsed: 15.42, cores: 16, tracedPerMinute: 2395.8 };

  it("names the largest part of the lag of a commit, with the state of the system", () => {
    expect(slowStepCause(commit({ ms: 1564, lagMs: 1700 }), context)).toEqual({
      kind: "slow-commit",
      text: "The commit itself was slow: 1,564 ms of the lag of 1,700 ms, for 4 starts, 2 exits and 1 new texts. In that minute: 1.5 GB of memory free, 10.4 GB of commit free, 15.4 of 16 cores in use, 2,396 traced starts a minute.",
    });
    expect(slowStepCause(commit({ messageLagMs: 2100 }))).toEqual({ kind: "late-message", text: "The message of the job came late: 2,100 ms of the lag of 2,327 ms passed before the reader got it." });
    expect(slowStepCause(commit({ queuedMs: 1900 })).kind).toBe("queued");
    expect(slowStepCause(commit({ queuedMs: 1900 })).text).toBe("The rows waited in the reader: 1,900 ms of the lag of 2,327 ms passed before the commit started.");
  });

  it("names a slow copy of the WAL and a slow prune, and leaves out a sample that is not there", () => {
    const step = (kind: SlowStep["kind"]): SlowStep => ({ ...commit({}), kind, ms: 812, starts: 900, exits: 880, texts: 12, frames: 1440, lagMs: null, messageLagMs: null, queuedMs: null });
    expect(slowStepCause(step("checkpoint"), { ...context, commitFreeMb: null, coresUsed: null, tracedPerMinute: null })).toEqual({
      kind: "checkpoint",
      text: "The copy of the WAL took 812 ms for 1,440 pages. In that minute: 1.5 GB of memory free.",
    });
    expect(slowStepCause(step("prune"))).toEqual({ kind: "prune", text: "The prune took 812 ms for 1,780 rows and 12 texts." });
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
