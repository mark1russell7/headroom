/**
 * The store of headroom: one SQLite file in WAL mode, through `node:sqlite`.
 *
 * It keeps the leases, the capacity of the configured pools and one memory sample each minute. It also keeps
 * the memory and the written MB of each owner each minute. It also keeps the level of each resource instance each minute,
 * the snapshots of the pool tags, the settings and the sleeps of the computer. It removes the samples that are older than the retention.
 * It also keeps the owner record of each live process that is older than one minute (H48).
 */

import type { DatabaseSync } from "node:sqlite";
import { addMissingColumns, migrate, openDatabase, syncedTransaction, transaction, type Migration } from "@mark1russell7/sqlite";
import { alertRulesOf, type AlertRules } from "./alerts.ts";
import { isActive, type Lease, type LeaseState } from "./broker.ts";
import type { CounterRow, ProcessReads } from "./counters.ts";
import type { JobUsage, Measurement } from "./resources.ts";
import type { MemoryPeak, PeakKind, PeakPoint, PeakSummary } from "./memory-peaks.ts";
import { DEFAULT_HEALTH } from "./services.ts";
import { BATTERY_FLOOR_DEFAULT, type LeaseConditions, type UnmetCondition } from "./conditions.ts";
import { CPU_RESERVE_DEFAULT } from "./cpu.ts";
import { AWAY_AFTER_DEFAULT_MS, BUSY_WAIT_DEFAULT_MS, PRESENT_RESERVE_DEFAULT } from "./presence.ts";
import { RECORDS_MAX, type ProcessRecord, type RecordChanges } from "./orphans.ts";
import type { ReapAction, ReapEntry, ShadowMatch, ShadowRow, StdoutKind } from "./reap.ts";
import { AUTO_DRAIN_DEFAULT_MB, parseDrain, type Drain } from "./reboot.ts";
import type { MeasuredRun } from "./peak-floor.ts";
import { redactCommand } from "./redact.ts";
import { averageRate, SPAWN_HEAVY_DEFAULT, SPAWN_RUNS, type SpawnClass } from "./spawn.ts";
import { FIRST_RUNS, startCapOf, type StartCap } from "./start-cap.ts";
import { TRACE_HOLD_KINDS, traceKindsOf } from "./trace.ts";
import { FIT_RUNS, isJobKind, KIND_RUNS, PEAK_RUNS, type JobKey, type MemoryPrediction, type Rung, type RunEstimate, type RunSource, type SizedPeak } from "./predict.ts";
import type { Amounts, McpServerSpec, OwnerKind, OwnerUsage, PoolTag, SessionLoad, SystemMemory } from "./types.ts";

/** One stored memory sample. */
export interface MemoryRow extends SystemMemory {
  readonly at: number;
  /** The load of the session at the sample, when the sample has it. */
  readonly processes?: number | null;
  readonly userObjects?: number | null;
  readonly gdiObjects?: number | null;
}

/** One stored owner sample. */
export interface OwnerRow extends OwnerUsage {
  readonly at: number;
  /** The MB that the owner wrote in the minute before the sample (H20). A row of an older version has none. */
  readonly writeMb?: number | undefined;
  /** The MB that the owner read in the minute before the sample (H66). A row of an older version has none. */
  readonly readMb?: number | undefined;
}

