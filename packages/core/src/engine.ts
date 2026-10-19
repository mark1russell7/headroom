/**
 * The engine joins the sampler, the owners, the broker and the store. It has no timer: its caller
 * calls `tick()` every few seconds, and after each request and each release.
 */

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
  readonly #recordEveryMs: number;
  readonly #retentionMs: number;
  readonly #sessionsDir: string;
  readonly #servers: () => ReadonlyMap<number, string>;
  readonly #listeners = new Set<(changed: readonly Lease[]) => void>();
  #memory: SystemMemory;
  #processes: readonly ProcessInfo[] = [];
  #owners: readonly OwnerUsage[] = [];
  #sessions: readonly SessionInfo[] = [];
  #processesAt = 0;
  #recordedAt = 0;
  #prunedAt = 0;

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
      this.#owners = attribute(this.#processes, this.#sessions, this.#memory, undefined, this.#servers()).owners;
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
  release(id: string, reason?: string): Lease | undefined {
    const lease = this.#broker.release(id, reason);
    if (lease) this.#persist([lease]);
    this.#persist(this.#broker.tick(this.capacity()));
    return lease ? (this.#broker.get(id) ?? lease) : undefined;
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
    };
  }

  /** This function gives the history since a time. */
  history(since: number): History {
    return { memory: this.#store.memorySince(since), owners: this.#store.ownersSince(since), leases: this.#store.endedLeases(since) };
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
  }
}
