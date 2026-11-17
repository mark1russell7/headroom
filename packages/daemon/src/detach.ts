/**
 * `headroom run --detach` (H56): the same client of `headroom run`, as a detached process with no window.
 *
 * Claude Code stops a background shell when the runtime gives memory pressure "critical", no turn or agent runs, and the
 * last input is 30 minutes old. On Windows it reads no memory figure. Thus it stops a client that only waits in the queue.
 * A detached client is not a child of that shell. The session waits for it with `headroom job <name>`.
 *
 * This file has only the start. The detached process runs the code of a foreground run. Thus the queue, the slots, the
 * limits, the job object, the exit record and the release do not change.
 *
 * On Windows, a child has the jobs of its parent. An editor can hold its processes in a job that stops them when it
 * closes. Thus a client that is a child of this process can stop with the editor. With H190, a relay starts the client.
 * The relay has the shell of the desktop as its parent process, so it has none of the jobs of the caller. The relay and
 * this process talk on a named pipe. This file holds no import of the core, so the relay starts quickly.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { createServer, connect as connectPipe, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ShellStart } from "@headroom/core";
import { headroomHome } from "./paths.ts";
import { quoteArgument } from "./winshell.ts";

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
 * job a client (DeferredStarts.handOff). That client must not start the job without its lease. If it does, a stop with ten
 * waiting jobs starts all ten at once, with no memory check. Thus the client waits here for the next daemon, which keeps
 * the lease. The job starts only after its grant.
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

/** The longest wait for the relay to connect to its pipe, in milliseconds. A relay that comes later finds no pipe, and starts nothing. */
export const RELAY_CONNECT_MS = 15_000;

/** The time that the relay gets for its answer after the wait for the lease, in milliseconds. */
export const RELAY_MARGIN_MS = 5_000;

/**
 * The longest wait for the lease that a relay accepts, in milliseconds. Each process of the user can write to the pipe.
 * Thus a request with a longer wait is not a request, and the relay starts no timer for it.
 */
export const RELAY_MAX_WAIT_MS = 60_000;

/** The longest line on the pipe of a relay, in bytes. A command line of Windows has at most 32,767 characters. */
const RELAY_LINE_BYTES = 1024 * 1024;

/** The file that Node runs as the relay. */
export const RELAY_ENTRY: string = fileURLToPath(new URL("./detach-relay.ts", import.meta.url));

/** The request of a run to its relay: the start of the client, with the arguments of `startClient`. */
export interface RelayRequest {
  readonly entry: string;
  readonly args: readonly string[];
  readonly log: string;
  readonly waitMs: number;
}

/** This function starts the relay, which then connects to the pipe. On Windows, it is `startUnderShell` of the core. */
export type RelayLaunch = (pipe: string) => Promise<ShellStart>;

/** Where the client of a detached run started. */
export type DetachRoute =
  /** Outside each job of the caller: the parent process of the relay is the shell. */
  | { readonly kind: "shell"; readonly relayPid: number; readonly shellPid: number }
  /** In the jobs of the caller, as a child of this process. `reason` tells why, or is `null` on a platform with no relay. */
  | { readonly kind: "caller"; readonly reason: string | null };

/** The start of a detached client, and where it started. */
export interface DetachedStart {
  readonly start: ClientStart;
  readonly route: DetachRoute;
}

/** The options of `startDetachedClient`. */
export interface DetachOptions {
  /** The start of the relay, or `null` for a start in the jobs of the caller. */
  readonly launch: RelayLaunch | null;
  readonly waitMs?: number;
  readonly pipe?: string;
  readonly connectMs?: number;
  readonly marginMs?: number;
  /** The start in the jobs of the caller. */
  readonly direct?: typeof startClient;
}

/** This function gives a new pipe for a relay: a named pipe on Windows, else a socket file in the folder for temporary files. */
export function relayPipePath(platform: NodeJS.Platform = process.platform): string {
  const name = `headroom-detach-${randomUUID()}`;
  return platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

/**
 * This function gives the Windows command line of the relay: Node with the options of this process, the file of the
 * relay and the pipe. The arguments of the client go on the pipe, so they need no quotes here.
 */
export function relayCommandLine(pipe: string, node: string = process.execPath, execArgv: readonly string[] = process.execArgv, entry: string = RELAY_ENTRY): string {
  return [node, ...execArgv, entry, pipe].map(quoteArgument).join(" ");
}

/** This function reads one line from a socket. It gives `null` when the socket closes, fails or stays silent for `ms`. */
function readLine(socket: Socket, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (line: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(line);
    };
    const onData = (chunk: Buffer): void => {
      const end = chunk.indexOf(0x0a);
      chunks.push(end === -1 ? chunk : chunk.subarray(0, end));
      size += chunk.length;
      if (end !== -1) finish(Buffer.concat(chunks).toString("utf8"));
      else if (size > RELAY_LINE_BYTES) finish(null);
    };
    const timer = setTimeout(() => finish(null), ms);
    socket.on("data", onData);
    socket.once("close", () => finish(null));
    socket.once("error", () => finish(null));
  });
}

const START_KINDS: ReadonlySet<string> = new Set(["lease", "no-lease", "pending", "ended", "failed"]);

