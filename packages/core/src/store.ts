/**
 * The store of headroom: one SQLite file in WAL mode, through `node:sqlite`.
 *
 * It keeps the leases, the capacity of the configured pools, one memory sample each minute and
 * the memory of each owner each minute. It also keeps the level of each resource instance each minute,
 * the snapshots of the pool tags and the settings. It removes the samples that are older than the retention.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Lease, LeaseState } from "./broker.ts";
import type { JobUsage, Measurement } from "./resources.ts";
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
  private_mb INTEGER, working_mb INTEGER, processes INTEGER, PRIMARY KEY (at, owner)
);
CREATE TABLE IF NOT EXISTS pool_tags (
  at INTEGER NOT NULL, tag TEXT NOT NULL, nonpaged_mb REAL, paged_mb REAL, PRIMARY KEY (at, tag)
);
CREATE TABLE IF NOT EXISTS resource_samples (
  at INTEGER NOT NULL, id TEXT NOT NULL, capacity REAL, used REAL, free REAL, PRIMARY KEY (at, id)
);
CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** The settings of headroom. The store keeps them, and `headroom config` shows and changes them. */
export interface Config {
  /**
   * The temp root (H19), for example `D:\headroom\tmp`. Each job of `headroom run` gets the folder `<jobTemp>\<lease id>`
   * for its `TEMP`, `TMP` and `TMPDIR`. Without it, a job keeps the `TEMP` of its parent.
   */
  readonly jobTemp: string | null;
}

/** One stored measurement of a resource instance, in the unit of its kind. */
export interface ResourceRow extends Measurement {
  readonly at: number;
}

/** The time that the store keeps a snapshot of the pool tags. */
const POOL_TAGS_KEEP_MS = 2 * 3_600_000;

/** One stored snapshot of the pool tags: the non-paged and the paged pool of each tag, in MB. */
export interface PoolTagSnapshot {
  readonly at: number;
  readonly tags: ReadonlyMap<string, number>;
  readonly paged: ReadonlyMap<string, number>;
}

