/**
 * The start log (H193): each new process of the start trace and each end, in its own SQLite file with the pragma
 * `synchronous` FULL. A commit is on the disk when it ends, so the rows stay after a bugcheck or a power cut. The reader
 * thread of the trace (`trace-reader.ts`) writes it, at most `START_LOG_WRITE_EVERY_MS` after the message of the job.
 *
 * - A start row has the pid, the parent and the exact creation time: a FILETIME, to join with a crash dump. It also has
 *   the image, the command line, the command line of the parent and the time since a traced process with the pid ended.
 * - The table `texts` keeps each image and command line once. A row names its texts by id.
 * - Each text gets the redaction of H186 (`redact.ts`) before the file keeps it. Step 2 of the schema redacts the texts
 *   of an older file.
 * - The file has no index of its own. The rows come in the order of time, so a search by time is a binary search on the
 *   rowid. Each index costs writes of pages at each commit.
 * - The log keeps 24 hours, counted back from its newest row. Thus a long stop after a crash does not empty it.
 * - It covers only the processes of the trace: the jobs of the traced owner kinds.
 * - The writer copies the WAL into the file in a step of its own, after a commit (H199). Thus a slow copy does not delay the
 *   rows of a commit, and its time is known. SQLite copies it in a commit only as a last resort, at `BACKSTOP_FRAMES`.
 * - Each step of the writer (a commit, a copy of the WAL or a prune) that takes more than `START_LOG_SLOW_MS` gets a row
 *   in the table `slow_steps` (H199). A commit with a lag above that time gets a row too. The row splits the lag into its
 *   parts, so it shows the cause. The next transaction writes the row, so it costs no sync of its own.
 * - The writer keeps a histogram of the lag of each new process and one of the time of each commit (H199). Each
 *   `START_LOG_SPREAD_EVERY_MS`, a commit also writes the histograms of the time since the last row of the table
 *   `spreads`. A merge of these rows gives the quantiles of any time, also across restarts of the daemon.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  addAllToHistogram,
  addToHistogram,
  emptyHistogram,
  histogramQuantile,
  mergeHistograms,
  type Histogram,
  type HistogramBucket,
} from "@mark1russell7/rigor-statistics";
import { migrate, openDatabase, transaction, type Migration } from "@mark1russell7/sqlite";
import { redactCommand } from "./redact.ts";

/** The time that the log keeps, counted back from its newest row. */
export const START_LOG_KEEP_MS = 86_400_000;
/** The longest time from the message of a job to the commit of its row. The 4 crashes came 251 ms to 525 ms after the creation. */
export const START_LOG_WRITE_EVERY_MS = 100;
/** The time between two prunes of the writer. */
export const START_LOG_PRUNE_EVERY_MS = 600_000;
/** The longest time from the exit of a pid to its next start that a start row keeps as `reuseMs`. */
export const START_LOG_REUSE_MS = 60_000;
/** The writer writes the time of the use of a text at most once in this time. So a prune keeps the texts of this time more. */
const TOUCH_EVERY_MS = 3_600_000;
/** The most texts in the memory of the writer. */
const CACHED_TEXTS = 20_000;
/** The difference between the epoch of a FILETIME (1601) and the Unix epoch, in units of 100 ns. */
const FILETIME_UNIX = 116_444_736_000_000_000n;
/**
 * A start row whose message comes more than this time after the creation of its process is an adoption. The engine put a
 * process that ran before into a job, for example each live process at the start of the daemon. An adoption is no start,
 * so the counts of starts, the lag and the ranking do not count it. A process that the engine puts in a job less than
 * 1 s after its creation counts as a start: it is a new process.
 */
export const START_LOG_ADOPT_MS = 1_000;
/** A step of the writer that takes more time than this, or a commit with a lag above it, gets a row in `slow_steps`. */
export const START_LOG_SLOW_MS = 500;
/**
 * The time between two copies of the WAL into the file. The trace writes at most 10 commits a second, of a few pages each.
 * Thus a copy has fewer than 1,000 pages, the point where SQLite copies by default.
 */
export const START_LOG_CHECKPOINT_EVERY_MS = 10_000;
/** The count of pages in the WAL where SQLite copies it in a commit. It is a backstop for a writer that does not copy. */
const BACKSTOP_FRAMES = 10_000;
/** The most slow steps that wait in the memory for the next transaction. An older one goes when a new one comes. */
const PENDING_SLOW = 1_000;
/**
 * The time of the histograms in one row of `spreads` (H199). A commit after this time since the last row writes the next
 * rows. A row of 10 minutes is small, and a bugcheck loses at most the histograms of 10 minutes.
 */
export const START_LOG_SPREAD_EVERY_MS = 600_000;

/**
 * This function gives the SQL test of an adoption over the columns of `starts`. It reads only the stored time and creation
 * time, so it applies to each file, also to the rows of an older version.
 */
function adoptedSql(prefix: "" | "s."): string {
  return `(${prefix}created IS NOT NULL AND ${prefix}at - (${prefix}created - ${FILETIME_UNIX}) / 10000 > ${START_LOG_ADOPT_MS})`;
}

/** A new process, as the reader writes it. */
export interface StartRow {
  /** The time when the reader got the message of the job, in ms since the Unix epoch. */
  readonly at: number;
  /** The key of the job of the trace. */
  readonly key: number;
  readonly pid: number;
  readonly ppid: number | null;
  /** The creation time of the process: a FILETIME, in units of 100 ns since 1601. A crash dump has the same value. */
  readonly created: bigint | null;
  /** The full path of the program. */
  readonly image: string | null;
  readonly command: string | null;
  /** The command line of the parent, when the reader could read it. */
  readonly parentCommand: string | null;
  /** The time from the exit of the last traced process with the same pid to this creation, under `START_LOG_REUSE_MS`. */
  readonly reuseMs: number | null;
}