/** One stored process that read much in one minute (H66). */
export interface ReaderRow extends ProcessReads {
  readonly at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY, holder TEXT NOT NULL, job TEXT NOT NULL, amounts TEXT NOT NULL,
  priority INTEGER NOT NULL, pid INTEGER, ttl_ms INTEGER NOT NULL, state TEXT NOT NULL,
  requested_at INTEGER NOT NULL, granted_at INTEGER, ended_at INTEGER, heartbeat_at INTEGER NOT NULL, reason TEXT,
  peak_mb REAL
);
CREATE INDEX IF NOT EXISTS leases_state ON leases (state);
CREATE TABLE IF NOT EXISTS pools (name TEXT PRIMARY KEY, capacity REAL NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_servers (name TEXT PRIMARY KEY, spec TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory (
  at INTEGER PRIMARY KEY, total_mb INTEGER, available_mb INTEGER, commit_mb INTEGER,
  commit_limit_mb INTEGER, kernel_paged_mb INTEGER, kernel_nonpaged_mb INTEGER,
  processes INTEGER, user_objects INTEGER, gdi_objects INTEGER
);
CREATE TABLE IF NOT EXISTS owners (
  at INTEGER NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
  private_mb INTEGER, working_mb INTEGER, processes INTEGER, write_mb REAL, read_mb REAL, PRIMARY KEY (at, owner)
);
CREATE TABLE IF NOT EXISTS readers (
  at INTEGER NOT NULL, pid INTEGER NOT NULL, name TEXT NOT NULL, owner TEXT NOT NULL, read_mb REAL NOT NULL, PRIMARY KEY (at, pid)
);
CREATE TABLE IF NOT EXISTS pool_tags (
  at INTEGER NOT NULL, tag TEXT NOT NULL, nonpaged_mb REAL, paged_mb REAL, PRIMARY KEY (at, tag)
);
CREATE TABLE IF NOT EXISTS resource_samples (
  at INTEGER NOT NULL, id TEXT NOT NULL, capacity REAL, used REAL, free REAL, PRIMARY KEY (at, id)
);
CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sleeps (from_at INTEGER PRIMARY KEY, to_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS process_owners (
  pid INTEGER NOT NULL, created INTEGER NOT NULL, owner TEXT NOT NULL, command TEXT, first_seen INTEGER NOT NULL, PRIMARY KEY (pid, created)
);
`;

/**
 * The tables of the memory peaks of the large processes and containers in each minute (H62 part 5). Step 8 makes them. A
 * holder keeps its command in one row of `peak_holders`, not in each minute. The records of the owners drop a process
 * at its end, so the peaks keep their own commands.
 */
const PEAKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_peaks (
  at INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, owner TEXT, pid INTEGER, created INTEGER,
  lease TEXT, peak_mb REAL NOT NULL, PRIMARY KEY (at, kind, key)
);
CREATE INDEX IF NOT EXISTS memory_peaks_key ON memory_peaks (kind, key, at);
CREATE TABLE IF NOT EXISTS peak_holders (
  kind TEXT NOT NULL, key TEXT NOT NULL, command TEXT, last_at INTEGER NOT NULL, PRIMARY KEY (kind, key)
);
`;

/**
 * The steps of the schema (@mark1russell7/sqlite). The user_version of a file is the count of its steps. Each change
 * of the schema is a new step at the end. Do not change a step that a file can have.
 */
const MIGRATIONS: readonly Migration[] = [
  // The baseline. A file of a version before the migrations has the user_version 0 and the tables of its version. The
  // step makes the tables that are not there and adds the columns that an older version did not have.
  (db) => {
    db.exec(SCHEMA);
    addMissingColumns(db, "leases", {
      peak_mb: "REAL", usage: "TEXT", // the peak memory and the use of a lease
      exit_code: "INTEGER", signal: "TEXT", log: "TEXT", // the exit and the log of a job (H26)
      processes: "INTEGER", // the processes that a job started (H29)
      peak_starts_per_min: "REAL", spawn: "TEXT", // the peak starts and the spawn class of a job (H47)
      conditions: "TEXT", conditions_met_at: "INTEGER", unmet: "TEXT", // the conditions of a lease (H31)
      cpu_cap: "REAL", peak_cores: "REAL", // the CPU cap and the peak cores of a lease (H23)
      peak_gpu_mb: "REAL", // the peak GPU memory of a lease (H36)
      cancelled_by: "TEXT", // who cancelled a waiting lease (headroom cancel)
    });
    db.exec("CREATE INDEX IF NOT EXISTS leases_job ON leases (job, requested_at)");
    addMissingColumns(db, "memory", { processes: "INTEGER", user_objects: "INTEGER", gdi_objects: "INTEGER" });
    addMissingColumns(db, "owners", { write_mb: "REAL", read_mb: "REAL" }); // the writes (H20) and the reads (H66) of an owner
  },
  // H182: the parent ID, the start of the parent and the session of each owner record. An older record gets the name of
  // its session from its owner `session:<name>`, because the owner came from the same session file. Its parent stays 0
  // until the next read while the parent runs.
  (db) => {
    addMissingColumns(db, "process_owners", { ppid: "INTEGER", parent_created: "INTEGER", session: "TEXT", session_id: "TEXT" });
    db.exec("UPDATE process_owners SET session = substr(owner, 9) WHERE session IS NULL AND owner LIKE 'session:%'");
  },
  // H183: the shadow log of the automatic reap rule, and the log of `headroom reap <pid>`.
  (db) => {
    db.exec(REAP_SCHEMA);
  },
  // H78: the key of each lease from the client, and the predictions at its request.
  (db) => {
    db.exec(KEYS_SCHEMA);
  },
  // H186: each stored command line and each stored name of a job gets a mark in place of each secret. A new text gets the
  // mark before the store keeps it, so this step changes only the rows of an older version.
  (db) => {
    redactStoredCommands(db);
  },
  // H203: the log of the refusals of the gate of long native paths, for a count of the refusals of each session.
  (db) => {
    db.exec(REFUSAL_SCHEMA);
  },
  // H62: the folder of the job of each lease. The rules of the containers read it.
  (db) => {
    addMissingColumns(db, "leases", { folder: "TEXT" });
  },
  // H62 part 5: the memory peaks of the large processes and containers in each minute.
  (db) => {
    db.exec(PEAKS_SCHEMA);
  },
  // H215: the floor of each keyed lease at its request, and the reason of a lease below its floor. The index serves the
  // read of the last run of a signature.
  (db) => {
    addMissingColumns(db, "lease_keys", { floor_mb: "REAL", below_peak: "TEXT" });
    db.exec("CREATE INDEX IF NOT EXISTS lease_keys_command ON lease_keys (command)");
  },
];

/** The table of the refusals of the gate of long native paths (H203). Step 6 of the schema makes it. */
const REFUSAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS native_refusals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, session TEXT, session_id TEXT,
  folder TEXT NOT NULL, nt_length INTEGER NOT NULL, path_limit INTEGER NOT NULL, basis TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS native_refusals_at ON native_refusals (at);
`;

/**
 * One refusal of the gate of long native paths (H203). The command ran node in a folder with a native image path over the
 * limit, so it did not start. The row keeps no command line, because a command line can hold a secret.
 */
export interface NativeRefusalEntry {
  readonly at: number;
  /** `hook`: the PreToolUse hook of a session refused a command. `run`: `headroom run` refused its command. */
  readonly source: "hook" | "run";
  /** The name of the session, or `null` when no session is known. */
  readonly session: string | null;
  /** The ID of the session, or `null` when the caller gave none. */
  readonly sessionId: string | null;
  /** The folder of the long path: the folder where the command runs node, or the folder of its lockfile. */
  readonly folder: string;
  /** The length of the NT path of the longest native image. */
  readonly ntLength: number;
  /** The limit of the gate at the refusal. */
  readonly limit: number;
  /** The source of the length: `measured`, `main checkout` or `prior`. */
  readonly basis: string;
}

/**
 * The input of `Engine.recordNativeRefusal` (H203). A refusal with no time gets the time of the engine. A refusal with no
 * session name gets the name of the session file with its session ID.
 */
export type NativeRefusalInput = Omit<NativeRefusalEntry, "at" | "session"> & {
  readonly at?: number | undefined;
  readonly session?: string | null | undefined;
};

/** The refusals of one session from one source in a time range (H203). */
export interface NativeRefusalCount {
  readonly session: string | null;
  readonly source: "hook" | "run";
  readonly refusals: number;
  /** The count of the different folders of the refusals. */
  readonly folders: number;
  /** The longest NT path of the refusals. */
  readonly longest: number;
  readonly firstAt: number;
  readonly lastAt: number;
}

/** The columns that keep a command line or the name of a job (H186). */
export const COMMAND_COLUMNS: readonly (readonly [table: string, column: string])[] = Object.freeze([
  ["process_owners", "command"],
  ["reap_shadow", "command"],
  ["reap_log", "command"],
  ["leases", "job"],
  ["lease_keys", "command"],
  ["lease_keys", "below_peak"],
  ["peak_holders", "command"],
]);

/**
 * This function puts a mark in place of each secret of the texts of `COMMAND_COLUMNS` (H186). It changes only the rows with
 * a secret, and gives the count of the rows that it changed. It skips a column that the file does not have yet, because a
 * later step of the schema makes it. For example, step 5 runs before step 8 makes `peak_holders`.
 */
export function redactStoredCommands(db: DatabaseSync): number {
  let changed = 0;
  const has = db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?");
  for (const [table, column] of COMMAND_COLUMNS) {
    if (has.get(table, column) === undefined) continue;
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
    const rows = db.prepare(`SELECT rowid AS id, ${column} AS text FROM ${table} WHERE ${column} IS NOT NULL`).all() as { id: number; text: string }[];
    for (const row of rows) {
      const redacted = redactCommand(row.text);
      if (redacted === row.text) continue;
      update.run(redacted, row.id);
      changed += 1;
    }
  }
  return changed;
}

/**
 * The table of H78. Step 4 of the schema makes it. Each lease with a key has one row. The index serves the rungs `key`,
 * `repo` and `kind` of the ladder: each rung is a prefix of it.
 */
const KEYS_SCHEMA = `
CREATE TABLE IF NOT EXISTS lease_keys (
  lease_id TEXT PRIMARY KEY, kind TEXT NOT NULL, repo TEXT, lock TEXT, filter TEXT, warm INTEGER, packages INTEGER,
  command TEXT NOT NULL, predicted_mb REAL, rung TEXT NOT NULL, runs INTEGER NOT NULL, predicted_ms REAL, run_from TEXT
);
CREATE INDEX IF NOT EXISTS lease_keys_ladder ON lease_keys (kind, repo, filter, warm, lock);
`;

/** The scope of a read of the keyed runs (H78): the full key, the key without the lockfile, or the kind. */
export type KeyScope = "key" | "repo" | "kind";

/** This function gives the SQL condition and the values of a scope of a key. `IS` compares the `null` fields too. */
function keyWhere(key: JobKey, scope: KeyScope): { readonly where: string; readonly values: (string | number | null)[] } {
  const warm = key.warm === null ? null : key.warm ? 1 : 0;
  if (scope === "kind") return { where: "k.kind = ?", values: [key.kind] };
  if (scope === "repo") return { where: "k.kind = ? AND k.repo IS ? AND k.filter IS ? AND k.warm IS ?", values: [key.kind, key.repo, key.filter, warm] };
  return { where: "k.kind = ? AND k.repo IS ? AND k.filter IS ? AND k.warm IS ? AND k.lock IS ?", values: [key.kind, key.repo, key.filter, warm, key.lock] };
}

/** One row of the table `lease_keys` (H78): the key of a lease and the predictions at its request. */
export interface LeaseKeyRow {
  readonly key: JobKey;
  /** The memory of the ladder at the request, or `null` at the rung `none`. */
  readonly predictedMb: number | null;
  readonly rung: Rung;
  readonly runs: number;
  /** The expected run time at the request, or `null` with no run. */
  readonly predictedMs: number | null;
  readonly runFrom: RunSource | null;
  /** The floor of the signature at the request in MB, or `null` with no floor or for a row before H215. */
  readonly floorMb: number | null;
  /** The reason of a lease below its floor (`--below-peak`), or `null`. */
  readonly belowPeak: string | null;
}

/** The floor of a keyed lease at its request, and the reason of a lease below it (H215). */
export interface LeaseFloor {
  /** The floor in MB, or `null` when the signature has no measured run. */
  readonly floorMb: number | null;
  /** The reason of `--below-peak` when the stated memory is below the floor, else `null`. */
  readonly belowPeak: string | null;
}

/** The floor of a lease with no measured run of its signature. */
export const NO_FLOOR: LeaseFloor = Object.freeze({ floorMb: null, belowPeak: null });

/** One lease for `headroom report leases` (H78): its request, its end and its key, when it has one. */
export interface KeyedLease {
  readonly id: string;
  readonly holder: string;
  readonly job: string;
  readonly state: string;
  /** The memory of the request in MB, or `null` for a request with no memory. */
  readonly memoryMb: number | null;
  readonly peakMb: number | null;
  readonly requestedAt: number;
  readonly grantedAt: number | null;
  readonly endedAt: number | null;
  readonly exitCode: number | null;
  /** The key and the predictions, or `null` for a lease of an older client. */
  readonly keyed: LeaseKeyRow | null;
}

/** This function reads a row of `lease_keys`, or gives `null` for a row with a kind that this version does not know. */
function toKeyRow(row: Record<string, unknown>): LeaseKeyRow | null {
  const kind = row["kind"];
  if (!isJobKind(kind)) return null;
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  const number = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
  const warm = row["warm"];
  return {
    key: {
      kind,
      repo: text(row["repo"]),
      lock: text(row["lock"]),
      filter: text(row["filter"]),
      warm: warm === null || warm === undefined ? null : Number(warm) === 1,
      packages: number(row["packages"]),
      command: String(row["command"] ?? ""),
    },
    predictedMb: number(row["predicted_mb"]),
    rung: String(row["rung"]) as Rung,
    runs: Number(row["runs"] ?? 0),
    predictedMs: number(row["predicted_ms"]),
    runFrom: text(row["run_from"]) as RunSource | null,
    floorMb: number(row["floor_mb"]),
    belowPeak: text(row["below_peak"]),
  };
}

/**
 * This function reads the leases that a request started at or after `since`, the oldest first, with their keys (H78).
 * It only reads, so `headroom report leases` uses it on a database that it opens read-only. A database before step 4
 * of the schema has no keys.
 */
export function keyedLeases(db: DatabaseSync, since: number): KeyedLease[] {
  const hasKeys = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lease_keys'").get() !== undefined;
  const keys = hasKeys ? "k.*" : "NULL AS kind";
  const join = hasKeys ? "LEFT JOIN lease_keys k ON k.lease_id = l.id" : "";
  const rows = db
    .prepare(
      `SELECT l.id, l.holder, l.job, l.state, json_extract(l.amounts, '$.memory') AS memory_mb, l.peak_mb, l.requested_at, l.granted_at,
         l.ended_at, l.exit_code, ${keys} FROM leases l ${join} WHERE l.requested_at >= ? ORDER BY l.requested_at, l.id`,
    )
    .all(since);
  const number = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
  return rows.map((row) => ({
    id: String(row["id"]),
    holder: String(row["holder"]),
    job: String(row["job"]),
    state: String(row["state"]),
    memoryMb: number(row["memory_mb"]),
    peakMb: number(row["peak_mb"]),
    requestedAt: Number(row["requested_at"]),
    grantedAt: number(row["granted_at"]),
    endedAt: number(row["ended_at"]),
    exitCode: number(row["exit_code"]),
    keyed: row["kind"] === null || row["kind"] === undefined ? null : toKeyRow(row),
  }));
}

/** The tables of H183. Step 3 of the schema makes them. */
const REAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS reap_shadow (
  pid INTEGER NOT NULL, created INTEGER NOT NULL, name TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  above_since INTEGER NOT NULL, samples INTEGER NOT NULL, private_mb REAL NOT NULL, peak_mb REAL NOT NULL, owner TEXT NOT NULL,
  session TEXT, session_id TEXT, command TEXT, stdout TEXT NOT NULL, PRIMARY KEY (pid, created)
);
CREATE INDEX IF NOT EXISTS reap_shadow_last ON reap_shadow (last_at);
CREATE TABLE IF NOT EXISTS reap_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, pid INTEGER NOT NULL, created INTEGER NOT NULL, name TEXT NOT NULL,
  session TEXT, session_id TEXT, by_name TEXT, by_id TEXT, action TEXT NOT NULL, private_mb REAL NOT NULL, command TEXT,
  result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reap_log_at ON reap_log (at);
`;

/** The most rows that one read of the shadow log or of the reap log gives (H183). */
export const REAP_ROWS_MAX = 200;

/** One sleep of the computer (H30): its start and its end, in milliseconds since the epoch. The history has no samples in it. */
export type Sleep = readonly [from: number, to: number];

/** The settings of headroom. The store keeps them, and `headroom config` shows and changes them. */
export interface Config {
  /**
   * The temp root (H19), for example `D:\headroom\tmp`. Each job of `headroom run` gets the folder `<jobTemp>\<lease id>`
   * for its `TEMP`, `TMP` and `TMPDIR`. Without it, a job keeps the `TEMP` of its parent.
   */
  readonly jobTemp: string | null;
  /**
   * The URLs that the service monitor checks (H27), by name. Each one gives the instance `service:<name>`. Without the
   * setting, the list is empty and the monitor checks no URL.
   */
  readonly health: Readonly<Record<string, string>>;
  /**
   * The limit of a spawn-heavy job (H47): its peak process starts in one minute. A job above it does not run beside a
   * browser test. The default is 600.
   */
  readonly spawnHeavy: number;
  /**
   * The battery floor in percent (H31). On battery below it, a new heavy lease waits. The default is 25, and 0 turns the
   * rule off.
   */
  readonly batteryFloor: number;
  /** The usage file for the condition `usage<N` (H31). It has no default (H57): `null` with no setting, and `usage<N` then waits. */
  readonly usageFile: string | null;
  /**
   * The registry of the roles (H57). The folder `roles` next to this file holds the role files. It has no default: `null`
   * with no setting, and the roles are then unknown.
   */
  readonly rolesFile: string | null;
  /**
   * The memory in MB that a lease does not take (H60). The default is 1024. A grant waits when it leaves less than this.
   * A computer with a low-memory line of its own sets the same number here, so that no grant crosses that line.
   */
  readonly memoryReserveMb: number;
  /**
   * The cores that the broker keeps out of the counted `cpu` pool for Mark (H23). The `cpu` amounts of the granted leases
   * do not take them. The default is 2, and 0 turns the reserve off.
   */
  readonly cpuReserve: number;
  /**
   * The presence rules (H33): true by default. While Mark works or is on a call, heavy jobs wait or run slower. False:
   * the daemon measures the presence, but the state changes no admission, no efficiency mode and no reserve.
   */
  readonly presence: boolean;
  /** The time with no input after which Mark is away, in ms (H33). The default is 5 minutes. */
  readonly awayAfterMs: number;
  /** The longest wait of a new heavy lease while Mark is busy, in ms (H33). The default is 20 minutes. */
  readonly busyWaitMs: number;
  /** The cores that the CPU reserve gets while Mark is present or busy (H33). The default is 2. */
  readonly presentReserve: number;
  /**
   * The level of the automatic drain, in MB of the non-paged pool and the paged pool together (H34). At or above it for
   * 2 minutes, new jobs wait for a reboot. The default is 6 GB, and 0 turns the rule off.
   */
  readonly autoDrainMb: number;
  /**
   * The automatic worktree cleanup (H175): false by default. False: the daemon writes only the plan of the cleanup. True: the
   * daemon also removes the trees of the plan, in batches.
   */
  readonly worktreeAutoClean: boolean;
  /**
   * The automatic reap (H183): false by default. In this version, true stops no process. A later version stops the processes
   * of the shadow log only after 7 days of shadow log with no wrong case.
   */
  readonly reapAuto: boolean;
  /**
   * The owner kinds of the start trace (H188). The daemon puts their processes in job objects, and also the processes of
   * the granted leases. Then it names each start in their trees. The default is `session`, `mcp`, `service` and `docker`. An
   * empty list turns the trace off.
   */
  readonly startTrace: readonly OwnerKind[];
  /**
   * The owner kinds whose jobs of the trace refuse a breakaway (H191). Thus the children of their processes stay in the
   * trace. The default is `session`. With an empty list, each job lets a child break away, as before H191.
   */
  readonly startTraceHold: readonly OwnerKind[];
  /**
   * The cap on the process starts of the computer at the grant of a lease (H197): steps by the time since the boot. The
   * default is `START_CAP_DEFAULT`, and an empty list turns the cap off.
   */
  readonly startCap: StartCap;
  /**
   * The alert limits that differ from the defaults (H179), by the names of `AlertRules`. A computer with its own lines (for
   * example a hold of the jobs below 2 GB of available memory) sets them here. The default is no differences.
   */
  readonly alerts: Readonly<Partial<AlertRules>>;
}

/** The lowest level of the automatic drain that is not 0: 1 GB. The highest level: 1 TB. */
export const AUTO_DRAIN_MIN_MB = 1024;
export const AUTO_DRAIN_MAX_MB = 1_048_576;

/** This function tells if a level of the automatic drain is valid: 0 (off), or a whole number of MB from 1 GB to 1 TB. */
export function isAutoDrainLevel(mb: number): boolean {
  return mb === 0 || (Number.isInteger(mb) && mb >= AUTO_DRAIN_MIN_MB && mb <= AUTO_DRAIN_MAX_MB);
}

/** The longest time of the settings `awayAfterMs` and `busyWaitMs`: one day. */
export const PRESENCE_TIME_MAX_MS = 86_400_000;
/** The shortest time of the setting `awayAfterMs`: 30 seconds. */
export const AWAY_AFTER_MIN_MS = 30_000;

/** This function reads a setting in ms. A value that is not a whole number from `min` to one day gives the default. */
function msOf(value: string | undefined, min: number, fallback: number): number {
  const ms = Number(value);
  return value !== undefined && Number.isInteger(ms) && ms >= min && ms <= PRESENCE_TIME_MAX_MS ? ms : fallback;
}

/** This function reads the setting `cpuReserve` or `presentReserve`. A negative value or a value that is not a number gives the default. */
function cpuReserveOf(value: string | undefined, fallback: number = CPU_RESERVE_DEFAULT): number {
  const reserve = Number(value);
  return value !== undefined && Number.isFinite(reserve) && reserve >= 0 ? reserve : fallback;
}

/** The memory in MB that a lease does not take, by default (H60). `headroom config memory-reserve` changes it. */
export const MEMORY_RESERVE_DEFAULT_MB = 1024;

/** This function reads the setting `memoryReserveMb`. A value that is not a whole number of 0 or more gives the default. */
function memoryReserveOf(value: string | undefined): number {
  const reserve = Number(value);
  return value !== undefined && value !== "" && Number.isInteger(reserve) && reserve >= 0 ? reserve : MEMORY_RESERVE_DEFAULT_MB;
}

/** This function reads the setting `batteryFloor`. A value that is not a whole number from 0 to 100 gives the default. */
function batteryFloorOf(value: string | undefined): number {
  const floor = Number(value);
  return value !== undefined && Number.isInteger(floor) && floor >= 0 && floor <= 100 ? floor : BATTERY_FLOOR_DEFAULT;
}

/** This function reads the setting `autoDrainMb`. A value that is not a valid level gives the default. */
function autoDrainOf(value: string | undefined): number {
  const mb = Number(value);
  return value !== undefined && value !== "" && isAutoDrainLevel(mb) ? mb : AUTO_DRAIN_DEFAULT_MB;
}

/** This function reads the setting `spawnHeavy`. A value that is not a number above 0 gives the default. */
function spawnLimitOf(value: string | undefined): number {
  const limit = Number(value);
  return value !== undefined && Number.isFinite(limit) && limit > 0 ? limit : SPAWN_HEAVY_DEFAULT;
}

/** This function reads the setting `health`. A value that is not an object of strings gives the empty default list. */
function healthOf(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined) return DEFAULT_HEALTH;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_HEALTH;
    const entries = Object.entries(parsed);
    return entries.every(([, url]) => typeof url === "string") ? (Object.fromEntries(entries) as Record<string, string>) : DEFAULT_HEALTH;
  } catch {
    return DEFAULT_HEALTH;
  }
}

/** One stored measurement of a resource instance, in the unit of its kind. */
export interface ResourceRow extends Measurement {
  readonly at: number;
}

/**
 * The time that the store keeps each snapshot of the pool tags: 48 hours. A slope of a tag over a window of some hours
 * needs each snapshot of the window, and of a window before it to compare. With a shorter time, the result of a fit
 * changed with the time of the read.
 */
const POOL_TAGS_KEEP_MS = 48 * 3_600_000;
/** The time that the store keeps one snapshot of the pool tags for each hour (H53). A slow leak shows over days. */
const POOL_TAGS_HOURLY_KEEP_MS = 7 * 24 * 3_600_000;

/** One stored snapshot of the pool tags: the non-paged and the paged pool of each tag, in MB. */
export interface PoolTagSnapshot {
  readonly at: number;
  readonly tags: ReadonlyMap<string, number>;
  readonly paged: ReadonlyMap<string, number>;
}

/** The cost of the synced writes of the store since its open (H204). */
export interface StoreSyncs {
  /** The count of synced writes. */
  readonly writes: number;
  /** The time of all the synced writes, in ms. */
  readonly totalMs: number;
  /** The longest synced write, in ms. */
  readonly slowestMs: number;
}

/**
 * The store. The file uses `synchronous` NORMAL, so a crash of the system loses the writes after the last sync (H204).
 * Thus each change of the state of a lease and the key of a new lease are synced writes. A synced write is on the disk
 * when the call returns. A heartbeat, a peak or a reason of a lease changes no state, and it gets the low cost of
 * NORMAL. The sync of a write also keeps each earlier write of the file.
 */
export class Store {
  readonly #db: DatabaseSync;
  /** The state of each active lease at its last synced write. A lease that ended has no entry. */
  readonly #syncedStates = new Map<string, LeaseState>();
  #syncWrites = 0;
  #syncMs = 0;
  #slowestSyncMs = 0;

  constructor(path: string) {
    this.#db = openDatabase(path, { synchronous: "NORMAL", busyTimeoutMs: 5000, makeFolder: true });
    migrate(this.#db, MIGRATIONS, { name: "headroom" });
  }

  /**
   * This function writes a lease, new or changed. A new lease and a change of its state are on the disk when the
   * function returns (H204). A different change gets the low cost of NORMAL.
   */
  saveLease(lease: Lease): void {
    const changed = this.#syncedStates.get(lease.id) !== lease.state;
    const write = (): void => {
      this.#writeLease(lease);
    };
    if (!changed) {
      write();
      return;
    }
    this.#synced(write);
    if (isActive(lease)) this.#syncedStates.set(lease.id, lease.state);
    else this.#syncedStates.delete(lease.id);
  }

  /** This function gives the cost of the synced writes since the open of the store (H204). */
  syncs(): StoreSyncs {
    return { writes: this.#syncWrites, totalMs: Math.round(this.#syncMs * 10) / 10, slowestMs: Math.round(this.#slowestSyncMs * 10) / 10 };
  }

  /** This function does a write in a synced transaction, and adds its time to the cost (H204). */
  #synced(write: () => void): void {
    const begin = performance.now();
    syncedTransaction(this.#db, write);
    const ms = performance.now() - begin;
    this.#syncWrites++;
    this.#syncMs += ms;
    this.#slowestSyncMs = Math.max(this.#slowestSyncMs, ms);
  }

  /** This function writes the row of a lease, with no transaction of its own. */
  #writeLease(lease: Lease): void {
    this.#db
      .prepare(
        `INSERT INTO leases (id, holder, job, amounts, priority, pid, ttl_ms, state, requested_at, granted_at, ended_at, heartbeat_at, reason, peak_mb, usage,
           exit_code, signal, log, processes, peak_starts_per_min, spawn, conditions, conditions_met_at, unmet, cpu_cap, peak_cores, peak_gpu_mb, cancelled_by, folder)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, state = excluded.state, granted_at = excluded.granted_at,
           ended_at = excluded.ended_at, heartbeat_at = excluded.heartbeat_at, reason = excluded.reason, peak_mb = excluded.peak_mb,
           usage = excluded.usage, exit_code = excluded.exit_code, signal = excluded.signal, log = excluded.log, processes = excluded.processes,
           peak_starts_per_min = excluded.peak_starts_per_min, spawn = excluded.spawn, conditions_met_at = excluded.conditions_met_at,
           unmet = excluded.unmet, peak_cores = excluded.peak_cores, peak_gpu_mb = excluded.peak_gpu_mb, cancelled_by = excluded.cancelled_by`,
      )
      .run(
        lease.id, lease.holder, lease.job, JSON.stringify(lease.amounts), lease.priority, lease.pid, lease.ttlMs,
        lease.state, lease.requestedAt, lease.grantedAt, lease.endedAt, lease.heartbeatAt, lease.reason, lease.peakMb,
        lease.usage === undefined ? null : JSON.stringify(lease.usage),
        lease.exitCode ?? null, lease.signal ?? null, lease.log ?? null, lease.processes ?? null,
        lease.peakStartsPerMin ?? null, lease.spawn === undefined ? null : JSON.stringify(lease.spawn),
        lease.conditions === undefined ? null : JSON.stringify(lease.conditions), lease.conditionsMetAt ?? null,
        lease.unmet === undefined ? null : JSON.stringify(lease.unmet), lease.cpuCap ?? null, lease.peakCores ?? null, lease.peakGpuMb ?? null,
        lease.cancelledBy ?? null, lease.folder ?? null,
      );
  }

  /** This function reads the leases whose id starts with a prefix, the newest first. A full id gives at most one lease. */
  leasesByPrefix(prefix: string, limit = 10): Lease[] {
    return this.#db
      .prepare("SELECT * FROM leases WHERE substr(id, 1, ?) = ? ORDER BY requested_at DESC LIMIT ?")
      .all(prefix.length, prefix, limit)
      .map(toLease);
  }

  /**
   * This function reads the leases of a job, the newest request first. With a holder, only the leases of that holder.
   * With a time, only the leases that were active at that time or after it.
   */
  leasesOfJob(job: string, options: { readonly holder?: string | undefined; readonly since?: number | undefined; readonly limit?: number | undefined } = {}): Lease[] {
    const since = options.since ?? 0;
    const holder = options.holder ?? null;
    return this.#db
      .prepare(
        `SELECT * FROM leases WHERE job = ? AND (? IS NULL OR holder = ?) AND (ended_at IS NULL OR ended_at >= ? OR requested_at >= ?)
         ORDER BY requested_at DESC LIMIT ?`,
      )
      .all(job, holder, holder, since, since, options.limit ?? 100)
      .map(toLease);
  }

  /** This function reads the active leases: the waiting and the granted ones. */
  activeLeases(): Lease[] {
    return this.#db.prepare("SELECT * FROM leases WHERE state IN ('waiting', 'granted')").all().map(toLease);
  }

  /** This function reads one lease, or gives `null` when the store does not have it. */
  lease(id: string): Lease | null {
    const row = this.#db.prepare("SELECT * FROM leases WHERE id = ?").get(id);
    return row === undefined ? null : toLease(row);
  }

  /** This function reads the settings. A setting that the store does not have is `null`. */
  config(): Config {
    const values = new Map<string, string>();
    for (const row of this.#db.prepare("SELECT name, value FROM settings").all()) values.set(String(row["name"]), String(row["value"]));
    return {
      jobTemp: values.get("jobTemp") ?? null,
      health: healthOf(values.get("health")),
      spawnHeavy: spawnLimitOf(values.get("spawnHeavy")),
      batteryFloor: batteryFloorOf(values.get("batteryFloor")),
      usageFile: values.get("usageFile") ?? null,
      rolesFile: values.get("rolesFile") ?? null,
      memoryReserveMb: memoryReserveOf(values.get("memoryReserveMb")),
      cpuReserve: cpuReserveOf(values.get("cpuReserve")),
      presence: values.get("presence") !== "off",
      awayAfterMs: msOf(values.get("awayAfterMs"), AWAY_AFTER_MIN_MS, AWAY_AFTER_DEFAULT_MS),
      busyWaitMs: msOf(values.get("busyWaitMs"), 0, BUSY_WAIT_DEFAULT_MS),
      presentReserve: cpuReserveOf(values.get("presentReserve"), PRESENT_RESERVE_DEFAULT),
      autoDrainMb: autoDrainOf(values.get("autoDrainMb")),
      worktreeAutoClean: values.get("worktreeAutoClean") === "on",
      reapAuto: values.get("reapAuto") === "on",
      startTrace: traceKindsOf(values.get("startTrace")),
      startTraceHold: traceKindsOf(values.get("startTraceHold"), TRACE_HOLD_KINDS),
      startCap: startCapOf(values.get("startCap")),
      alerts: alertRulesOf(values.get("alerts")),
    };
  }

  /**
   * This function sets one setting. `null` removes it. The value of `health`, `alerts` and `startCap` is its JSON text. The value of
   * `presence`, `worktreeAutoClean` and `reapAuto` is `on` or `off`. The value of `startTrace` and `startTraceHold` is `off` or owner kinds with
   * commas. The values of the other settings are numbers as text.
   */
  setConfig(name: keyof Config, value: string | null): void {
    if (value === null) this.#db.prepare("DELETE FROM settings WHERE name = ?").run(name);
    else this.#db.prepare("INSERT INTO settings VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value").run(name, value);
  }

  /** This function reads the planned drain from the settings (H34), or gives `null` without a drain. */
  drain(): Drain | null {
    const row = this.#db.prepare("SELECT value FROM settings WHERE name = 'drain'").get();
    return row === undefined ? null : parseDrain(String(row["value"]));
  }

  /**
   * This function reads the hold of the automatic drain (H34): the time of the last `headroom drain --cancel`. Until the
   * pools fall under the end level, or until a reboot, the rule starts no drain. It gives `null` without a hold.
   */
  autoDrainHold(): number | null {
    const row = this.#db.prepare("SELECT value FROM settings WHERE name = 'autoDrainHold'").get();
    const at = row === undefined ? Number.NaN : Number(row["value"]);
    return Number.isFinite(at) ? at : null;
  }

  /** This function writes the hold of the automatic drain (H34), so it continues after a restart of the daemon. `null` removes it. */
  setAutoDrainHold(at: number | null): void {
    if (at === null) this.#db.prepare("DELETE FROM settings WHERE name = 'autoDrainHold'").run();
    else this.#db.prepare("INSERT INTO settings VALUES ('autoDrainHold', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value").run(String(at));
  }

  /** This function writes the planned drain to the settings (H34), so it continues after a restart of the daemon. `null` removes it. */
  setDrain(drain: Drain | null): void {
    if (drain === null) this.#db.prepare("DELETE FROM settings WHERE name = 'drain'").run();
    else this.#db.prepare("INSERT INTO settings VALUES ('drain', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value").run(JSON.stringify(drain));
  }

  /** This function reads the leases that ended after a time, the newest first. */
  endedLeases(since: number, limit = 100): Lease[] {
    return this.#db.prepare("SELECT * FROM leases WHERE ended_at >= ? ORDER BY ended_at DESC LIMIT ?").all(since, limit).map(toLease);
  }

  /**
   * This function reads the peak memory of the last runs of a job, the newest first. With a holder, only the runs of that holder.
   * With a repo (H78), it leaves out the runs with a key of another repo. A run with no key stays.
   */
  peaksOf(job: string, holder?: string, limit: number = PEAK_RUNS, repo: string | null = null): number[] {
    return this.#ofJob("l.peak_mb", "l.peak_mb IS NOT NULL", job, holder, limit, repo);
  }

  /** This function reads one column of the last runs of a job, the newest first, for `peaksOf` and `runTimesOf`. */
  #ofJob(column: string, ran: string, job: string, holder: string | undefined, limit: number, repo: string | null): number[] {
    const join = repo === null ? "" : "LEFT JOIN lease_keys k ON k.lease_id = l.id";
    const where = [`l.job = ?`, ran, ...(holder === undefined ? [] : ["l.holder = ?"]), ...(repo === null ? [] : ["(k.repo IS NULL OR k.repo = ?)"])];
    const values = [job, ...(holder === undefined ? [] : [holder]), ...(repo === null ? [] : [repo]), limit];
    const rows = this.#db.prepare(`SELECT ${column} AS value FROM leases l ${join} WHERE ${where.join(" AND ")} ORDER BY l.ended_at DESC LIMIT ?`).all(...values);
    return rows.map((row) => Number(row["value"]));
  }

  /**
   * This function writes the key of a lease and the predictions at its request (H78). The key is on the disk when the
   * function returns (H204). `floor` is the floor of its signature at the request, and `belowPeak` is the reason of a
   * lease below that floor (H215).
   */
  saveLeaseKey(id: string, key: JobKey, memory: MemoryPrediction, run: RunEstimate, floor: LeaseFloor = NO_FLOOR): void {
    this.#synced(() => this.#writeLeaseKey(id, key, memory, run, floor));
  }

  /** This function writes the row of the key of a lease, with no transaction of its own. */
  #writeLeaseKey(id: string, key: JobKey, memory: MemoryPrediction, run: RunEstimate, floor: LeaseFloor): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO lease_keys (lease_id, kind, repo, lock, filter, warm, packages, command, predicted_mb, rung, runs, predicted_ms, run_from, floor_mb, below_peak)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, key.kind, key.repo ?? null, key.lock ?? null, key.filter ?? null, key.warm === null || key.warm === undefined ? null : key.warm ? 1 : 0,
        key.packages ?? null, key.command, memory.mb, memory.rung, memory.runs, run.ms, run.from, floor.floorMb, floor.belowPeak,
      );
  }

  /**
   * This function reads the last run of the signature of a key with a measured peak (H215). The signature is the kind,
   * the repo, the package filter, the warm state and the command text. It gives `null` when no run of the signature has a peak.
   */
  lastCommandRun(key: JobKey): MeasuredRun | null {
    const warm = key.warm === null || key.warm === undefined ? null : key.warm ? 1 : 0;
    const row = this.#db
      .prepare(
        `SELECT l.id, l.job, l.holder, l.peak_mb, l.ended_at FROM lease_keys k JOIN leases l ON l.id = k.lease_id
         WHERE k.command = ? AND k.kind = ? AND k.repo IS ? AND k.filter IS ? AND k.warm IS ? AND l.peak_mb IS NOT NULL AND l.ended_at IS NOT NULL
         ORDER BY l.ended_at DESC LIMIT 1`,
      )
      .get(key.command, key.kind, key.repo ?? null, key.filter ?? null, warm);
    if (row === undefined) return null;
    return { id: String(row["id"]), job: String(row["job"]), holder: String(row["holder"]), peakMb: Number(row["peak_mb"]), endedAt: Number(row["ended_at"]) };
  }

  /** This function reads the key of a lease (H78), or gives `null` for a lease with no key. */
  leaseKey(id: string): JobKey | null {
    const row = this.#db.prepare("SELECT * FROM lease_keys WHERE lease_id = ?").get(id);
    return row === undefined ? null : (toKeyRow(row)?.key ?? null);
  }

  /** This function reads the key and the predictions of a lease (H78), or gives `null` for a lease with no key. */
  leaseKeyRow(id: string): LeaseKeyRow | null {
    const row = this.#db.prepare("SELECT * FROM lease_keys WHERE lease_id = ?").get(id);
    return row === undefined ? null : toKeyRow(row);
  }

  /**
   * This function reads the peak memory of the last runs of a scope of a key, the newest first (H78). The rungs `key` and
   * `repo` read 20 runs, and the rung `kind` reads 50.
   */
  keyedPeaks(key: JobKey, scope: KeyScope, limit: number = scope === "kind" ? KIND_RUNS : PEAK_RUNS): number[] {
    return this.#keyed("l.peak_mb", "l.peak_mb IS NOT NULL", key, scope, limit);
  }

  /** This function reads the run times in ms of the last runs of a scope of a key that ended with an exit code (H78). The newest run comes first. */
  keyedRunTimes(key: JobKey, scope: KeyScope, limit: number = PEAK_RUNS): number[] {
    return this.#keyed("l.ended_at - l.granted_at", "l.exit_code IS NOT NULL AND l.granted_at IS NOT NULL AND l.ended_at IS NOT NULL", key, scope, limit);
  }

  /** This function reads one column of the last runs of a scope of a key, the newest first. */
  #keyed(column: string, ran: string, key: JobKey, scope: KeyScope, limit: number): number[] {
    const { where, values } = keyWhere(key, scope);
    return this.#db
      .prepare(`SELECT ${column} AS value FROM lease_keys k JOIN leases l ON l.id = k.lease_id WHERE ${where} AND ${ran} ORDER BY l.ended_at DESC LIMIT ?`)
      .all(...values, limit)
      .map((row) => Number(row["value"]));
  }

  /** This function reads the count of packages and the peak of the last runs of a kind and a warm state over each repo. The fit of H78 uses them. */
  sizedPeaks(kind: JobKey["kind"], warm: boolean | null, limit: number = FIT_RUNS): SizedPeak[] {
    return this.#db
      .prepare(
        `SELECT k.packages, l.peak_mb FROM lease_keys k JOIN leases l ON l.id = k.lease_id
         WHERE k.kind = ? AND k.warm IS ? AND k.packages > 0 AND l.peak_mb IS NOT NULL ORDER BY l.ended_at DESC LIMIT ?`,
      )
      .all(kind, warm === null ? null : warm ? 1 : 0, limit)
      .map((row) => ({ packages: Number(row["packages"]), peakMb: Number(row["peak_mb"]) }));
  }

  /**
   * This function reads the run times in ms of the last runs of a job that ended with an exit code, the newest first (H178).
   * A run that a signal stopped has no exit code, so its short time does not count. With a holder, only the runs of that holder.
   * With a repo (H78), it leaves out the runs with a key of another repo.
   */
  runTimesOf(job: string, holder?: string, limit: number = PEAK_RUNS, repo: string | null = null): number[] {
    return this.#ofJob("l.ended_at - l.granted_at", "l.exit_code IS NOT NULL AND l.granted_at IS NOT NULL AND l.ended_at IS NOT NULL", job, holder, limit, repo);
  }

  /**
   * This function reads the run times of the last runs with an exit code, the newest first (H184). With an amount of
   * memory, it reads only the runs of the size class of the amount. A class goes from a power of 2 to the next power of 2.
   * For example, the class of 900 MB is above 512 MB, up to 1024 MB. An amount of 0 has its own class: the leases with
   * no memory. Without an amount, it reads the runs of each job.
   */
  runTimesOfSize(memoryMb?: number, limit = 50): number[] {
    const ran = "SELECT ended_at - granted_at AS ran_ms FROM leases WHERE exit_code IS NOT NULL AND granted_at IS NOT NULL AND ended_at IS NOT NULL";
    const memory = "COALESCE(json_extract(amounts, '$.memory'), 0)";
    const order = "ORDER BY ended_at DESC LIMIT ?";
    const top = memoryMb === undefined || memoryMb <= 0 ? 0 : 2 ** Math.ceil(Math.log2(memoryMb));
    const rows = memoryMb === undefined
      ? this.#db.prepare(`${ran} ${order}`).all(limit)
      : top === 0
        ? this.#db.prepare(`${ran} AND ${memory} <= 0 ${order}`).all(limit)
        : this.#db.prepare(`${ran} AND ${memory} > ? AND ${memory} <= ? ${order}`).all(top / 2, top, limit);
    return rows.map((row) => Number(row["ran_ms"]));
  }

  /** This function reads the peak cores of the last runs of a job that ended, the newest first (H23). With a holder, only the runs of that holder. */
  corePeaksOf(job: string, holder?: string, limit = 20): number[] {
    const ran = "SELECT peak_cores FROM leases WHERE job = ? AND peak_cores IS NOT NULL AND ended_at IS NOT NULL";
    const rows = holder === undefined
      ? this.#db.prepare(`${ran} ORDER BY ended_at DESC LIMIT ?`).all(job, limit)
      : this.#db.prepare(`${ran} AND holder = ? ORDER BY ended_at DESC LIMIT ?`).all(job, holder, limit);
    return rows.map((row) => Number(row["peak_cores"]));
  }

  /**
   * This function reads the peak process starts in one minute of the last runs of a job, the newest first (H47). With a
   * holder, only the runs of that holder. A run with no peak, from before H47, gives its average: a lower bound.
   */
  startPeaksOf(job: string, holder?: string, limit: number = SPAWN_RUNS): number[] {
    const columns = "SELECT peak_starts_per_min, processes, granted_at, ended_at FROM leases";
    const ran = "ended_at IS NOT NULL AND granted_at IS NOT NULL AND (peak_starts_per_min IS NOT NULL OR processes IS NOT NULL)";
    const rows = holder === undefined
      ? this.#db.prepare(`${columns} WHERE job = ? AND ${ran} ORDER BY ended_at DESC LIMIT ?`).all(job, limit)
      : this.#db.prepare(`${columns} WHERE job = ? AND holder = ? AND ${ran} ORDER BY ended_at DESC LIMIT ?`).all(job, holder, limit);
    return rows.map((row) =>
      row["peak_starts_per_min"] === null || row["peak_starts_per_min"] === undefined
        ? averageRate(Number(row["processes"]), Number(row["ended_at"]) - Number(row["granted_at"]))
        : Number(row["peak_starts_per_min"]),
    );
  }

  /**
   * This function gives the real peak starts in one minute of the last first runs (H197). A first run is a run of a job with
   * no past runs at its request, and with no option of the run. A first run that went above the limit has the class `live` at its
   * end, and it counts too. A run with no peak gives its average rate.
   */
  firstRunPeaks(limit: number = FIRST_RUNS): number[] {
    const rows = this.#db
      .prepare(
        `SELECT peak_starts_per_min, processes, granted_at, ended_at FROM leases
         WHERE ended_at IS NOT NULL AND granted_at IS NOT NULL AND (peak_starts_per_min IS NOT NULL OR processes IS NOT NULL)
           AND json_extract(spawn, '$.runs') = 0 AND json_extract(spawn, '$.source') NOT IN ('declared', 'opted-out')
         ORDER BY ended_at DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map((row) =>
      row["peak_starts_per_min"] === null || row["peak_starts_per_min"] === undefined
        ? averageRate(Number(row["processes"]), Number(row["ended_at"]) - Number(row["granted_at"]))
        : Number(row["peak_starts_per_min"]),
    );
  }

  /** This function reads the capacity of each configured pool. */
  pools(): Record<string, number> {
    const pools: Record<string, number> = {};
    for (const row of this.#db.prepare("SELECT name, capacity FROM pools").all()) pools[String(row["name"])] = Number(row["capacity"]);
    return pools;
  }

  /** This function sets the capacity of a pool. A capacity below 0 removes the pool. */
  setPool(name: string, capacity: number): void {
    if (capacity < 0) this.#db.prepare("DELETE FROM pools WHERE name = ?").run(name);
    else this.#db.prepare("INSERT INTO pools VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET capacity = excluded.capacity").run(name, capacity);
  }

  /** This function reads the servers of the MCP gateway, by name. */
  mcpServers(): Record<string, McpServerSpec> {
    const servers: Record<string, McpServerSpec> = {};
    for (const row of this.#db.prepare("SELECT name, spec FROM mcp_servers").all()) servers[String(row["name"])] = JSON.parse(String(row["spec"])) as McpServerSpec;
    return servers;
  }

  /** This function adds or changes a server of the MCP gateway. `null` removes it. */
  setMcpServer(name: string, spec: McpServerSpec | null): void {
    if (spec === null) this.#db.prepare("DELETE FROM mcp_servers WHERE name = ?").run(name);
    else this.#db.prepare("INSERT INTO mcp_servers VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET spec = excluded.spec").run(name, JSON.stringify(spec));
  }

  /**
   * This function writes one memory sample, the memory of each owner and the measurement of each resource instance at the
   * same time. `writes` gives the MB that each owner wrote in the minute. An owner that wrote with no process at this time
   * gets a row with no memory.
   */
  saveSample(
    at: number,
    memory: SystemMemory,
    owners: readonly OwnerUsage[],
    load?: SessionLoad,
    resources: readonly Measurement[] = [],
    writes: ReadonlyMap<string, { readonly kind: OwnerKind; readonly mb: number }> = new Map(),
    reads: ReadonlyMap<string, { readonly kind: OwnerKind; readonly mb: number }> = new Map(),
    readers: readonly ProcessReads[] = [],
  ): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO memory (at, total_mb, available_mb, commit_mb, commit_limit_mb, kernel_paged_mb, kernel_nonpaged_mb,
           processes, user_objects, gdi_objects) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at, memory.totalMb, memory.availableMb, memory.commitMb, memory.commitLimitMb, memory.kernelPagedMb, memory.kernelNonpagedMb,
        load?.processes ?? null, load?.userObjects ?? null, load?.gdiObjects ?? null,
      );
    const insert = this.#db.prepare(
      "INSERT OR REPLACE INTO owners (at, owner, kind, private_mb, working_mb, processes, write_mb, read_mb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const rounded = (mb: number | undefined): number | null => (mb === undefined ? null : Math.round(mb * 1000) / 1000);
    const writeOf = (owner: string): number | null => rounded(writes.get(owner)?.mb);
    const readOf = (owner: string): number | null => rounded(reads.get(owner)?.mb);
    for (const owner of owners) insert.run(at, owner.owner, owner.kind, owner.privateMb, owner.workingMb, owner.processes, writeOf(owner.owner), readOf(owner.owner));
    const listed = new Set(owners.map((owner) => owner.owner));
    for (const [owner, each] of [...writes, ...reads]) {
      if (listed.has(owner)) continue;
      listed.add(owner);
      insert.run(at, owner, each.kind, 0, 0, 0, writeOf(owner), readOf(owner));
    }
    const reader = this.#db.prepare("INSERT OR REPLACE INTO readers (at, pid, name, owner, read_mb) VALUES (?, ?, ?, ?, ?)");
    for (const each of readers) reader.run(at, each.pid, each.name, each.owner, each.mb);
    const level = this.#db.prepare("INSERT OR REPLACE INTO resource_samples VALUES (?, ?, ?, ?, ?)");
    for (const each of resources) level.run(at, each.id, each.capacity, each.used, each.free);
  }

  /**
   * This function reads the measurements of the resource instances since a time, the oldest first. With a step longer
   * than one minute, each row is the average of the samples of one instance in one step, as in `memorySince`.
   */
  resourcesSince(since: number, stepMs = 0): ResourceRow[] {
    const nullable = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
    const step = Math.floor(stepMs);
    const query =
      step > 60_000
        ? `SELECT CAST(at / ${step} AS INTEGER) * ${step} AS at, id, AVG(capacity) AS capacity, AVG(used) AS used, AVG(free) AS free
           FROM resource_samples WHERE at >= ? GROUP BY CAST(at / ${step} AS INTEGER), id ORDER BY at, id`
        : "SELECT * FROM resource_samples WHERE at >= ? ORDER BY at, id";
    return this.#db.prepare(query).all(since).map((row) => ({
      at: Number(row["at"]),
      id: String(row["id"]),
      capacity: nullable(row["capacity"]),
      used: nullable(row["used"]),
      free: nullable(row["free"]),
    }));
  }

  /** This function reads the samples of one resource instance since a time, the oldest first, for example `procs` (H63). */
  resourceSince(id: string, since: number): ResourceRow[] {
    const nullable = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
    return this.#db.prepare("SELECT * FROM resource_samples WHERE at >= ? AND id = ? ORDER BY at").all(since, id).map((row) => ({
      at: Number(row["at"]),
      id: String(row["id"]),
      capacity: nullable(row["capacity"]),
      used: nullable(row["used"]),
      free: nullable(row["free"]),
    }));
  }

  /**
   * This function reads the memory samples since a time, the oldest first. With a step longer than one
   * minute, each row is the average of the samples of one step, so a long window stays small.
   */
  memorySince(since: number, stepMs = 0): MemoryRow[] {
    const step = Math.floor(stepMs);
    const query =
      step > 60_000
        ? `SELECT CAST(at / ${step} AS INTEGER) * ${step} AS at, AVG(total_mb) AS total_mb, AVG(available_mb) AS available_mb,
             AVG(commit_mb) AS commit_mb, AVG(commit_limit_mb) AS commit_limit_mb, AVG(kernel_paged_mb) AS kernel_paged_mb,
             AVG(kernel_nonpaged_mb) AS kernel_nonpaged_mb, MAX(processes) AS processes, MAX(user_objects) AS user_objects,
             MAX(gdi_objects) AS gdi_objects
           FROM memory WHERE at >= ? GROUP BY CAST(at / ${step} AS INTEGER) ORDER BY at`
        : "SELECT * FROM memory WHERE at >= ? ORDER BY at";
    return this.#db.prepare(query).all(since).map((row) => ({
      at: Number(row["at"]),
      totalMb: Number(row["total_mb"]),
      availableMb: Number(row["available_mb"]),
      commitMb: Number(row["commit_mb"]),
      commitLimitMb: Number(row["commit_limit_mb"]),
      kernelPagedMb: Number(row["kernel_paged_mb"]),
      kernelNonpagedMb: Number(row["kernel_nonpaged_mb"]),
      processes: row["processes"] == null ? null : Number(row["processes"]),
      userObjects: row["user_objects"] == null ? null : Number(row["user_objects"]),
      gdiObjects: row["gdi_objects"] == null ? null : Number(row["gdi_objects"]),
    }));
  }

  /** This function reads the owner samples since a time, the oldest first. A step longer than one minute averages each step. */
  ownersSince(since: number, stepMs = 0): OwnerRow[] {
    const step = Math.floor(stepMs);
    const query =
      step > 60_000
        ? `SELECT CAST(at / ${step} AS INTEGER) * ${step} AS at, owner, MAX(kind) AS kind, AVG(private_mb) AS private_mb,
             AVG(working_mb) AS working_mb, MAX(processes) AS processes, SUM(write_mb) AS write_mb, SUM(read_mb) AS read_mb
           FROM owners WHERE at >= ? GROUP BY CAST(at / ${step} AS INTEGER), owner ORDER BY at, private_mb DESC`
        : "SELECT * FROM owners WHERE at >= ? ORDER BY at, private_mb DESC";
    return this.#db.prepare(query).all(since).map((row) => ({
      at: Number(row["at"]),
      owner: String(row["owner"]),
      kind: String(row["kind"]) as OwnerKind,
      privateMb: Number(row["private_mb"]),
      workingMb: Number(row["working_mb"]),
      processes: Number(row["processes"]),
      ...(row["write_mb"] == null ? {} : { writeMb: Number(row["write_mb"]) }),
      ...(row["read_mb"] == null ? {} : { readMb: Number(row["read_mb"]) }),
    }));
  }

  /** This function reads the MB that each owner read in each minute since a time, the oldest first. A minute with no reads is absent (H66). */
  readsSince(since: number): CounterRow[] {
    return this.#db.prepare("SELECT at, owner, kind, read_mb FROM owners WHERE at >= ? AND read_mb > 0 ORDER BY at, owner").all(since).map((row) => ({
      at: Number(row["at"]),
      owner: String(row["owner"]),
      kind: String(row["kind"]) as OwnerKind,
      amount: Number(row["read_mb"]),
    }));
  }

  /** This function reads the processes that read much in each minute since a time, the oldest first, and the largest first in a minute (H66). */
  readersSince(since: number): ReaderRow[] {
    return this.#db.prepare("SELECT * FROM readers WHERE at >= ? ORDER BY at, read_mb DESC").all(since).map((row) => ({
      at: Number(row["at"]),
      pid: Number(row["pid"]),
      name: String(row["name"]),
      owner: String(row["owner"]),
      mb: Number(row["read_mb"]),
    }));
  }

  /** This function reads the MB that each owner wrote in each minute since a time, the oldest first. A minute with no writes is absent. */
  writesSince(since: number): CounterRow[] {
    return this.#db.prepare("SELECT at, owner, kind, write_mb FROM owners WHERE at >= ? AND write_mb > 0 ORDER BY at, owner").all(since).map((row) => ({
      at: Number(row["at"]),
      owner: String(row["owner"]),
      kind: String(row["kind"]) as OwnerKind,
      amount: Number(row["write_mb"]),
    }));
  }

  /**
   * This function writes one snapshot of the pool tags. It keeps only the tags of 1 MB or more, because most
   * tags are small. Of the snapshots older than 48 hours, it keeps the first of each hour for 7 days. Thus the table
   * stays small, and the growth over days stays readable (H53). It keeps the first snapshot after the start of Windows
   * at each age, because the growth since the start is the measure of a leak. `prune` still removes old rows.
   */
  savePoolTags(at: number, tags: readonly PoolTag[], bootedAt = 0): void {
    const insert = this.#db.prepare("INSERT OR REPLACE INTO pool_tags VALUES (?, ?, ?, ?)");
    transaction(this.#db, () => {
      const firstAfterBoot = "SELECT COALESCE(MIN(at), -1) FROM pool_tags WHERE at >= ?";
      this.#db
        .prepare(`DELETE FROM pool_tags WHERE at < ? AND at NOT IN (${firstAfterBoot}) AND at NOT IN (SELECT MIN(at) FROM pool_tags GROUP BY at / 3600000)`)
        .run(at - POOL_TAGS_KEEP_MS, bootedAt);
      this.#db.prepare(`DELETE FROM pool_tags WHERE at < ? AND at NOT IN (${firstAfterBoot})`).run(at - POOL_TAGS_HOURLY_KEEP_MS, bootedAt);
      for (const tag of tags) {
        if (tag.nonPagedMb + tag.pagedMb >= 1) insert.run(at, tag.tag, tag.nonPagedMb, tag.pagedMb);
      }
    });
  }

  /**
   * This function reads the snapshots of the pool tags since a time, the oldest first. With a list of tags, it reads
   * only the rows of those tags. Thus a chart of some tags over days reads a small part of the table (H53).
   */
  poolTagsSince(since: number, tags?: readonly string[]): PoolTagSnapshot[] {
    if (tags === undefined) return this.#poolTagSnapshots("SELECT * FROM pool_tags WHERE at >= ? ORDER BY at, tag", [since]);
    if (tags.length === 0) return [];
    const marks = tags.map(() => "?").join(", ");
    return this.#poolTagSnapshots(`SELECT * FROM pool_tags WHERE at >= ? AND tag IN (${marks}) ORDER BY at, tag`, [since, ...tags]);
  }

  /** This function reads the snapshot of the pool tags at a time. It gives `undefined` when the store has no snapshot at that time. */
  poolTagsAt(at: number): PoolTagSnapshot | undefined {
    return this.#poolTagSnapshots("SELECT * FROM pool_tags WHERE at = ? ORDER BY tag", [at])[0];
  }

  /** This function reads the time of each snapshot of the pool tags since a time, the oldest first. */
  poolTagTimes(since: number): number[] {
    return this.#db.prepare("SELECT DISTINCT at FROM pool_tags WHERE at >= ? ORDER BY at").all(since).map((row) => Number(row["at"]));
  }

  /** This function groups the rows of a query of the pool tags into snapshots. The rows come in the order of their time. */
  #poolTagSnapshots(sql: string, params: readonly (number | string)[]): PoolTagSnapshot[] {
    const snapshots: { at: number; tags: Map<string, number>; paged: Map<string, number> }[] = [];
    for (const row of this.#db.prepare(sql).all(...params)) {
      const at = Number(row["at"]);
      let snapshot = snapshots.at(-1);
      if (snapshot?.at !== at) {
        snapshot = { at, tags: new Map(), paged: new Map() };
        snapshots.push(snapshot);
      }
      const tag = String(row["tag"]);
      snapshot.tags.set(tag, Number(row["nonpaged_mb"] ?? 0));
      snapshot.paged.set(tag, Number(row["paged_mb"] ?? 0));
    }
    return snapshots;
  }

  /** This function writes one sleep of the computer (H30). */
  saveSleep(from: number, to: number): void {
    this.#db.prepare("INSERT OR REPLACE INTO sleeps (from_at, to_at) VALUES (?, ?)").run(from, to);
  }

  /** This function reads the sleeps that end after a time, the oldest first. */
  sleepsSince(since: number): Sleep[] {
    return this.#db
      .prepare("SELECT from_at, to_at FROM sleeps WHERE to_at >= ? ORDER BY from_at")
      .all(since)
      .map((row) => [Number(row["from_at"]), Number(row["to_at"])] as const);
  }

  /** This function reads the owner records of the processes (H48), at most 4096. A record of an older version has the parent 0 (H182). */
  processOwners(): ProcessRecord[] {
    const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
    return this.#db
      .prepare("SELECT pid, created, ppid, parent_created, owner, session, session_id, command, first_seen FROM process_owners LIMIT ?")
      .all(RECORDS_MAX)
      .map((row) => ({
        pid: Number(row["pid"]),
        created: Number(row["created"]),
        ppid: Number(row["ppid"] ?? 0),
        parentCreated: Number(row["parent_created"] ?? 0),
        owner: String(row["owner"]),
        session: text(row["session"]),
        sessionId: text(row["session_id"]),
        command: text(row["command"]),
        firstSeen: Number(row["first_seen"]),
      }));
  }

  /**
   * This function writes the changes of the owner records of one read (H48). One statement removes the records of all the
   * ended processes. A read with no change writes nothing.
   */
  saveProcessOwners(changes: RecordChanges): void {
    if (changes.save.length === 0 && changes.ended.length === 0) return;
    transaction(this.#db, () => {
      if (changes.ended.length > 0) {
        const keys = JSON.stringify(changes.ended.map((record) => `${record.pid}:${record.created}`));
        this.#db.prepare("DELETE FROM process_owners WHERE pid || ':' || created IN (SELECT value FROM json_each(?))").run(keys);
      }
      const insert = this.#db.prepare(
        "INSERT OR REPLACE INTO process_owners (pid, created, ppid, parent_created, owner, session, session_id, command, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const record of changes.save) {
        insert.run(record.pid, record.created, record.ppid, record.parentCreated, record.owner, record.session, record.sessionId, record.command, record.firstSeen);
      }
    });
  }

  /**
   * This function writes the matches of one sample to the shadow log (H183). A process has one row. Each match adds one to
   * its count of samples, and keeps its last memory and its peak. A match also writes the start of its period above the
   * line, because a read below the line starts a new period.
   */
  saveShadow(at: number, matches: readonly ShadowMatch[]): void {
    if (matches.length === 0) return;
    transaction(this.#db, () => {
      const upsert = this.#db.prepare(
        `INSERT INTO reap_shadow (pid, created, name, first_at, last_at, above_since, samples, private_mb, peak_mb, owner, session, session_id, command, stdout)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pid, created) DO UPDATE SET last_at = excluded.last_at, samples = samples + 1, private_mb = excluded.private_mb,
           peak_mb = max(peak_mb, excluded.private_mb), above_since = excluded.above_since, session = excluded.session, session_id = excluded.session_id,
           stdout = excluded.stdout`,
      );
      for (const each of matches) {
        upsert.run(each.pid, each.created, each.name, at, at, each.aboveSince, each.privateMb, each.privateMb, each.owner, each.session, each.sessionId, each.command, each.stdout);
      }
    });
  }

  /** This function reads the shadow log (H183), the newest last match first, at most `REAP_ROWS_MAX` rows. */
  reapShadow(): ShadowRow[] {
    const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
    return this.#db
      .prepare("SELECT * FROM reap_shadow ORDER BY last_at DESC LIMIT ?")
      .all(REAP_ROWS_MAX)
      .map((row) => ({
        pid: Number(row["pid"]),
        created: Number(row["created"]),
        name: String(row["name"]),
        firstAt: Number(row["first_at"]),
        lastAt: Number(row["last_at"]),
        aboveSince: Number(row["above_since"]),
        samples: Number(row["samples"]),
        privateMb: Number(row["private_mb"]),
        peakMb: Number(row["peak_mb"]),
        owner: String(row["owner"]),
        session: text(row["session"]),
        sessionId: text(row["session_id"]),
        command: text(row["command"]),
        stdout: String(row["stdout"]) as StdoutKind,
      }));
  }

  /** This function writes one row of the reap log (H183). */
  saveReap(entry: ReapEntry): void {
    this.#db
      .prepare("INSERT INTO reap_log (at, pid, created, name, session, session_id, by_name, by_id, action, private_mb, command, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entry.at, entry.pid, entry.created, entry.name, entry.session, entry.sessionId, entry.by, entry.byId, entry.action, entry.privateMb, entry.command, entry.result);
  }

  /** This function reads the reap log (H183), the newest first, at most `REAP_ROWS_MAX` rows. */
  reapLog(): ReapEntry[] {
    return this.#db.prepare("SELECT * FROM reap_log ORDER BY at DESC, id DESC LIMIT ?").all(REAP_ROWS_MAX).map(reapEntry);
  }

  /**
   * This function reads the requests of the reap log at or after a time (H183). They are the rows with the action
   * `asked` or `needs-owner`, the newest first. A restart of the daemon reads them to show the alerts of the requests again.
   */
  reapRequests(since: number): ReapEntry[] {
    return this.#db
      .prepare("SELECT * FROM reap_log WHERE at >= ? AND action IN ('asked', 'needs-owner') ORDER BY at DESC, id DESC")
      .all(since)
      .map(reapEntry);
  }

  /** This function writes one row of the log of the refusals of long native paths (H203). */
  saveNativeRefusal(entry: NativeRefusalEntry): void {
    this.#db
      .prepare("INSERT INTO native_refusals (at, source, session, session_id, folder, nt_length, path_limit, basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entry.at, entry.source, entry.session, entry.sessionId, entry.folder, entry.ntLength, entry.limit, entry.basis);
  }

  /**
   * This function counts the refusals of long native paths (H203) at or after `from` and before `to`, for each session and
   * source. The session with the most refusals comes first. A refusal with no known session counts under the session `null`.
   */
  nativeRefusalCounts(from: number, to: number): NativeRefusalCount[] {
    return this.#db
      .prepare(
        `SELECT session, source, COUNT(*) AS refusals, COUNT(DISTINCT folder) AS folders, MAX(nt_length) AS longest,
         MIN(at) AS first_at, MAX(at) AS last_at FROM native_refusals WHERE at >= ? AND at < ?
         GROUP BY session, source ORDER BY refusals DESC, session`,
      )
      .all(from, to)
      .map((row) => ({
        session: row["session"] === null || row["session"] === undefined ? null : String(row["session"]),
        source: row["source"] === "run" ? "run" : "hook",
        refusals: Number(row["refusals"]),
        folders: Number(row["folders"]),
        longest: Number(row["longest"]),
        firstAt: Number(row["first_at"]),
        lastAt: Number(row["last_at"]),
      }));
  }

  /** This function writes the memory peaks of one minute (H62 part 5). Each command gets a mark in place of each secret (H186). */
  saveMemoryPeaks(at: number, peaks: readonly MemoryPeak[]): void {
    if (peaks.length === 0) return;
    const insert = this.#db.prepare(
      "INSERT OR REPLACE INTO memory_peaks (at, kind, key, name, owner, pid, created, lease, peak_mb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const holder = this.#db.prepare(
      `INSERT INTO peak_holders (kind, key, command, last_at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, key)
       DO UPDATE SET last_at = excluded.last_at, command = COALESCE(excluded.command, peak_holders.command)`,
    );
    transaction(this.#db, () => {
      for (const peak of peaks) {
        insert.run(at, peak.kind, peak.key, peak.name, peak.owner, peak.pid, peak.created, peak.lease, Math.round(peak.peakMb * 10) / 10);
        holder.run(peak.kind, peak.key, peak.command === null ? null : redactCommand(peak.command), at);
      }
    });
  }

  /**
   * This function gives the holders of the memory peaks since a time, the largest peak first (H62 part 5). Each holder
   * gives the row of its largest peak, its first and its last minute, and its count of minutes. `minMb` keeps only the
   * minutes with a peak of that amount or more. `lease` keeps only the minutes of one lease.
   */
  peaksSince(since: number, options: { readonly minMb?: number; readonly lease?: string | undefined; readonly limit?: number } = {}): PeakSummary[] {
    const lease = options.lease === undefined ? "" : "AND lease = ?";
    const args: (number | string)[] = [since, options.minMb ?? 0, ...(options.lease === undefined ? [] : [options.lease]), options.limit ?? 50];
    return this.#db
      .prepare(
        `SELECT p.*, h.command AS command FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY kind, key ORDER BY peak_mb DESC, at) AS n,
             MIN(at) OVER (PARTITION BY kind, key) AS first_at, MAX(at) OVER (PARTITION BY kind, key) AS last_at,
             COUNT(*) OVER (PARTITION BY kind, key) AS minutes
           FROM memory_peaks WHERE at >= ? AND peak_mb >= ? ${lease}
         ) AS p LEFT JOIN peak_holders AS h ON h.kind = p.kind AND h.key = p.key
         WHERE p.n = 1 ORDER BY p.peak_mb DESC, p.at LIMIT ?`,
      )
      .all(...args)
      .map((row) => ({
        ...peakOf(row),
        at: Number(row["at"]),
        firstAt: Number(row["first_at"]),
        lastAt: Number(row["last_at"]),
        minutes: Number(row["minutes"]),
      }));
  }

  /** This function gives the minutes of one holder since a time, the oldest first (H62 part 5). */
  peakTrail(kind: PeakKind, key: string, since: number): PeakPoint[] {
    return this.#db
      .prepare("SELECT at, peak_mb, lease FROM memory_peaks WHERE kind = ? AND key = ? AND at >= ? ORDER BY at")
      .all(kind, key, since)
      .map((row) => ({ at: Number(row["at"]), peakMb: Number(row["peak_mb"]), lease: row["lease"] === null || row["lease"] === undefined ? null : String(row["lease"]) }));
  }

  /**
   * This function removes the samples older than a time, and the leases that ended before the second time. The second
   * time is the first time by default. The rows of the shadow log, of the reap log (H183) and of the refusals (H203) go
   * before the third time. The third time is the second time by default.
   */
  prune(before: number, leasesBefore: number = before, reapBefore: number = leasesBefore): void {
    this.#db.prepare("DELETE FROM sleeps WHERE to_at < ?").run(before);
    this.#db.prepare("DELETE FROM memory WHERE at < ?").run(before);
    this.#db.prepare("DELETE FROM owners WHERE at < ?").run(before);
    this.#db.prepare("DELETE FROM readers WHERE at < ?").run(before);
    this.#db.prepare("DELETE FROM pool_tags WHERE at < ?").run(before);
    this.#db.prepare("DELETE FROM resource_samples WHERE at < ?").run(before);
    this.#db.prepare("DELETE FROM memory_peaks WHERE at < ?").run(before);
    this.#db.prepare("DELETE FROM peak_holders WHERE last_at < ?").run(before);
    this.#db.prepare("DELETE FROM leases WHERE ended_at IS NOT NULL AND ended_at < ?").run(leasesBefore);
    this.#db.prepare("DELETE FROM lease_keys WHERE lease_id NOT IN (SELECT id FROM leases)").run();
    this.#db.prepare("DELETE FROM reap_shadow WHERE last_at < ?").run(reapBefore);
    this.#db.prepare("DELETE FROM reap_log WHERE at < ?").run(reapBefore);
    this.#db.prepare("DELETE FROM native_refusals WHERE at < ?").run(reapBefore);
  }

  /** This function closes the database. */
  close(): void {
    this.#db.close();
  }
}

/** This function gives the peak of one row of the table of the memory peaks (H62 part 5). */
function peakOf(row: Record<string, unknown>): MemoryPeak {
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  const number = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
  return {
    kind: row["kind"] === "container" ? "container" : "process",
    key: String(row["key"]),
    name: String(row["name"]),
    owner: text(row["owner"]),
    pid: number(row["pid"]),
    created: number(row["created"]),
    lease: text(row["lease"]),
    peakMb: Number(row["peak_mb"]),
    command: text(row["command"]),
  };
}

/** This function gives the entry of one row of the reap log (H183). */
function reapEntry(row: Record<string, unknown>): ReapEntry {
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  return {
    at: Number(row["at"]),
    pid: Number(row["pid"]),
    created: Number(row["created"]),
    name: String(row["name"]),
    session: text(row["session"]),
    sessionId: text(row["session_id"]),
    by: text(row["by_name"]),
    byId: text(row["by_id"]),
    action: String(row["action"]) as ReapAction,
    privateMb: Number(row["private_mb"]),
    command: text(row["command"]),
    result: String(row["result"]),
  };
}

function toLease(row: Record<string, unknown>): Lease {
  const nullable = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
  return {
    id: String(row["id"]),
    holder: String(row["holder"]),
    job: String(row["job"]),
    amounts: JSON.parse(String(row["amounts"])) as Amounts,
    priority: Number(row["priority"]),
    pid: nullable(row["pid"]),
    ttlMs: Number(row["ttl_ms"]),
    state: String(row["state"]) as LeaseState,
    requestedAt: Number(row["requested_at"]),
    grantedAt: nullable(row["granted_at"]),
    endedAt: nullable(row["ended_at"]),
    heartbeatAt: Number(row["heartbeat_at"]),
    reason: row["reason"] === null || row["reason"] === undefined ? null : String(row["reason"]),
    peakMb: nullable(row["peak_mb"]),
    ...(row["usage"] === null || row["usage"] === undefined ? {} : { usage: JSON.parse(String(row["usage"])) as JobUsage }),
    ...(row["exit_code"] === null || row["exit_code"] === undefined ? {} : { exitCode: Number(row["exit_code"]) }),
    ...(row["signal"] === null || row["signal"] === undefined ? {} : { signal: String(row["signal"]) }),
    ...(row["log"] === null || row["log"] === undefined ? {} : { log: String(row["log"]) }),
    ...(row["processes"] === null || row["processes"] === undefined ? {} : { processes: Number(row["processes"]) }),
    ...(row["peak_starts_per_min"] === null || row["peak_starts_per_min"] === undefined ? {} : { peakStartsPerMin: Number(row["peak_starts_per_min"]) }),
    ...(row["spawn"] === null || row["spawn"] === undefined ? {} : { spawn: JSON.parse(String(row["spawn"])) as SpawnClass }),
    ...(row["conditions"] === null || row["conditions"] === undefined ? {} : { conditions: JSON.parse(String(row["conditions"])) as LeaseConditions }),
    ...(row["conditions_met_at"] === null || row["conditions_met_at"] === undefined ? {} : { conditionsMetAt: Number(row["conditions_met_at"]) }),
    ...(row["unmet"] === null || row["unmet"] === undefined ? {} : { unmet: JSON.parse(String(row["unmet"])) as UnmetCondition }),
    ...(row["cpu_cap"] === null || row["cpu_cap"] === undefined ? {} : { cpuCap: Number(row["cpu_cap"]) }),
    ...(row["peak_cores"] === null || row["peak_cores"] === undefined ? {} : { peakCores: Number(row["peak_cores"]) }),
    ...(row["peak_gpu_mb"] === null || row["peak_gpu_mb"] === undefined ? {} : { peakGpuMb: Number(row["peak_gpu_mb"]) }),
    ...(row["cancelled_by"] === null || row["cancelled_by"] === undefined ? {} : { cancelledBy: String(row["cancelled_by"]) }),
    ...(row["folder"] === null || row["folder"] === undefined ? {} : { folder: String(row["folder"]) }),
  };
}
