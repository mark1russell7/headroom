/**
 * `headroom run --detach` (H56): the same client of `headroom run`, as a detached process with no window.
 *
 * Claude Code stops a background shell when the runtime gives memory pressure "critical", no turn or agent runs, and the
 * last input is 30 minutes old. On Windows it reads no memory figure. Thus it stops a client that only waits in the queue.
 * A detached client is not a child of that shell. The session waits for it with `headroom job <name>`.
 *
 * This file has only the start. The detached process runs the code of a foreground run. Thus the queue, the slots, the
 * limits, the job object, the exit record and the release do not change.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { headroomHome } from "./paths.ts";

/** The internal option of a detached client: the output of the client is already the log file, and its parent waits for the lease. */
export const DETACHED_CLIENT = "--detached-client";

/** The longest wait for the lease of the detached client, in milliseconds. The client asks for the lease at once, and does not wait in the queue here. */
export const DETACH_WAIT_MS = 5000;

/** How the start of a detached client ended. */
export type ClientStart =
  /** The client has a lease. The lease can wait in the queue. */
  | { readonly kind: "lease"; readonly lease: string }
  /** The daemon does not run, so the job runs without a lease. */
  | { readonly kind: "no-lease" }
  /** The client gave no answer in time. It continues. */
  | { readonly kind: "pending" }
  /** The client ended before a lease. */
  | { readonly kind: "ended"; readonly code: number | null }
  /** The client did not start. */
  | { readonly kind: "failed"; readonly reason: string };

/** The message of a detached client to its parent. */
interface ClientMessage {
  readonly lease: string | null;
}

/** This function gives a new log file of a detached job, under the folder of headroom. */
export function detachedLogPath(): string {
  return join(headroomHome(), "jobs", `${randomUUID()}.log`);
}

/**
 * This function gives the arguments of the detached client. They are the arguments of the run without `--detach`. The
 * parent gives the holder, because the client cannot find the session after its parent stops. The new options go first,
 * so they stay before `--`, and a repeated option of the run has the same value.
 */
export function clientArgs(argv: readonly string[], detachAt: ReadonlySet<number>, holder: string, log: string): string[] {
  return ["run", DETACHED_CLIENT, "--holder", holder, "--log", log, ...argv.filter((_, index) => !detachAt.has(index))];
}

/**
 * This function starts the file `entry` as a detached client with no window. The client writes its output and the output
 * of its job to the log. The function waits only for the lease, so `headroom job <name>` then finds this run, and not an
 * earlier run of the same name.
 */
export function startClient(entry: string, args: readonly string[], log: string, waitMs: number = DETACH_WAIT_MS): Promise<ClientStart> {
  return new Promise((resolve) => {
    const out = openSync(log, "a");
    const child = spawn(process.execPath, [...process.execArgv, entry, ...args], { detached: true, windowsHide: true, stdio: ["ignore", out, out, "ipc"] });
    closeSync(out);
    let done = false;
    const finish = (start: ClientStart): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      child.unref();
      resolve(start);
    };
    const timer = setTimeout(() => finish({ kind: "pending" }), waitMs);
    child.on("message", (message) => {
      const { lease } = message as ClientMessage;
      finish(lease === null ? { kind: "no-lease" } : { kind: "lease", lease });
    });
    child.on("exit", (code) => finish({ kind: "ended", code }));
    child.on("error", (error) => finish({ kind: "failed", reason: error.message }));
  });
}

/** This function gives the id of the lease to the parent of a detached client, or `null` for no lease. Then it closes the channel. */
export function tellParent(lease: string | null): void {
  if (!process.connected) return;
  const message: ClientMessage = { lease };
  process.send?.(message, undefined, undefined, () => {
    if (process.connected) process.disconnect?.();
  });
}

/** This function gives a job name for a command line, with quotes when the name has a space. */
function shellName(job: string): string {
  return /\s/.test(job) ? JSON.stringify(job) : job;
}

/** This function gives the line of a detached run and the exit code of `headroom run`, which is 0 when the client continues. */
export function detachedLine(job: string, log: string, start: ClientStart): { readonly line: string; readonly code: number } {
  const state = `State: headroom job ${shellName(job)}`;
  switch (start.kind) {
    case "lease":
      return { line: `headroom: job ${job} runs detached, lease ${start.lease.slice(0, 8)}. Log: ${log}. ${state}`, code: 0 };
    case "pending":
      return { line: `headroom: job ${job} runs detached, and its lease is not known yet. Log: ${log}. ${state}`, code: 0 };
    case "no-lease":
      return { line: `headroom: job ${job} runs detached without a lease, because the daemon does not run. headroom job has no state of it. Log: ${log}`, code: 0 };
    case "ended":
      return { line: `headroom: the client of job ${job} ended with code ${start.code ?? "unknown"} before a lease. Log: ${log}`, code: start.code === null || start.code === 0 ? 1 : start.code };
    case "failed":
      return { line: `headroom: the client of job ${job} did not start: ${start.reason}`, code: 1 };
  }
}

/** The pause between two looks for a daemon while an adopted job waits for one, in milliseconds. */
export const DAEMON_LOOK_MS = 5000;

/**
 * This function waits for a daemon that answers, until the deadline. It gives the connection, or `null` at the deadline.
 *
 * A job of the daemon queue (`--adopt`) has its lease in the daemon. When the daemon stops cleanly, it gives each waiting
 * job a client (DeferredStarts.handOff). That client must not run the job without its lease: a stop with ten waiting jobs
 * would then start all ten at once, with no memory check. Thus the client waits here for the next daemon, which keeps the
 * lease, and the job runs only after its grant.
 */
export async function waitForDaemon<C>(
  deadline: number,
  find: () => Promise<C | null>,
  options: { readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void>; readonly lookMs?: number } = {},
): Promise<C | null> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const lookMs = options.lookMs ?? DAEMON_LOOK_MS;
  for (;;) {
    const found = await find();
    if (found !== null) return found;
    const left = deadline - now();
    if (left <= 0) return null;
    await sleep(Math.min(lookMs, left));
  }
}

/** The line of an adopted job when no daemon answered before its wait ended. */
export function noDaemonLine(job: string): string {
  return `headroom: no daemon answered before the wait of ${job} ended, so the job did not run without its lease. Nothing ran.`;
}