/** The end of a process, as the reader writes it. */
export interface ExitRow {
  readonly at: number;
  readonly key: number;
  readonly pid: number;
  readonly exitCode: number | null;
  /**
   * The creation time of the process that ended, when the reader held its handle. A process is its pid and its creation
   * time. An exit joins its start by both, also when a new process gets the pid in the same ms.
   */
  readonly created: bigint | null;
}

/** The facts of the writer since its start. The trace gives them to the status. */
export interface StartLogStats {
  readonly path: string;
  /** The start rows of new processes that the writer wrote. An adoption does not count. */
  readonly starts: number;
  /** The start rows of new processes with a command line. */
  readonly withCommand: number;
  /** The start rows of new processes with a creation time. */
  readonly withCreated: number;
  /** The start rows of adoptions: processes that ran before the trace put them in a job (`START_LOG_ADOPT_MS`). */
  readonly adopted: number;
  readonly exits: number;
  readonly commits: number;
  /** The time of all the commits, in ms. */
  readonly writeMs: number;
  /** The longest commit, in ms. */
  readonly slowestWriteMs: number;
  /** The longest time from the creation of a new process to the commit of its row, in ms: what a bugcheck can lose. */
  readonly slowestLagMs: number;
  /** The copies of the WAL into the file. */
  readonly checkpoints: number;
  /** The longest copy of the WAL, in ms. */
  readonly slowestCheckpointMs: number;
  /** The steps with a row in `slow_steps`: each step above `START_LOG_SLOW_MS`, and each commit with a lag above it. */
  readonly slowSteps: number;
  /**
   * The spread of the time from the creation of each new process to the commit of its row, since the start of the writer
   * (H199). `null` before the first new process with a creation time. An older trace gives no field.
   */
  readonly lagSpread?: StartLogSpread | null;
  /** The spread of the time of each commit since the start of the writer (H199). `null` before the first commit. */
  readonly writeSpread?: StartLogSpread | null;
  /** The reason when the writer stopped with an error, or `null` while it writes. */
  readonly failure: string | null;
}

/** The kinds of the histograms of the writer: the lag of each new process, and the time of each commit. */
export type SpreadKind = "lag" | "write";

/**
 * The spread of a histogram (H199), in ms. The quantiles have the relative error of the histogram (1 %), and the
 * nearest-rank rule of rigor-statistics. `max` is exact.
 */
