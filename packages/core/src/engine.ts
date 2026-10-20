/**
 * The engine joins the sampler, the owners, the broker and the store. It has no timer: its caller
 * calls `tick()` every few seconds, and after each request and each release.
 */

import { DEFAULT_ALERT_RULES, detect, type Alert, type AlertRules } from "./alerts.ts";
import { Broker, isActive, type Capacity, type Lease, type LeaseRequest } from "./broker.ts";
import { attribute, readSessions, sessionsDir, treeMb } from "./owners.ts";
import type { Sampler } from "./sampler.ts";
import type { MemoryRow, OwnerRow, Store } from "./store.ts";
import type { McpServerSpec, OwnerUsage, ProcessInfo, SessionInfo, SystemMemory } from "./types.ts";

/** The options of an engine. */
export interface EngineOptions {
  readonly sampler: Sampler;
  readonly store: Store;
  readonly now?: (() => number) | undefined;
  /** The memory that the broker keeps free, in MB. The default is 1024. */
  readonly reserveMb?: number | undefined;
  /** The limits of the alerts. The default is `DEFAULT_ALERT_RULES`. */
  readonly alertRules?: AlertRules | undefined;
  /** The time between two reads of the process list. The default is 10 seconds. */
  readonly processEveryMs?: number | undefined;
  /** The time between two samples in the store. The default is 1 minute. */
  readonly recordEveryMs?: number | undefined;
  /** The time that the store keeps the samples and the ended leases. The default is 7 days. */
  readonly retentionMs?: number | undefined;
  /** The folder of the Claude Code session files. */
  readonly sessionsDir?: string | undefined;
  /** This function gives the process of each server of the MCP gateway, with the name of the server. */
  readonly servers?: (() => ReadonlyMap<number, string>) | undefined;
}

/** The state of the engine at one time. */
export interface Status {
  readonly at: number;
  readonly memory: SystemMemory;
  readonly reserveMb: number;
  /** The amounts that a new lease can get at this time. */
  readonly free: Record<string, number>;
  readonly pools: Record<string, number>;
  readonly leases: readonly Lease[];
  readonly owners: readonly OwnerUsage[];
  readonly sessions: readonly SessionInfo[];
  /** The active alerts, the oldest first. */
  readonly alerts: readonly Alert[];
  /** The process of the daemon: its ID, its private memory in MB from the last read of the processes, and its start. */
  readonly self: { readonly pid: number; readonly privateMb: number; readonly startedAt: number };
}

/** An alert that ended. */
export interface EndedAlert extends Alert {
  readonly endedAt: number;
}

/** A memory amount for a job, from the peaks of its last runs. */
export interface Suggestion {
  /** The amount in MB, or `null` when no run of the job has a peak. */
  readonly memoryMb: number | null;
  /** The number of runs that the amount uses. */
  readonly runs: number;
  /** The highest peak of those runs in MB. */
  readonly peakMb: number | null;
}

/** One pool tag: its non-paged size and its change over the window, in MB. */
export interface PoolTagRow {
  readonly tag: string;
  readonly nonPagedMb: number;
  readonly growthMb: number;
}

/** The non-paged pool by tag over the last hour. */
export interface PoolTags {
  /** The time of the last snapshot. It is `null` before the first snapshot, and on a platform with no tags. */
  readonly at: number | null;
  /** The time of the first snapshot of the window. */
  readonly sinceAt: number | null;
  readonly largest: readonly PoolTagRow[];
  readonly growing: readonly PoolTagRow[];
}

/** The time that an event alert stays active. */
const EVENT_MS = 15 * 60_000;
/** The window in which two cut clients of `headroom run` start a stop alert. */
const STOP_WINDOW_MS = 2 * 60_000;
const POOL_TAGS_EVERY_MS = 5 * 60_000;
const POOL_TAGS_KEEP_MS = 60 * 60_000;
const round = (mb: number): number => Math.round(mb * 10) / 10;

/** The active alerts and the alerts that ended last. */
export interface Alerts {
  readonly active: readonly Alert[];
  readonly ended: readonly EndedAlert[];
}

/** The history since a time. */
export interface History {
  readonly memory: readonly MemoryRow[];
  readonly owners: readonly OwnerRow[];
  readonly leases: readonly Lease[];
}

