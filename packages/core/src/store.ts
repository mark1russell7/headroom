/**
 * The store of headroom: one SQLite file in WAL mode, through `node:sqlite`.
 *
 * It keeps the leases, the capacity of the configured pools, one memory sample each minute and
 * the memory of each owner each minute. It removes the samples that are older than the retention.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Lease, LeaseState } from "./broker.ts";
import type { Amounts, McpServerSpec, OwnerKind, OwnerUsage, SystemMemory } from "./types.ts";

/** One stored memory sample. */
export interface MemoryRow extends SystemMemory {
  readonly at: number;
}

/** One stored owner sample. */
export interface OwnerRow extends OwnerUsage {
  readonly at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY, holder TEXT NOT NULL, job TEXT NOT NULL, amounts TEXT NOT NULL,
  priority INTEGER NOT NULL, pid INTEGER, ttl_ms INTEGER NOT NULL, state TEXT NOT NULL,
  requested_at INTEGER NOT NULL, granted_at INTEGER, ended_at INTEGER, heartbeat_at INTEGER NOT NULL, reason TEXT
);
CREATE INDEX IF NOT EXISTS leases_state ON leases (state);
CREATE TABLE IF NOT EXISTS pools (name TEXT PRIMARY KEY, capacity REAL NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_servers (name TEXT PRIMARY KEY, spec TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory (
  at INTEGER PRIMARY KEY, total_mb INTEGER, available_mb INTEGER, commit_mb INTEGER,
  commit_limit_mb INTEGER, kernel_paged_mb INTEGER, kernel_nonpaged_mb INTEGER
);
CREATE TABLE IF NOT EXISTS owners (
  at INTEGER NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
  private_mb INTEGER, working_mb INTEGER, processes INTEGER, PRIMARY KEY (at, owner)
);
`;

/** The store. */
export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.#db.exec(SCHEMA);
  }

  /** This function writes a lease, new or changed. */
  saveLease(lease: Lease): void {
    this.#db
      .prepare(
        `INSERT INTO leases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, granted_at = excluded.granted_at,
           ended_at = excluded.ended_at, heartbeat_at = excluded.heartbeat_at, reason = excluded.reason`,
      )
      .run(
        lease.id, lease.holder, lease.job, JSON.stringify(lease.amounts), lease.priority, lease.pid, lease.ttlMs,
        lease.state, lease.requestedAt, lease.grantedAt, lease.endedAt, lease.heartbeatAt, lease.reason,
      );
  }

  /** This function reads the active leases: the waiting and the granted ones. */
  activeLeases(): Lease[] {
    return this.#db.prepare("SELECT * FROM leases WHERE state IN ('waiting', 'granted')").all().map(toLease);
  }

  /** This function reads the leases that ended after a time, the newest first. */
  endedLeases(since: number, limit = 100): Lease[] {
    return this.#db.prepare("SELECT * FROM leases WHERE ended_at >= ? ORDER BY ended_at DESC LIMIT ?").all(since, limit).map(toLease);
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

  /** This function writes one memory sample and the memory of each owner at the same time. */
  saveSample(at: number, memory: SystemMemory, owners: readonly OwnerUsage[]): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO memory VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(at, memory.totalMb, memory.availableMb, memory.commitMb, memory.commitLimitMb, memory.kernelPagedMb, memory.kernelNonpagedMb);
    const insert = this.#db.prepare("INSERT OR REPLACE INTO owners VALUES (?, ?, ?, ?, ?, ?)");
    for (const owner of owners) insert.run(at, owner.owner, owner.kind, owner.privateMb, owner.workingMb, owner.processes);
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
             AVG(kernel_nonpaged_mb) AS kernel_nonpaged_mb
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

  /** This function removes the samples older than a time, and the leases that ended before it. */
  prune(before: number): void {
    this.#db.prepare("DELETE FROM memory WHERE at < ?").run(before);
    this.#db.prepare("DELETE FROM owners WHERE at < ?").run(before);
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
  };
}
