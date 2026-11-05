/**
 * The queue of detached jobs (H64): a job that waits is a row of the daemon, with no process.
 *
 * Each waiting client of `headroom run` holds approximately 58 MB of private memory. On 2026-11-05, 13 waiting clients held
 * 822 MB while the computer had 1.8 GB available. Thus a queue that waits for memory also used memory.
 *
 * With this file, `headroom run --detach` gives its start to the daemon and exits. The daemon starts the client at the
 * grant. The environment of a job can hold tokens, so it stays in the memory of this process only.
 */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import type { Lease } from "@headroom/core";

/** The title of a client that the daemon starts. */
export const CLIENT_TITLE = "headroom-client";

/** This interface holds the start of the client of a detached job. */
export interface DeferredStart {
  /** The arguments of `headroom run`, without `--detach` and without the lease. */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** The absolute path of the log file of the job. */
  readonly log: string;
  /** The longest time in the queue, in milliseconds. */
  readonly waitMs: number;
}

/** This interface is the part of the engine that the queue uses. */
export interface DeferredLeases {
  get(id: string): Lease | undefined;
  renew(id: string): Lease | undefined;
  release(id: string, reason?: string): Lease | undefined;
}

/** This interface holds the options of the queue. */
export interface DeferredOptions {
  readonly leases: DeferredLeases;
  /** This function starts the client of a lease. It calls `failed` when the client does not start. */
  readonly launch: (id: string, start: DeferredStart, failed: (reason: string) => void) => void;
  /** This function adds one line to the log of a job. */
  readonly write?: ((log: string, line: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

interface Entry {
  readonly start: DeferredStart;
  readonly deadline: number;
  said: string;
}

/** This function adds one line to a log. A log that cannot be written does not stop the queue. */
function appendLine(log: string, line: string): void {
  try {
    appendFileSync(log, `${line}\n`);
  } catch {
    // The state of the job stays readable with `headroom job`.
  }
}

/** This class holds the jobs that wait in the queue with no process. */
export class DeferredStarts {
  readonly #leases: DeferredLeases;
  readonly #launch: DeferredOptions["launch"];
  readonly #write: (log: string, line: string) => void;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();

  constructor(options: DeferredOptions) {
    this.#leases = options.leases;
    this.#launch = options.launch;
    this.#write = options.write ?? appendLine;
    this.#now = options.now ?? Date.now;
  }

  /** This property gives the count of the jobs that wait with no process. */
  get size(): number {
    return this.#entries.size;
  }

  /** This function adds a job of a lease. Then it examines the queue, because the lease can have its grant already. */
  add(id: string, start: DeferredStart): void {
    this.#entries.set(id, { start, deadline: this.#now() + start.waitMs, said: "" });
    this.tick();
  }

  /** This function starts the clients of the granted leases, and ends the jobs that waited too long. */
  tick(): void {
    for (const [id, entry] of this.#entries) this.#examine(id, entry);
  }

  /**
   * This function gives each waiting job a client, because this process stops. The client gives the heartbeat, and it
   * waits for the next daemon. A crash does not come here: the waiting job then ends, and `headroom job` tells why.
   */
  handOff(): void {
    for (const [id, entry] of this.#entries) {
      this.#launch(id, entry.start, (reason) => this.#write(entry.start.log, `headroom: the client of the job did not start: ${reason}`));
    }
    this.#entries.clear();
  }

  #examine(id: string, entry: Entry): void {
    const { log } = entry.start;
    const lease = this.#leases.get(id);
    if (lease === undefined || (lease.state !== "waiting" && lease.state !== "granted")) {
      this.#entries.delete(id);
      this.#write(log, `headroom: the job did not start: ${lease?.reason ?? "its lease ended"}.`);
      return;
    }
    if (lease.state === "granted") {
      this.#entries.delete(id);
      this.#leases.renew(id);
      this.#launch(id, entry.start, (reason) => {
        this.#write(log, `headroom: the client of the job did not start: ${reason}`);
        this.#leases.release(id, `the client did not start: ${reason}`);
      });
      return;
    }
    const now = this.#now();
    if (now >= entry.deadline) {
      this.#entries.delete(id);
      this.#write(log, `headroom: ${lease.job} waited too long (${lease.reason ?? "no room"}). Nothing ran.`);
      this.#leases.release(id, "the wait ended");
      return;
    }
    if (lease.reason && lease.reason !== entry.said) {
      entry.said = lease.reason;
      this.#write(log, `headroom: ${lease.job} ${lease.reason}`);
    }
    // No client gives the heartbeat of this lease. A renew writes to the store, so it comes only three times in each limit.
    if (now - lease.heartbeatAt >= lease.ttlMs / 3) this.#leases.renew(id);
  }
}

/**
 * This function gives the start of a client. The daemon starts `headroom run --detach --adopt <id>`, and that process starts
 * the client and exits. Thus the client is not in the process tree of the daemon, and a restart of the daemon does not stop it.
 */
export function launchClient(node: string, cli: string, title: string): DeferredOptions["launch"] {
  return (id, start, failedOnce) => {
    let told = false;
    const failed = (reason: string): void => {
      if (told) return;
      told = true;
      failedOnce(reason);
    };
    try {
      const out = openSync(start.log, "a");
      const child = spawn(node, [`--title=${title}`, cli, "run", "--detach", "--adopt", id, ...start.args], {
        cwd: start.cwd,
        env: start.env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, out],
      });
      closeSync(out);
      child.on("error", (error) => failed(error.message));
      child.on("exit", (code) => {
        if (code !== 0) failed(`the start ended with code ${code ?? "unknown"}`);
      });
      child.unref();
    } catch (error) {
      failed(error instanceof Error ? error.message : String(error));
    }
  };
}