/** The engine. */
export class Engine {
  readonly #sampler: Sampler;
  readonly #store: Store;
  readonly #broker: Broker;
  readonly #now: () => number;
  readonly #reserveMb: number;
  readonly #processEveryMs: number;
  /** The snapshots of the non-paged pool by tag, in MB, of the last hour. */
  #tags: { readonly at: number; readonly tags: ReadonlyMap<string, number> }[] = [];
  #tagsAt = 0;
  readonly #recordEveryMs: number;
  readonly #retentionMs: number;
  readonly #sessionsDir: string;
  readonly #servers: () => ReadonlyMap<number, string>;
  readonly #listeners = new Set<(changed: readonly Lease[]) => void>();
  #memory: SystemMemory;
  #processes: readonly ProcessInfo[] = [];
  #owners: readonly OwnerUsage[] = [];
  readonly #alertRules: AlertRules;
  readonly #alerts = new Map<string, Alert>();
  #ended: EndedAlert[] = [];
  /** The event alerts, with the time when each one ends. */
  readonly #events = new Map<string, { readonly alert: Omit<Alert, "since">; readonly until: number }>();
  /** The leases of the last minutes that ended because their process exited. */
  #cut: { readonly at: number; readonly lease: Lease }[] = [];
  #sessions: readonly SessionInfo[] = [];
  #processesAt = 0;
  #recordedAt = 0;
  #prunedAt = 0;
  readonly #startedAt: number;

  constructor(options: EngineOptions) {
    this.#sampler = options.sampler;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#reserveMb = options.reserveMb ?? 1024;
    this.#processEveryMs = options.processEveryMs ?? 10_000;
    this.#recordEveryMs = options.recordEveryMs ?? 60_000;
    this.#retentionMs = options.retentionMs ?? 7 * 24 * 3_600_000;
    this.#sessionsDir = options.sessionsDir ?? sessionsDir();
    this.#servers = options.servers ?? (() => new Map());
    this.#alertRules = options.alertRules ?? DEFAULT_ALERT_RULES;
    this.#startedAt = this.#now();
    this.#broker = new Broker({
      now: this.#now,
      reserveMb: this.#reserveMb,
      usedMb: (lease) => (lease.pid === null ? 0 : treeMb(lease.pid, this.#processes)),
    });
    this.#broker.restore(this.#store.activeLeases());
    this.#memory = this.#sampler.memory();
  }