export interface StartLogSpread {
  /** The count of the values. */
  readonly count: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

/** This function gives the spread of a histogram, rounded to 0.1 ms, or `null` for an empty histogram. */
export function spreadOf(histogram: Histogram): StartLogSpread | null {
  if (histogram.n === 0) return null;
  const tenth = (value: number): number => Math.round(value * 10) / 10;
  return {
    count: histogram.n,
    p50: tenth(histogramQuantile(histogram, 0.5)),
    p99: tenth(histogramQuantile(histogram, 0.99)),
    max: tenth(histogram.max),
  };
}

/** The kinds of the steps of the writer. */
export type SlowStepKind = "commit" | "checkpoint" | "prune";

/**
 * A slow step of the writer (H199). Each part of the lag of a commit is a column, so the row shows the cause:
 *
 * - `messageLagMs` large: the message of the job came late. The system was slow before the reader got it.
 * - `queuedMs` large: the rows waited in the reader before the commit started, for example after a slow step before.
 * - `ms` large: the commit itself was slow. Many `texts` is a large write. Few is a slow disk.
 */
export interface SlowStep {
  /** The end of the step, in ms since the Unix epoch. */
  readonly at: number;
  readonly kind: SlowStepKind;
  /** The time of the step, in ms. */
  readonly ms: number;
  /** A commit: the start rows that it wrote. A prune: the start rows that it deleted. */
  readonly starts: number | null;
  /** A commit: the exit rows that it wrote. A prune: the exit rows that it deleted. */
  readonly exits: number | null;
  /** A commit: the new texts that it wrote. A prune: the texts that it deleted. */
  readonly texts: number | null;
  /** A copy of the WAL: the pages in the WAL. */
  readonly frames: number | null;
  /** A copy of the WAL: the pages that it copied into the file. */
  readonly checkpointed: number | null;
  /** A commit: the longest time from the creation of a new process to the end of the commit. */
  readonly lagMs: number | null;
  /** A commit: the longest time from the creation of a new process to the message of its job. */
  readonly messageLagMs: number | null;
  /** A commit: the time from the oldest message of its rows to the start of the commit. */
  readonly queuedMs: number | null;
}

/**
 * The steps of the schema (@mark1russell7/sqlite). The user_version of the file is the count of its steps. Each change
 * of the schema is a new step at the end.
 */
const MIGRATIONS: readonly Migration<DatabaseSync>[] = [
  `CREATE TABLE texts (id INTEGER PRIMARY KEY, hash INTEGER UNIQUE, text TEXT NOT NULL, last INTEGER NOT NULL);
   CREATE TABLE starts (at INTEGER NOT NULL, key INTEGER NOT NULL, pid INTEGER NOT NULL, ppid INTEGER, created INTEGER,
     image INTEGER, command INTEGER, parent_command INTEGER, reuse_ms INTEGER);
   CREATE TABLE exits (at INTEGER NOT NULL, key INTEGER NOT NULL, pid INTEGER NOT NULL, code INTEGER, created INTEGER);`,
  redactTexts,
  `CREATE TABLE slow_steps (at INTEGER NOT NULL, kind TEXT NOT NULL, ms REAL NOT NULL, starts INTEGER, exits INTEGER, texts INTEGER,
     frames INTEGER, checkpointed INTEGER, lag_ms INTEGER, message_lag_ms INTEGER, queued_ms INTEGER);`,
  `CREATE TABLE spreads (at INTEGER NOT NULL, since INTEGER NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, p50 REAL NOT NULL,
     p99 REAL NOT NULL, max REAL NOT NULL, histogram TEXT NOT NULL);`,
];

/** This function gives the first 8 bytes of the SHA-256 of a text, as a signed 64-bit integer. */
function textHash(text: string): bigint {
  return createHash("sha256").update(text).digest().readBigInt64LE(0);
}

/**
 * Step 2 of the schema (H186). The first version of the log kept each text as it came, so a text can hold a secret. This
 * step gives the redacted text to each text that the redaction changes. When another text has the hash of the new text,
 * the changed text gets no hash, as in `#textId`.
 */
function redactTexts(db: DatabaseSync): void {
  const taken = db.prepare("SELECT id FROM texts WHERE hash = ? AND id <> ?");
  const update = db.prepare("UPDATE texts SET text = ?, hash = ? WHERE id = ?");
  for (const { id, text } of db.prepare("SELECT id, text FROM texts").all() as { id: number; text: string }[]) {
    const stored = redactCommand(text);
    if (stored === text) continue;
    const hash = textHash(stored);
    update.run(stored, taken.get(hash, id) === undefined ? hash : null, id);
  }
}

/** This function gives the Unix time in ms of a FILETIME. */
export function filetimeMs(filetime: bigint): number {
  return Number((filetime - FILETIME_UNIX) / 10_000n);
}

/** This function gives the FILETIME of a Unix time in ms. */
export function msFiletime(ms: number): bigint {
  return BigInt(Math.round(ms)) * 10_000n + FILETIME_UNIX;
}

/** The tables of the log. A name goes into SQL, so it comes only from this list. */
type LogTable = "starts" | "exits" | "slow_steps" | "spreads";

/**
 * This function gives the last rowid of a table with `at` before `cutoff`, or `null`. The rows come in the order of
 * time, so it is a binary search on the rowid. A probe reads the first row at or after a rowid, because a prune leaves a
 * gap at the start.
 */
function lastRowBefore(db: DatabaseSync, table: LogTable, cutoff: number): number | null {
  const bounds = db.prepare(`SELECT min(rowid) AS low, max(rowid) AS high FROM ${table}`).get() as { low: number | null; high: number | null };
  if (bounds.low === null || bounds.high === null) return null;
  const probe = db.prepare(`SELECT rowid AS id, at FROM ${table} WHERE rowid >= ? ORDER BY rowid LIMIT 1`);
  let low = bounds.low;
  let high = bounds.high;
  let answer: number | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const row = probe.get(middle) as { id: number; at: number } | undefined;
    if (row === undefined) break;
    if (row.at < cutoff) {
      answer = row.id;
      low = row.id + 1;
    } else high = middle - 1;
  }
  return answer;
}

/** This function gives the first rowid of a table with `at` at or after `from`, or 0 when all the rows are before it. */
function firstRowFrom(db: DatabaseSync, table: LogTable, from: number): number {
  const before = lastRowBefore(db, table, from);
  return before === null ? 0 : before + 1;
}

/** The options of the writer. */
export interface StartLogWriterOptions {
  /** The clock. A test gives its own. */
  readonly now?: (() => number) | undefined;
  /** The monotonic clock that times each step, in ms (`performance.now` by default). A test gives its own. */
  readonly monotonic?: (() => number) | undefined;
  readonly keepMs?: number | undefined;
}

/** The writer of the log. Only the reader thread of the trace makes one. */
export class StartLogWriter {
  readonly #path: string;
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #monotonic: () => number;
  readonly #keepMs: number;
  readonly #insertStart: StatementSync;
  readonly #insertExit: StatementSync;
  readonly #findText: StatementSync;
  readonly #insertText: StatementSync;
  readonly #touchText: StatementSync;
  readonly #insertSlow: StatementSync;
  readonly #insertSpread: StatementSync;
  /** The id of each text and the time of its last use in the file, by its text. */
  readonly #texts = new Map<string, { id: number; last: number }>();
  /** The slow steps that wait for the next transaction. */
  #pendingSlow: SlowStep[] = [];
  #newTexts = 0;
  #starts = 0;
  #withCommand = 0;
  #withCreated = 0;
  #adopted = 0;
  #exits = 0;
  #commits = 0;
  /** The commits at the last copy of the WAL. */
  #commitsAtCheckpoint = 0;
  #writeMs = 0;
  #slowestWriteMs = 0;
  #slowestLagMs = 0;
  #checkpoints = 0;
  #slowestCheckpointMs = 0;
  #slowSteps = 0;
  /** The histograms since the start of the writer. */
  #lag: Histogram = emptyHistogram();
  #write: Histogram = emptyHistogram();
  /** The histograms since the last rows of `spreads`, and the start of their time. */
  #periodLag: Histogram = emptyHistogram();
  #periodWrite: Histogram = emptyHistogram();
  #periodSince: number;