/** This function reads the answer of a relay. An answer that is not a start of a client gives `pending`: the client can run. */
function parseStart(line: string): ClientStart {
  try {
    const value = JSON.parse(line) as { readonly kind?: unknown; readonly lease?: unknown; readonly code?: unknown; readonly reason?: unknown };
    if (typeof value.kind !== "string" || !START_KINDS.has(value.kind)) return { kind: "pending" };
    if (value.kind === "lease") return typeof value.lease === "string" ? { kind: "lease", lease: value.lease } : { kind: "pending" };
    if (value.kind === "ended") return { kind: "ended", code: typeof value.code === "number" ? value.code : null };
    if (value.kind === "failed") return { kind: "failed", reason: typeof value.reason === "string" ? value.reason : "the relay gave no reason" };
    return value.kind === "no-lease" ? { kind: "no-lease" } : { kind: "pending" };
  } catch {
    return { kind: "pending" };
  }
}

/** This function reads the request of a run, or gives `null` when the line is not a request. */
function parseRequest(line: string): RelayRequest | null {
  try {
    const { entry, args, log, waitMs } = JSON.parse(line) as { readonly entry?: unknown; readonly args?: unknown; readonly log?: unknown; readonly waitMs?: unknown };
    if (typeof entry !== "string" || typeof log !== "string" || typeof waitMs !== "number" || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > RELAY_MAX_WAIT_MS) return null;
    if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) return null;
    return { entry, args, log, waitMs };
  } catch {
    return null;
  }
}

/**
 * This function starts a detached client (H190). With a relay, it opens a pipe, starts the relay and gives the relay the
 * start of the client. The relay starts the client, and gives back the start. Sometimes the client starts as a child of this
 * process, in the jobs of the caller. That occurs with no relay, and when the relay does not start or does not connect in
 * time.
 *
 * Exactly one client starts. A relay that connects after the time limit gets no request: this process closes the pipe
 * before it starts the client itself. When the relay has the request but gives no answer, the client can run, so the
 * start is `pending`.
 */
export async function startDetachedClient(entry: string, args: readonly string[], log: string, options: DetachOptions): Promise<DetachedStart> {
  const waitMs = options.waitMs ?? DETACH_WAIT_MS;
  const connectMs = options.connectMs ?? RELAY_CONNECT_MS;
  const direct = options.direct ?? startClient;
  const inCaller = async (reason: string | null): Promise<DetachedStart> => ({ start: await direct(entry, args, log, waitMs), route: { kind: "caller", reason } });
  if (options.launch === null) return inCaller(null);
  const pipe = options.pipe ?? relayPipePath();
  const server = createServer();
  let closed = false;
  let accepted: Socket | null = null;
  let onAccept: ((socket: Socket) => void) | null = null;
  server.on("connection", (socket) => {
    if (closed || accepted !== null) {
      socket.destroy();
      return;
    }
    accepted = socket;
    onAccept?.(socket);
  });
  const opened = await new Promise<string | null>((resolve) => {
    server.once("error", (error) => resolve(error.message));
    server.listen(pipe, () => resolve(null));
  });
  const close = (): void => {
    closed = true;
    server.close();
  };
  if (opened !== null) {
    close();
    return inCaller(`the pipe of the relay did not open: ${opened}`);
  }
  const launched = await options.launch(pipe).catch((error: unknown): ShellStart => ({ kind: "unavailable", reason: error instanceof Error ? error.message : String(error) }));
  if (launched.kind === "unavailable") {
    close();
    return inCaller(launched.reason);
  }
  const socket: Socket | null =
    accepted ??
    (await new Promise<Socket | null>((resolve) => {
      const timer = setTimeout(() => {
        closed = true;
        resolve(null);
      }, connectMs);
      onAccept = (each) => {
        clearTimeout(timer);
        resolve(each);
      };
    }));
  close();
  if (socket === null) return inCaller(`the relay (process ${launched.pid}) did not connect in ${connectMs / 1000} s`);
  socket.on("error", () => undefined);
  const request: RelayRequest = { entry, args, log, waitMs };
  socket.write(`${JSON.stringify(request)}\n`);
  const answer = await readLine(socket, waitMs + (options.marginMs ?? RELAY_MARGIN_MS));
  socket.destroy();
  return { start: answer === null ? { kind: "pending" } : parseStart(answer), route: { kind: "shell", relayPid: launched.pid, shellPid: launched.shellPid } };
}

/**
 * This function is the relay (H190). It connects to the pipe, reads the start of the client, starts the client with
 * `start`, and writes the result back. It gives the exit code of the relay: 1 when no request came.
 */
export async function runRelay(pipe: string, start: typeof startClient = startClient, readMs: number = RELAY_CONNECT_MS): Promise<number> {
  const socket = connectPipe(pipe);
  socket.on("error", () => undefined);
  const line = await readLine(socket, readMs);
  const request = line === null ? null : parseRequest(line);
  if (request === null) {
    socket.destroy();
    return 1;
  }
  let result: ClientStart;
  try {
    result = await start(request.entry, request.args, request.log, request.waitMs);
  } catch (error) {
    result = { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.end(`${JSON.stringify(result)}\n`, () => resolve());
  });
  return 0;
}

/** This function gives the line about the place of a detached client, for its log, or `null` when there is nothing to tell. */
export function routeLine(job: string, route: DetachRoute): string | null {
  if (route.kind === "shell") {
    return `headroom: the client of job ${job} runs outside the jobs of the caller. Its relay (process ${route.relayPid}) has the shell (process ${route.shellPid}) as its parent.`;
  }
  if (route.reason === null) return null;
  return `headroom: the client of job ${job} runs in the jobs of the caller, because ${route.reason}. A job of the caller that stops its processes when it closes, for example the job of an editor, also stops this client.`;
}