  /** This function gives the capacity at this time. */
  capacity(): Capacity {
    return { totalMb: this.#memory.totalMb, availableMb: this.#memory.availableMb, pools: this.#store.pools() };
  }

  /**
   * This function reads the memory, and the processes when they are due. Then it ends and grants
   * leases, writes the changes to the store, and writes a sample when one is due.
   */
  tick(): Lease[] {
    const now = this.#now();
    this.#memory = this.#sampler.memory();
    if (now - this.#processesAt >= this.#processEveryMs) {
      this.#processesAt = now;
      this.#processes = this.#sampler.processes();
      this.#sessions = readSessions(this.#sessionsDir);
      const { owners, ownerOf } = attribute(this.#processes, this.#sessions, this.#memory, undefined, this.#servers());
      this.#owners = owners;
      if (this.#sampler.poolTags && now - this.#tagsAt >= POOL_TAGS_EVERY_MS) {
        this.#tagsAt = now;
        const tags = new Map(this.#sampler.poolTags().map((tag) => [tag.tag, tag.nonPagedMb]));
        this.#tags = [...this.#tags.filter((snapshot) => now - snapshot.at <= POOL_TAGS_KEEP_MS), { at: now, tags }];
      }
      this.#check(now, ownerOf);
    }
    const changed = this.#broker.tick(this.capacity());
    this.#persist(changed);
    if (now - this.#recordedAt >= this.#recordEveryMs) {
      this.#recordedAt = now;
      this.#store.saveSample(now, this.#memory, this.#owners);
    }
    if (now - this.#prunedAt >= 3_600_000) {
      this.#prunedAt = now;
      this.#store.prune(now - this.#retentionMs);
      this.#broker.forget(now - 3_600_000);
    }
    return changed;
  }

  /** This function adds a request and grants it at once when it fits. */
  request(request: LeaseRequest): Lease {
    const lease = this.#broker.request(request);
    this.#persist([lease]);
    this.#persist(this.#broker.tick(this.capacity()));
    return this.#broker.get(lease.id) ?? lease;
  }

  /** This function ends a lease. Then it grants the waiting leases that fit in the memory that the lease frees. */
  release(id: string, reason?: string, peakMb?: number | null): Lease | undefined {
    const lease = this.#broker.release(id, reason, peakMb ?? null);
    if (lease) this.#persist([lease]);
    this.#persist(this.#broker.tick(this.capacity()));
    return lease ? (this.#broker.get(id) ?? lease) : undefined;
  }

  /**
   * This function gives a memory amount for a job from the peaks of its last runs. The amount is the 90th percentile
   * and 25% more, rounded up to 64 MB. It prefers the runs of the same holder. Without a run, it gives `null`.
   */
  suggest(job: string, holder?: string): Suggestion {
    const own = holder === undefined ? [] : this.#store.peaksOf(job, holder);
    const peaks = own.length > 0 ? own : this.#store.peaksOf(job);
    if (peaks.length === 0) return { memoryMb: null, runs: 0, peakMb: null };
    const sorted = [...peaks].sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0;
    return { memoryMb: Math.max(256, Math.ceil((p90 * 1.25) / 64) * 64), runs: peaks.length, peakMb: Math.round(sorted[sorted.length - 1] ?? 0) };
  }

  /** This function records a heartbeat of a lease. */
  renew(id: string): Lease | undefined {
    const lease = this.#broker.renew(id);
    if (lease) this.#store.saveLease(lease);
    return lease;
  }

  /** This function gives one lease. */
  get(id: string): Lease | undefined {
    return this.#broker.get(id);
  }

  /** This function sets the capacity of a pool. A capacity below 0 removes it. */
  setPool(name: string, capacity: number): void {
    this.#store.setPool(name, capacity);
    this.#persist(this.#broker.tick(this.capacity()));
  }

  /** This function reads the servers of the MCP gateway, by name. */
  mcpServers(): Record<string, McpServerSpec> {
    return this.#store.mcpServers();
  }

  /** This function adds or changes a server of the MCP gateway. `null` removes it. */
  setMcpServer(name: string, spec: McpServerSpec | null): void {
    this.#store.setMcpServer(name, spec);
  }

  /** This function gives the memory of one process and its descendants, in MB, from the last read of the processes. */
  treeMb(pid: number): number {
    return treeMb(pid, this.#processes);
  }

  /** This function gives the state at this time. */
  status(): Status {
    const capacity = this.capacity();
    return {
      at: this.#now(),
      memory: this.#memory,
      reserveMb: this.#reserveMb,
      free: this.#broker.free(capacity),
      pools: { ...capacity.pools },
      leases: this.#broker.leases().filter(isActive),
      owners: this.#owners,
      sessions: this.#sessions,
      alerts: [...this.#alerts.values()],
      self: {
        pid: process.pid,
        privateMb: Math.round(this.#processes.find((info) => info.pid === process.pid)?.privateMb ?? 0),
        startedAt: this.#startedAt,
      },
    };
  }

  /** This function gives the history since a time. With a step longer than one minute, each row is the average of one step. */
  history(since: number, stepMs = 0): History {
    return { memory: this.#store.memorySince(since, stepMs), owners: this.#store.ownersSince(since, stepMs), leases: this.#store.endedLeases(since) };
  }

  /** This function calls the listener with the leases that change. It gives a function that removes the listener. */
  onChange(listener: (changed: readonly Lease[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** This function waits until a lease is no longer waiting, the signal aborts, or the time ends. */
  waitFor(id: string, options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {}): Promise<Lease> {
    return new Promise((resolve, reject) => {
      const lease = this.#broker.get(id);
      if (!lease) return reject(new Error(`No lease has the id ${id}`));
      if (lease.state !== "waiting" || options.signal?.aborted) return resolve(lease);
      const done = (): void => {
        off();
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", aborted);
        resolve(this.#broker.get(id) ?? lease);
      };
      const aborted = (): void => done();
      const off = this.onChange((changed) => {
        if (changed.some((each) => each.id === id && each.state !== "waiting")) done();
      });
      const timer = setTimeout(done, options.timeoutMs ?? 600_000);
      options.signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  /**
   * This function gives the non-paged pool by tag: the largest tags, and the change of each tag over the
   * snapshots of the last hour. A driver that leaks shows as a tag that grows. Only Windows has tags.
   */
  poolTags(limit = 20): PoolTags {
    const last = this.#tags.at(-1);
    const first = this.#tags[0];
    if (!last || !first) return { at: null, sinceAt: null, largest: [], growing: [] };
    const rows = [...last.tags].map(([tag, mb]) => ({ tag, nonPagedMb: round(mb), growthMb: round(mb - (first.tags.get(tag) ?? 0)) }));
    return {
      at: last.at,
      sinceAt: first.at,
      largest: [...rows].sort((a, b) => b.nonPagedMb - a.nonPagedMb).slice(0, limit),
      growing: rows.filter((row) => row.growthMb > 0).sort((a, b) => b.growthMb - a.growthMb).slice(0, limit),
    };
  }

  /** This function gives the active alerts and the alerts that ended last. */
  alerts(): Alerts {
    return { active: [...this.#alerts.values()], ended: [...this.#ended] };
  }

  /** This function checks the conditions of the alerts. A condition that continues keeps its start time. */
  #check(now: number, ownerOf: ReadonlyMap<number, string>): void {
    const kindOf = new Map(this.#owners.map((owner) => [owner.owner, owner.kind]));
    // The growth of the pool is measured over one hour. A history shorter than 50 minutes gives no growth.
    const first = this.#store.memorySince(now - 3_600_000)[0];
    const poolHourAgoMb = first && now - first.at > 50 * 60_000 ? first.kernelNonpagedMb : undefined;
    const found = detect(
      { memory: this.#memory, processes: this.#processes, ownerOf, kindOf, leases: this.#broker.leases(), poolHourAgoMb },
      this.#alertRules,
    );
    // A pool alert names the tags that grow, so the reader can find the driver.
    const growing = this.poolTags(3).growing.filter((row) => row.growthMb >= 1);
    const named = growing.length === 0 ? "" : ` The tags that grow: ${growing.map((row) => `${row.tag.trim()} +${row.growthMb} MB`).join(", ")}.`;
    for (const [index, alert] of found.entries()) if (alert.kind === "pool" && named) found[index] = { ...alert, message: `${alert.message}${named}` };
    for (const [id, event] of this.#events) {
      if (event.until <= now) this.#events.delete(id);
      else found.push(event.alert);
    }
    const ids = new Set(found.map((alert) => alert.id));
    for (const [id, alert] of this.#alerts) {
      if (ids.has(id)) continue;
      this.#alerts.delete(id);
      this.#ended = [{ ...alert, endedAt: now }, ...this.#ended].slice(0, 50);
    }
    for (const alert of found) this.#alerts.set(alert.id, { ...alert, since: this.#alerts.get(alert.id)?.since ?? now });
  }

  /** This function closes the store and the sampler. */
  close(): void {
    this.#listeners.clear();
    this.#store.close();
    this.#sampler.close();
  }

  #persist(changed: readonly Lease[]): void {
    if (changed.length === 0) return;
    for (const lease of changed) this.#store.saveLease(lease);
    for (const listener of this.#listeners) listener(changed);
    this.#notice(changed);
  }

  /**
   * This function notes the clients of `headroom run` that stopped without a release. A client releases
   * its lease when its job ends. Thus several leases that end because their process exited show a broad stop.
   */
  #notice(changed: readonly Lease[]): void {
    const now = this.#now();
    const cut = changed.filter((lease) => lease.state === "expired" && lease.pid !== null);
    if (cut.length === 0) return;
    this.#cut = [...this.#cut.filter((entry) => now - entry.at <= STOP_WINDOW_MS), ...cut.map((lease) => ({ at: now, lease }))];
    if (this.#cut.length < 2) return;
    const holders = [...new Set(this.#cut.map((entry) => entry.lease.holder))].join(", ");
    this.note(
      {
        id: "stop:clients",
        kind: "stop",
        subject: "headroom run",
        pid: null,
        mb: 0,
        message: `${this.#cut.length} clients of headroom run stopped without a release in ${STOP_WINDOW_MS / 60_000} minutes (holders: ${holders}). Another process can have stopped them.`,
      },
      EVENT_MS,
    );
  }

  /** This function adds an event alert. It stays active for a time, and a second note of the same event starts the time again. */
  note(alert: Omit<Alert, "since">, forMs: number = EVENT_MS): void {
    const now = this.#now();
    const since = this.#alerts.get(alert.id)?.since ?? now;
    this.#events.set(alert.id, { alert, until: now + forMs });
    this.#alerts.set(alert.id, { ...alert, since });
  }
}