/** The store. */
export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.#db.exec(SCHEMA);
    // A database of an older version has no column for the peak memory of a lease.
    const columns = this.#db.prepare("PRAGMA table_info(leases)").all().map((row) => String(row["name"]));
    if (!columns.includes("peak_mb")) this.#db.exec("ALTER TABLE leases ADD COLUMN peak_mb REAL");
    if (!columns.includes("usage")) this.#db.exec("ALTER TABLE leases ADD COLUMN usage TEXT");
    const memoryColumns = this.#db.prepare("PRAGMA table_info(memory)").all().map((row) => String(row["name"]));
    for (const column of ["processes", "user_objects", "gdi_objects"]) {
      if (!memoryColumns.includes(column)) this.#db.exec(`ALTER TABLE memory ADD COLUMN ${column} INTEGER`);
    }
  }

  /** This function writes a lease, new or changed. */
  saveLease(lease: Lease): void {
    this.#db
      .prepare(
        `INSERT INTO leases (id, holder, job, amounts, priority, pid, ttl_ms, state, requested_at, granted_at, ended_at, heartbeat_at, reason, peak_mb, usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, granted_at = excluded.granted_at,
           ended_at = excluded.ended_at, heartbeat_at = excluded.heartbeat_at, reason = excluded.reason, peak_mb = excluded.peak_mb,
           usage = excluded.usage`,
      )
      .run(
        lease.id, lease.holder, lease.job, JSON.stringify(lease.amounts), lease.priority, lease.pid, lease.ttlMs,
        lease.state, lease.requestedAt, lease.grantedAt, lease.endedAt, lease.heartbeatAt, lease.reason, lease.peakMb,
        lease.usage === undefined ? null : JSON.stringify(lease.usage),
      );
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
    return { jobTemp: values.get("jobTemp") ?? null };
  }

  /** This function sets one setting. `null` removes it. */
  setConfig(name: keyof Config, value: string | null): void {
    if (value === null) this.#db.prepare("DELETE FROM settings WHERE name = ?").run(name);
    else this.#db.prepare("INSERT INTO settings VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value").run(name, value);
  }

  /** This function reads the leases that ended after a time, the newest first. */
  endedLeases(since: number, limit = 100): Lease[] {
    return this.#db.prepare("SELECT * FROM leases WHERE ended_at >= ? ORDER BY ended_at DESC LIMIT ?").all(since, limit).map(toLease);
  }

  /** This function reads the peak memory of the last runs of a job, the newest first. With a holder, only the runs of that holder. */
  peaksOf(job: string, holder?: string, limit = 20): number[] {
    const rows = holder === undefined
      ? this.#db.prepare("SELECT peak_mb FROM leases WHERE job = ? AND peak_mb IS NOT NULL ORDER BY ended_at DESC LIMIT ?").all(job, limit)
      : this.#db.prepare("SELECT peak_mb FROM leases WHERE job = ? AND holder = ? AND peak_mb IS NOT NULL ORDER BY ended_at DESC LIMIT ?").all(job, holder, limit);
    return rows.map((row) => Number(row["peak_mb"]));
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

  /** This function writes one memory sample, the memory of each owner and the measurement of each resource instance at the same time. */
  saveSample(at: number, memory: SystemMemory, owners: readonly OwnerUsage[], load?: SessionLoad, resources: readonly Measurement[] = []): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO memory (at, total_mb, available_mb, commit_mb, commit_limit_mb, kernel_paged_mb, kernel_nonpaged_mb,
           processes, user_objects, gdi_objects) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at, memory.totalMb, memory.availableMb, memory.commitMb, memory.commitLimitMb, memory.kernelPagedMb, memory.kernelNonpagedMb,
        load?.processes ?? null, load?.userObjects ?? null, load?.gdiObjects ?? null,
      );
    const insert = this.#db.prepare("INSERT OR REPLACE INTO owners VALUES (?, ?, ?, ?, ?, ?)");
    for (const owner of owners) insert.run(at, owner.owner, owner.kind, owner.privateMb, owner.workingMb, owner.processes);
    const level = this.#db.prepare("INSERT OR REPLACE INTO resource_samples VALUES (?, ?, ?, ?, ?)");
    for (const each of resources) level.run(at, each.id, each.capacity, each.used, each.free);
  }

  /** This function reads the measurements of the resource instances since a time, the oldest first. */
  resourcesSince(since: number): ResourceRow[] {
    const nullable = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
    return this.#db.prepare("SELECT * FROM resource_samples WHERE at >= ? ORDER BY at, id").all(since).map((row) => ({
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
             AVG(working_mb) AS working_mb, MAX(processes) AS processes
           FROM owners WHERE at >= ? GROUP BY CAST(at / ${step} AS INTEGER), owner ORDER BY at, private_mb DESC`
        : "SELECT * FROM owners WHERE at >= ? ORDER BY at, private_mb DESC";
    return this.#db.prepare(query).all(since).map((row) => ({
      at: Number(row["at"]),
      owner: String(row["owner"]),
      kind: String(row["kind"]) as OwnerKind,
      privateMb: Number(row["private_mb"]),
      workingMb: Number(row["working_mb"]),
      processes: Number(row["processes"]),
    }));
  }

  /**
   * This function writes one snapshot of the pool tags. It keeps only the tags of 1 MB or more, because most
   * tags are small. It also removes the snapshots that are older than 2 hours, so the table stays small.
   */
  savePoolTags(at: number, tags: readonly PoolTag[]): void {
    const insert = this.#db.prepare("INSERT OR REPLACE INTO pool_tags VALUES (?, ?, ?, ?)");
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("DELETE FROM pool_tags WHERE at < ?").run(at - POOL_TAGS_KEEP_MS);
      for (const tag of tags) {
        if (tag.nonPagedMb + tag.pagedMb >= 1) insert.run(at, tag.tag, tag.nonPagedMb, tag.pagedMb);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** This function reads the snapshots of the pool tags since a time, the oldest first. */
  poolTagsSince(since: number): PoolTagSnapshot[] {
    const snapshots: { at: number; tags: Map<string, number>; paged: Map<string, number> }[] = [];
    for (const row of this.#db.prepare("SELECT * FROM pool_tags WHERE at >= ? ORDER BY at, tag").all(since)) {
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

  /** This function removes the samples older than a time, and the leases that ended before it. */
  prune(before: number): void {
    this.#db.prepare("DELETE FROM memory WHERE at < ?").run(before);
    this.#db.prepare("DELETE FROM owners WHERE at < ?").run(before);
    this.#db.prepare("DELETE FROM pool_tags WHERE at < ?").run(before);
    this.#db.prepare("DELETE FROM resource_samples WHERE at < ?").run(before);
    this.#db.prepare("DELETE FROM leases WHERE ended_at IS NOT NULL AND ended_at < ?").run(before);
  }

  /** This function closes the database. */
  close(): void {
    this.#db.close();
  }
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
  };
}