  constructor(path: string, options: StartLogWriterOptions = {}) {
    this.#path = path;
    this.#now = options.now ?? Date.now;
    this.#monotonic = options.monotonic ?? (() => performance.now());
    this.#keepMs = options.keepMs ?? START_LOG_KEEP_MS;
    this.#periodSince = this.#now();
    this.#db = openDatabase(path, { synchronous: "FULL", busyTimeoutMs: 1000, makeFolder: true });
    // A step of the migration or a statement can fail. Then the writer closes the file, so the file is not held open.
    try {
      migrate(this.#db, MIGRATIONS);
      this.#db.exec(`PRAGMA wal_autocheckpoint = ${BACKSTOP_FRAMES}`);
      this.#insertStart = this.#db.prepare(
        "INSERT INTO starts (at, key, pid, ppid, created, image, command, parent_command, reuse_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      this.#insertExit = this.#db.prepare("INSERT INTO exits (at, key, pid, code, created) VALUES (?, ?, ?, ?, ?)");
      this.#findText = this.#db.prepare("SELECT id, text, last FROM texts WHERE hash = ?");
      this.#insertText = this.#db.prepare("INSERT INTO texts (hash, text, last) VALUES (?, ?, ?)");
      this.#touchText = this.#db.prepare("UPDATE texts SET last = ? WHERE id = ?");
      this.#insertSlow = this.#db.prepare(
        `INSERT INTO slow_steps (at, kind, ms, starts, exits, texts, frames, checkpointed, lag_ms, message_lag_ms, queued_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      this.#insertSpread = this.#db.prepare("INSERT INTO spreads (at, since, kind, n, p50, p99, max, histogram) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  /**
   * This function writes the histograms since the last rows of `spreads`, and starts the next time. It runs inside a
   * transaction. An empty histogram gets no row.
   */
  #flushSpreads(at: number): void {
    for (const [kind, histogram] of [["lag", this.#periodLag], ["write", this.#periodWrite]] as const) {
      const spread = spreadOf(histogram);
      if (spread === null) continue;
      this.#insertSpread.run(at, this.#periodSince, kind, spread.count, spread.p50, spread.p99, spread.max, JSON.stringify(histogram));
    }
    this.#periodLag = emptyHistogram();
    this.#periodWrite = emptyHistogram();
    this.#periodSince = at;
  }

  /** This function keeps a slow step for the next transaction. */
  #slow(step: SlowStep): void {
    this.#slowSteps++;
    if (this.#pendingSlow.length >= PENDING_SLOW) this.#pendingSlow.shift();
    this.#pendingSlow.push(step);
  }

  /** This function writes the slow steps that wait. It runs inside a transaction. */
  #flushSlow(): void {
    for (const s of this.#pendingSlow) {
      this.#insertSlow.run(s.at, s.kind, s.ms, s.starts, s.exits, s.texts, s.frames, s.checkpointed, s.lagMs, s.messageLagMs, s.queuedMs);
    }
  }

  /**
   * This function gives the id of a text, and writes the text when the file does not have it. The file keeps the text only
   * after the redaction of H186. The memory keeps the id under the text as it came, so a known text costs no redaction.
   */
  #textId(text: string | null, now: number): number | null {
    if (text === null) return null;
    const cached = this.#texts.get(text);
    if (cached !== undefined) {
      if (now - cached.last >= TOUCH_EVERY_MS) {
        this.#touchText.run(now, cached.id);
        cached.last = now;
      }
      return cached.id;
    }
    const stored = redactCommand(text);
    const hash = textHash(stored);
    const found = this.#findText.get(hash) as { id: number; text: string; last: number } | undefined;
    let entry: { id: number; last: number };
    if (found !== undefined && found.text === stored) {
      entry = { id: found.id, last: found.last };
      if (now - found.last >= TOUCH_EVERY_MS) {
        this.#touchText.run(now, found.id);
        entry.last = now;
      }
    } else {
      // A different text with the same hash gets no hash, so the search never finds it. The memory still finds it.
      entry = { id: Number(this.#insertText.run(found === undefined ? hash : null, stored, now).lastInsertRowid), last: now };
      this.#newTexts++;
    }
    if (this.#texts.size >= CACHED_TEXTS) this.#texts.clear();
    this.#texts.set(text, entry);
    return entry.id;
  }

  /**
   * This function writes the rows in one transaction, with the slow steps that wait. When it ends, the rows are on the
   * disk. A commit above `START_LOG_SLOW_MS`, or with a lag above it, waits for the next transaction as a slow step.
   */
  write(starts: readonly StartRow[], exits: readonly ExitRow[]): void {
    if (starts.length === 0 && exits.length === 0) return;
    const begin = this.#monotonic();
    const now = this.#now();
    const textsBefore = this.#newTexts;
    const spreadsDue = now - this.#periodSince >= START_LOG_SPREAD_EVERY_MS;
    transaction(this.#db, () => {
      for (const row of starts) {
        this.#insertStart.run(
          row.at, row.key, row.pid, row.ppid, row.created,
          this.#textId(row.image, now), this.#textId(row.command, now), this.#textId(row.parentCommand, now), row.reuseMs,
        );
      }
      for (const row of exits) this.#insertExit.run(row.at, row.key, row.pid, row.exitCode, row.created);
      this.#flushSlow();
      if (spreadsDue) this.#flushSpreads(now);
    });
    this.#pendingSlow = [];
    const ms = this.#monotonic() - begin;
    const end = this.#now();
    this.#commits++;
    this.#writeMs += ms;
    this.#slowestWriteMs = Math.max(this.#slowestWriteMs, ms);
    this.#exits += exits.length;
    let lagMs: number | null = null;
    let messageLagMs: number | null = null;
    const lags: number[] = [];
    let oldest = Infinity;
    for (const row of exits) oldest = Math.min(oldest, row.at);
    for (const row of starts) {
      oldest = Math.min(oldest, row.at);
      const createdMs = row.created === null ? null : filetimeMs(row.created);
      // The age of an adopted process is no delay of the log (2026-11-17: 4,956,209 ms at the start of the daemon).
      if (createdMs !== null && row.at - createdMs > START_LOG_ADOPT_MS) {
        this.#adopted++;
        continue;
      }
      this.#starts++;
      if (row.command !== null) this.#withCommand++;
      if (createdMs === null) continue;
      this.#withCreated++;
      lags.push(end - createdMs);
      lagMs = Math.max(lagMs ?? -Infinity, end - createdMs);
      messageLagMs = Math.max(messageLagMs ?? -Infinity, row.at - createdMs);
    }
    if (lagMs !== null) this.#slowestLagMs = Math.max(this.#slowestLagMs, lagMs);
    this.#lag = addAllToHistogram(this.#lag, lags);
    this.#periodLag = addAllToHistogram(this.#periodLag, lags);
    this.#write = addToHistogram(this.#write, ms);
    this.#periodWrite = addToHistogram(this.#periodWrite, ms);
    if (ms <= START_LOG_SLOW_MS && (lagMs === null || lagMs <= START_LOG_SLOW_MS)) return;
    this.#slow({
      at: end,
      kind: "commit",
      ms: Math.round(ms * 10) / 10,
      starts: starts.length,
      exits: exits.length,
      texts: this.#newTexts - textsBefore,
      frames: null,
      checkpointed: null,
      lagMs: lagMs === null ? null : Math.round(lagMs),
      messageLagMs: messageLagMs === null ? null : Math.round(messageLagMs),
      queuedMs: Math.max(0, Math.round(now - oldest)),
    });
  }

  /**
   * This function copies the pages of the WAL into the file, with no wait for a reader (a PASSIVE checkpoint). The caller
   * runs it after a commit, so a slow copy does not delay the rows of the commit. It does nothing when no commit came
   * since the last copy. It gives the pages in the WAL and the pages that it copied, or `null` for no copy.
   */
  checkpoint(): { readonly frames: number; readonly checkpointed: number } | null {
    if (this.#commits === this.#commitsAtCheckpoint) return null;
    const begin = this.#monotonic();
    const row = this.#db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy: number; log: number; checkpointed: number };
    const ms = this.#monotonic() - begin;
    this.#commitsAtCheckpoint = this.#commits;
    this.#checkpoints++;
    this.#slowestCheckpointMs = Math.max(this.#slowestCheckpointMs, ms);
    const result = { frames: row.log, checkpointed: row.checkpointed };
    if (ms > START_LOG_SLOW_MS) {
      this.#slow({
        at: this.#now(), kind: "checkpoint", ms: Math.round(ms * 10) / 10, starts: null, exits: null, texts: null,
        frames: result.frames, checkpointed: result.checkpointed, lagMs: null, messageLagMs: null, queuedMs: null,
      });
    }
    return result;
  }

  /**
   * This function deletes the rows older than the keep time before the newest row, and the texts that no kept row can
   * name. It gives the counts of the deleted rows.
   */
  prune(): { readonly starts: number; readonly exits: number; readonly texts: number } {
    const newest = Math.max(
      (this.#db.prepare("SELECT at FROM starts ORDER BY rowid DESC LIMIT 1").get() as { at: number } | undefined)?.at ?? 0,
      (this.#db.prepare("SELECT at FROM exits ORDER BY rowid DESC LIMIT 1").get() as { at: number } | undefined)?.at ?? 0,
    );
    if (newest === 0) return { starts: 0, exits: 0, texts: 0 };
    const cutoff = newest - this.#keepMs;
    const begin = this.#monotonic();
    const result = transaction(this.#db, () => {
      const count = (table: LogTable): number => {
        const last = lastRowBefore(this.#db, table, cutoff);
        return last === null ? 0 : Number(this.#db.prepare(`DELETE FROM ${table} WHERE rowid <= ?`).run(last).changes);
      };
      const starts = count("starts");
      const exits = count("exits");
      count("slow_steps");
      count("spreads");
      // A kept row is at or after the cutoff, and the last use of each of its texts is at most TOUCH_EVERY_MS before it.
      const texts = Number(this.#db.prepare("DELETE FROM texts WHERE last < ?").run(cutoff - TOUCH_EVERY_MS).changes);
      this.#flushSlow();
      return { starts, exits, texts };
    });
    this.#pendingSlow = [];
    const ms = this.#monotonic() - begin;
    if (result.texts > 0) this.#texts.clear();
    if (ms > START_LOG_SLOW_MS) {
      this.#slow({
        at: this.#now(), kind: "prune", ms: Math.round(ms * 10) / 10, starts: result.starts, exits: result.exits, texts: result.texts,
        frames: null, checkpointed: null, lagMs: null, messageLagMs: null, queuedMs: null,
      });
    }
    return result;
  }

  /** This function gives the facts of the writer. */
  stats(failure: string | null = null): StartLogStats {
    return {
      path: this.#path,
      starts: this.#starts,
      withCommand: this.#withCommand,
      withCreated: this.#withCreated,
      adopted: this.#adopted,
      exits: this.#exits,
      commits: this.#commits,
      writeMs: Math.round(this.#writeMs * 10) / 10,
      slowestWriteMs: Math.round(this.#slowestWriteMs * 10) / 10,
      slowestLagMs: Math.round(this.#slowestLagMs),
      checkpoints: this.#checkpoints,
      slowestCheckpointMs: Math.round(this.#slowestCheckpointMs * 10) / 10,
      slowSteps: this.#slowSteps,
      lagSpread: spreadOf(this.#lag),
      writeSpread: spreadOf(this.#write),
      failure,
    };
  }

  /** This function writes the slow steps that wait and the histograms of the last time, and closes the file. */
  close(): void {
    try {
      if (this.#pendingSlow.length > 0 || this.#periodLag.n > 0 || this.#periodWrite.n > 0) {
        transaction(this.#db, () => {
          this.#flushSlow();
          this.#flushSpreads(this.#now());
        });
      }
      this.#pendingSlow = [];
    } finally {
      this.#db.close();
    }
  }
}

/** A start of the log, with its texts and its exit. */
export interface LoggedStart {
  readonly at: number;
  readonly key: number;
  readonly pid: number;
  readonly ppid: number | null;
  /** The FILETIME of the creation, as decimal text: it has more digits than a number keeps. */
  readonly created: string | null;
  /** The creation time in ms since the Unix epoch. */
  readonly createdAt: number | null;
  readonly image: string | null;
  readonly command: string | null;
  readonly parentCommand: string | null;
  readonly reuseMs: number | null;
  /** True for an adoption: the process ran before the trace put it in a job, so its row is no start. */
  readonly adopted: boolean;
  /** The first exit of the pid after the start, before the next start of the pid. */
  readonly exit: { readonly at: number; readonly exitCode: number | null } | null;
}

/** The span of the log. */
export interface StartLogSpan {
  readonly from: number | null;
  readonly to: number | null;
  readonly starts: number;
  readonly exits: number;
}

/** This function opens the log to read it. The file must exist. */
export function openStartLog(path: string): DatabaseSync {
  return openDatabase(path, { readOnly: true, busyTimeoutMs: 2000 });
}

/** This function gives the span of the log: its first and last times and its counts of rows. */
export function startLogSpan(db: DatabaseSync): StartLogSpan {
  const starts = db.prepare("SELECT min(at) AS first, max(at) AS last, count(*) AS n FROM starts").get() as { first: number | null; last: number | null; n: number };
  const exits = db.prepare("SELECT min(at) AS first, max(at) AS last, count(*) AS n FROM exits").get() as { first: number | null; last: number | null; n: number };
  const firsts = [starts.first, exits.first].filter((value): value is number => value !== null);
  const lasts = [starts.last, exits.last].filter((value): value is number => value !== null);
  return { from: firsts.length === 0 ? null : Math.min(...firsts), to: lasts.length === 0 ? null : Math.max(...lasts), starts: starts.n, exits: exits.n };
}

const START_COLUMNS = `s.rowid AS id, s.at, s.key, s.pid, s.ppid, CAST(s.created AS TEXT) AS created, s.reuse_ms AS reuseMs, ${adoptedSql("s.")} AS adopted,
  i.text AS image, c.text AS command, p.text AS parentCommand
  FROM starts s LEFT JOIN texts i ON i.id = s.image LEFT JOIN texts c ON c.id = s.command LEFT JOIN texts p ON p.id = s.parent_command`;

interface StartRecord {
  readonly id: number;
  readonly at: number;
  readonly key: number;
  readonly pid: number;
  readonly ppid: number | null;
  readonly created: string | null;
  readonly reuseMs: number | null;
  readonly adopted: number;
  readonly image: string | null;
  readonly command: string | null;
  readonly parentCommand: string | null;
}

/** This function adds the exit to a start: the first exit of its pid after it, before the next start of the pid. */
function withExit(db: DatabaseSync, record: StartRecord): LoggedStart {
  const next = db.prepare("SELECT at FROM starts WHERE rowid > ? AND pid = ? ORDER BY rowid LIMIT 1").get(record.id, record.pid) as { at: number } | undefined;
  const from = firstRowFrom(db, "exits", record.at);
  // An exit with another creation time is of another process with the pid. An exit with no creation time is of a process
  // whose handle the reader did not hold: it joins by the time only.
  const exit = (
    record.created === null
      ? db.prepare("SELECT at, code FROM exits WHERE rowid >= ? AND pid = ? AND created IS NULL ORDER BY rowid LIMIT 1").get(from, record.pid)
      : db.prepare("SELECT at, code FROM exits WHERE rowid >= ? AND pid = ? AND (created IS NULL OR created = ?) ORDER BY rowid LIMIT 1").get(from, record.pid, BigInt(record.created))
  ) as { at: number; code: number | null } | undefined;
  const ended = exit !== undefined && (next === undefined || exit.at <= next.at) ? { at: exit.at, exitCode: exit.code } : null;
  const { id: _id, ...rest } = record;
  return { ...rest, adopted: record.adopted === 1, createdAt: record.created === null ? null : filetimeMs(BigInt(record.created)), exit: ended };
}

/** This function gives the starts of a pid in the log, the newest first, each with its exit. */
export function startsOfPid(db: DatabaseSync, pid: number, limit = 20): LoggedStart[] {
  const records = db.prepare(`SELECT ${START_COLUMNS} WHERE s.pid = ? ORDER BY s.rowid DESC LIMIT ?`).all(pid, limit) as unknown as StartRecord[];
  return records.map((record) => withExit(db, record));
}

/**
 * This function gives the parents of a start in the log, the nearest first. A parent is the newest start of the parent
 * pid before the start of its child. It stops at a parent that the log does not have, or at `depth` parents.
 */
export function parentsOf(db: DatabaseSync, start: LoggedStart, depth = 8): LoggedStart[] {
  const parents: LoggedStart[] = [];
  const find = db.prepare(`SELECT ${START_COLUMNS} WHERE s.pid = ? AND s.at <= ? ORDER BY s.rowid DESC LIMIT 1`);
  let child = start;
  while (parents.length < depth && child.ppid !== null && child.ppid !== 0) {
    const record = find.get(child.ppid, child.at) as unknown as StartRecord | undefined;
    if (record === undefined) break;
    const parent = withExit(db, record);
    // A parent is older than its child. An older pid holder with the same pid is not the parent.
    if (parent.exit !== null && parent.exit.at < child.at) break;
    parents.push(parent);
    child = parent;
  }
  return parents;
}

/** This function gives the starts with a time from `from` to `to`, the oldest first, with their exits. */
export function startsBetween(db: DatabaseSync, from: number, to: number, limit = 100_000): LoggedStart[] {
  const first = firstRowFrom(db, "starts", from);
  const records = db.prepare(`SELECT ${START_COLUMNS} WHERE s.rowid >= ? AND s.at <= ? ORDER BY s.rowid LIMIT ?`).all(first, to, limit) as unknown as StartRecord[];
  return records.map((record) => withExit(db, record));
}

/**
 * This function gives the slow steps of the writer from `from` to `to`, in the order of time (H199). A file of an older
 * version has no table of slow steps: it gives none.
 */
export function slowStepsBetween(db: DatabaseSync, from: number, to: number, limit = 10_000): SlowStep[] {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'slow_steps'").get() === undefined) return [];
  const first = firstRowFrom(db, "slow_steps", from);
  return db
    .prepare(
      `SELECT at, kind, ms, starts, exits, texts, frames, checkpointed, lag_ms AS lagMs, message_lag_ms AS messageLagMs, queued_ms AS queuedMs
       FROM slow_steps WHERE rowid >= ? AND at <= ? ORDER BY rowid LIMIT ?`,
    )
    .all(first, to, limit) as unknown as SlowStep[];
}

/** This function reads a histogram of a row of `spreads`, or `null` for a text of another shape. */
function storedHistogram(text: string): Histogram | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const h = value as Record<string, unknown>;
  const numbers = ["relativeError", "n", "sum", "min", "max", "zeros"].every((key) => typeof h[key] === "number");
  const bucket = (item: unknown): boolean => {
    if (typeof item !== "object" || item === null) return false;
    const { index, count } = item as Record<string, unknown>;
    return Number.isInteger(index) && Number.isInteger(count) && (count as number) > 0;
  };
  const buckets = (list: unknown): list is HistogramBucket[] => Array.isArray(list) && list.every(bucket);
  return numbers && buckets(h["positive"]) && buckets(h["negative"]) ? (h as unknown as Histogram) : null;
}

/** The spreads of the start log over a time (H199). */
export interface StartLogSpreads {
  /** The start of the first row and the end of the last row that the merge has, or `null` for no row. */
  readonly from: number | null;
  readonly to: number | null;
  readonly lag: StartLogSpread | null;
  readonly write: StartLogSpread | null;
}

/**
 * This function merges the rows of `spreads` that end from `from` to `to` (H199). Each row has 10 minutes, so the time of
 * the merge can start up to 10 minutes before `from`. A row of another shape, or with another relative error, does not
 * count. A file of an older version has no table of spreads: it gives no spread.
 */
export function startLogSpreads(db: DatabaseSync, from: number, to: number): StartLogSpreads {
  const none: StartLogSpreads = { from: null, to: null, lag: null, write: null };
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spreads'").get() === undefined) return none;
  const first = firstRowFrom(db, "spreads", from);
  const rows = db.prepare("SELECT at, since, kind, histogram FROM spreads WHERE rowid >= ? AND at <= ? ORDER BY rowid").all(first, to) as {
    at: number;
    since: number;
    kind: string;
    histogram: string;
  }[];
  const merged = new Map<SpreadKind, Histogram>();
  let start: number | null = null;
  let end: number | null = null;
  for (const row of rows) {
    if (row.kind !== "lag" && row.kind !== "write") continue;
    const histogram = storedHistogram(row.histogram);
    if (histogram === null) continue;
    const before = merged.get(row.kind) ?? emptyHistogram(histogram.relativeError);
    if (before.relativeError !== histogram.relativeError) continue;
    merged.set(row.kind, mergeHistograms(before, histogram));
    start = Math.min(start ?? row.since, row.since);
    end = Math.max(end ?? row.at, row.at);
  }
  const spread = (kind: SpreadKind): StartLogSpread | null => {
    const histogram = merged.get(kind);
    return histogram === undefined ? null : spreadOf(histogram);
  };
  return { from: start, to: end, lag: spread("lag"), write: spread("write") };
}

/**
 * The state of the system in the minute of a slow step (H199), from the 1-minute samples of the store. Each field is
 * `null` when no sample is near.
 */
export interface SlowStepContext {
  readonly memoryFreeMb: number | null;
  readonly commitFreeMb: number | null;
  readonly coresUsed: number | null;
  readonly cores: number | null;
  /** The starts of the trace in one minute. */
  readonly tracedPerMinute: number | null;
}

/**
 * The part of the lag that names the cause of a slow step:
 *
 * - `late-message`: the message of the job came late. The system was slow before the reader got it.
 * - `queued`: the rows waited in the reader before the commit started, for example behind a slow step.
 * - `slow-commit`: the commit itself was the largest part.
 * - `checkpoint` and `prune`: a step of its own was slow.
 */
export type SlowCauseKind = "late-message" | "queued" | "slow-commit" | "checkpoint" | "prune";

/** The cause of a slow step, with its text. */
export interface SlowCause {
  readonly kind: SlowCauseKind;
  readonly text: string;
}

/** This function writes a count of ms with the separators of thousands. */
function msText(ms: number): string {
  return `${Math.round(ms).toLocaleString("en-US")} ms`;
}

/** This function writes the state of the system in the minute of a step, or an empty text for no sample. */
function contextText(context: SlowStepContext | null): string {
  if (context === null) return "";
  const parts: string[] = [];
  const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;
  if (context.memoryFreeMb !== null) parts.push(`${gb(context.memoryFreeMb)} of memory free`);
  if (context.commitFreeMb !== null) parts.push(`${gb(context.commitFreeMb)} of commit free`);
  if (context.coresUsed !== null) parts.push(`${context.coresUsed.toFixed(1)}${context.cores === null ? "" : ` of ${context.cores}`} cores in use`);
  if (context.tracedPerMinute !== null) parts.push(`${Math.round(context.tracedPerMinute).toLocaleString("en-US")} traced starts a minute`);
  return parts.length === 0 ? "" : ` In that minute: ${parts.join(", ")}.`;
}

/**
 * This function names the cause of a slow step (H199). For a commit, the largest part of its lag names it: the late
 * message, the wait in the reader or the commit. The samples of the minute tell the state of the system.
 */
export function slowStepCause(step: SlowStep, context: SlowStepContext | null = null): SlowCause {
  const state = contextText(context);
  if (step.kind === "checkpoint") {
    return { kind: "checkpoint", text: `The copy of the WAL took ${msText(step.ms)} for ${(step.frames ?? 0).toLocaleString("en-US")} pages.${state}` };
  }
  if (step.kind === "prune") {
    const rows = (step.starts ?? 0) + (step.exits ?? 0);
    return { kind: "prune", text: `The prune took ${msText(step.ms)} for ${rows.toLocaleString("en-US")} rows and ${(step.texts ?? 0).toLocaleString("en-US")} texts.${state}` };
  }
  const parts: readonly [SlowCauseKind, number][] = [
    ["late-message", step.messageLagMs ?? 0],
    ["queued", step.queuedMs ?? 0],
    ["slow-commit", step.ms],
  ];
  const [kind, ms] = parts.reduce((largest, part) => (part[1] > largest[1] ? part : largest));
  const lag = step.lagMs === null ? "" : ` of the lag of ${msText(step.lagMs)}`;
  const rows = `${step.starts ?? 0} starts, ${step.exits ?? 0} exits and ${step.texts ?? 0} new texts`;
  const what =
    kind === "late-message"
      ? `The message of the job came late: ${msText(ms)}${lag} passed before the reader got it.`
      : kind === "queued"
        ? `The rows waited in the reader: ${msText(ms)}${lag} passed before the commit started.`
        : `The commit itself was slow: ${msText(ms)}${lag}, for ${rows}.`;
  return { kind, text: `${what}${state}` };
}

/** One line of a ranking: a text and its starts. */
export interface RankedStarter {
  readonly text: string | null;
  readonly starts: number;
  readonly perMinute: number;
}

/** The ranking of the starters over a time. */
export interface StartRanking {
  /** The start and the end of the time that the ranking covers. */
  readonly from: number;
  readonly to: number;
  readonly starts: number;
  readonly perMinute: number;
  /** The top images. */
  readonly images: readonly RankedStarter[];
  /** The top command lines of the parents. */
  readonly parents: readonly RankedStarter[];
  /** The starts that got a pid that a traced process left less than 1 s before, and the starts with a reuse under 60 s. */
  readonly reusedUnder1s: number;
  readonly reusedUnder60s: number;
  /** The adoptions in the time. They are no starts, so the ranking does not count them. */
  readonly adopted: number;
}

/**
 * This function ranks the starters of the last `spanMs` before the newest row. It gives the starts in one minute by
 * image and by the command line of the parent: the top `top` of each. An adoption is no start.
 */
export function rankStarters(db: DatabaseSync, spanMs: number, top = 20): StartRanking | null {
  const span = startLogSpan(db);
  if (span.to === null || span.from === null) return null;
  const to = span.to;
  const from = Math.max(span.from, to - spanMs);
  const first = firstRowFrom(db, "starts", from);
  const minutes = Math.max(1, to - from) / 60_000;
  const rate = (count: number): number => Math.round((count / minutes) * 10) / 10;
  const adopted = adoptedSql("");
  const totals = db.prepare(
    `SELECT sum(NOT ${adopted}) AS n, sum(NOT ${adopted} AND reuse_ms IS NOT NULL AND reuse_ms < 1000) AS fast,
       sum(NOT ${adopted} AND reuse_ms IS NOT NULL) AS reused, sum(${adopted}) AS adopted FROM starts WHERE rowid >= ?`,
  ).get(first) as { n: number | null; fast: number | null; reused: number | null; adopted: number | null };
  const rank = (column: "image" | "parent_command"): RankedStarter[] =>
    (
      db.prepare(
        `SELECT t.text AS text, r.n AS n FROM (SELECT ${column} AS id, count(*) AS n FROM starts WHERE rowid >= ? AND NOT ${adopted} GROUP BY ${column} ORDER BY n DESC LIMIT ?) r
         LEFT JOIN texts t ON t.id = r.id ORDER BY r.n DESC`,
      ).all(first, top) as { text: string | null; n: number }[]
    ).map((row) => ({ text: row.text, starts: row.n, perMinute: rate(row.n) }));
  return {
    from,
    to,
    starts: totals.n ?? 0,
    perMinute: rate(totals.n ?? 0),
    images: rank("image"),
    parents: rank("parent_command"),
    reusedUnder1s: totals.fast ?? 0,
    reusedUnder60s: totals.reused ?? 0,
    adopted: totals.adopted ?? 0,
  };
}
