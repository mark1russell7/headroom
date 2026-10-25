#!/usr/bin/env node
/**
 * The `headroom` command.
 *
 * - `headroom serve`: run the daemon.
 * - `headroom service install`: start the daemon at login, and again when it stops.
 * - `headroom status`: show the memory, the free amounts, the leases and the owners.
 * - `headroom run --mem 2g -- pnpm test`: run a job under a lease.
 * - `headroom job <name|id> [--holder h] [--all] [--json]`: the state of a job of `headroom run` (H26).
 * - `headroom mcp list | add | remove | restart | warm | config`: the servers of the MCP gateway.
 * - `headroom dashboard`: open the dashboard of the daemon in the browser.
 * - `headroom alerts [--watch]`: a runaway process, an orphan, low memory, the commit charge, the kernel pool and low free space on a drive.
 * - `headroom config [job-temp <folder>] [health <name> <url>]`: show or change the settings.
 * - `headroom ports [--json]`: the listening TCP ports, with the process and the owner of each port (H24).
 * - `headroom services [--json]`: the health of Docker, the MCP servers of the gateway and the configured URLs (H27).
 * - `headroom peer <localPort> <remotePort> [--json]`: the process, the session and the role at the other end of a loopback connection (H46).
 * - `headroom history`, `headroom pool <name> <capacity>`, `headroom release <id>`, `headroom resume-plan`.
 */

import { spawn, type StdioOptions } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, openSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createJob,
  createSampler,
  diskLevel,
  diskSize,
  kindOf,
  MB,
  powerLine,
  readSessions,
  startsLine,
  type Alert,
  type Alerts,
  type Config,
  type History,
  type Job,
  type JobExit,
  type JobUsage,
  type Lease,
  type Peer,
  type PoolTags,
  type Status,
  type Suggestion,
  type TcpPorts,
} from "@headroom/core";
import { answers, connect, connectTo, isNetworkError, isRestartError, type Connection } from "./client.ts";
import { DEFAULT_PORT, fileLog, serve } from "./daemon.ts";
import { driversOf } from "./drivers.ts";
import { mcpCommand } from "./gateway-cli.ts";
import { sessionFromEnv } from "./holder.ts";
import { diskAmounts, finishTemp, jobEnv, prepareTemp } from "./job.ts";
import { JOB_USAGE, jobCommand } from "./job-cli.ts";
import { parseDisk, parseMemory, parseTime } from "./parse.ts";
import { dashboardKey, readDiscovery, readPlannedStop } from "./paths.ts";
import { windowsCommand } from "./winshell.mjs";
import type { DaemonStatus, RenewAnswer } from "./procedures.ts";
import { autoSlots, BROWSER_SLOT } from "./slots.ts";
import { DEFAULT_HEALTH_TEXT, healthChange, healthLines, servicesCommand, servicesLine, SERVICES_USAGE } from "./services-cli.ts";
import * as service from "./service.ts";

const HELP = `headroom: the memory and job broker of this computer

  headroom serve [--port ${DEFAULT_PORT}] [--reserve 1024] [--background] [--log file]
  headroom service install [--port ${DEFAULT_PORT}] [--reserve 1024]
  headroom service restart [--now] [--wait 60m] | stop | start | uninstall | status
  headroom service restart --when-idle [--cancel]   (the daemon restarts itself when no lease waits)
  headroom mcp list | add | remove | restart | warm | config   (the MCP gateway)
  headroom mcp warm [name...] [--timeout 120s]   (start the MCP servers before the sessions)
  headroom status [--json]
  headroom run [--mem 2g|auto] [--cpu 2] [--disk 5g|D:=5g]... [--slot docker]... [--holder name] [--job name]
               [--priority 0] [--wait 30m] [--limit] [--keep] [--keep-temp] [--force-disk] [--no-eco] [--log file] -- <command> [args...]
               --limit: the job cannot use more memory than --mem. --keep: no job object.
               On battery, the job runs in efficiency mode (EcoQoS). --no-eco: not.
               --log file: the output of the job also goes to the end of the file.
               The run prints the lease id first: headroom job <id> gives the state of the job.
               --disk 5g: space on the drive of the current folder. --disk D:=5g: on the drive D:.
               With a temp root (headroom config job-temp), the job gets its own TEMP folder,
               and the run removes it at the end. --keep-temp: keep the folder.
               A browser test (playwright test, e2e) takes the slot browser. --no-auto-slot: not.
               A drive with less than 5 GB free stops the start (exit 75). --force-disk: start anyway.
  ${JOB_USAGE}
               The state of a job: queued, running or exited, with its exit code. No job: exit 3.
  headroom config [job-temp <folder> | job-temp --clear]   (show or change the settings)
  headroom config health [<name> <url> | <name> --clear | --clear]
               The URLs that the service monitor checks. The default: ${DEFAULT_HEALTH_TEXT}.
  ${SERVICES_USAGE}                 (Docker, the MCP servers and the URLs: ok, slow, down, idle)
  headroom dashboard                         (open the dashboard in the browser)
  headroom alerts [--watch] [--json]
  headroom pool-tags [--drivers] [--json]   (the kernel pool by tag, Windows)
  headroom ports [--json]                   (the listening TCP ports, with their process and owner)
  headroom peer <localPort> <remotePort> [--json]
               The process at the other end of a loopback connection, its claude.exe, session and role.
               The two ports are the ports that the server sees. No connection or no process: exit 3.
  headroom history [--minutes 60] [--json]
  headroom pool <name> <capacity>
  headroom release <id>
  headroom resume-plan
`;

/** This function finds the Claude Code session that started this process: by the variables of Claude Code, then by the process tree. */
async function holderOf(): Promise<string> {
  const fromEnv = process.env["HEADROOM_HOLDER"];
  if (fromEnv) return fromEnv;
  try {
    const known = readSessions();
    const named = sessionFromEnv(process.env, known);
    if (named) return named;
    const sampler = await createSampler();
    const byPid = new Map(sampler.processes().map((info) => [info.pid, info]));
    const sessions = new Map(known.map((session) => [session.pid, session.name]));
    const seen = new Set<number>();
    for (let pid = process.ppid; pid > 0 && !seen.has(pid); pid = byPid.get(pid)?.ppid ?? 0) {
      seen.add(pid);
      const name = sessions.get(pid);
      if (name) return name;
    }
  } catch {
    // The process tree is not readable: the user name is the holder.
  }
  return userInfo().username;
}

function mb(value: number): string {
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`;
}

/** This function writes a throughput in MB/s, with 2 decimals below 0.1 MB/s. */
function rate(value: number): string {
  return `${value >= 10 ? value.toFixed(0) : value >= 0.1 ? value.toFixed(1) : value.toFixed(2)} MB/s`;
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

/** This function writes an amount in the unit of its kind: MB or GB for the memory and the drives, else a count. */
function amountText(name: string, amount: number): string {
  const kind = kindOf(name);
  return kind === "memory" ? mb(Math.max(0, amount)) : kind === "disk" ? diskSize(Math.max(0, amount)) : String(amount);
}

function printStatus(status: DaemonStatus): void {
  const { memory } = status;
  for (const alert of status.alerts ?? []) console.log(`ALERT since ${clock(alert.since)} UTC: ${alert.message}`);
  if (status.restart) console.log(service.pendingLine(status.restart));
  if ((status.alerts ?? []).length > 0 || status.restart) console.log("");
  console.log(`Memory: ${mb(memory.availableMb)} available of ${mb(memory.totalMb)}. Committed ${mb(memory.commitMb)} of ${mb(memory.commitLimitMb)}.`);
  console.log(`Kernel pools: ${mb(memory.kernelNonpagedMb)} non-paged, ${mb(memory.kernelPagedMb)} paged.`);
  const load = status.session;
  if (load) console.log(`Session: ${load.processes} processes${load.userObjects === null ? "" : `, ${load.userObjects} USER and ${load.gdiObjects ?? 0} GDI objects`}.`);
  const disks = status.disks ?? [];
  if (disks.length > 0) {
    const each = disks.map((disk) => {
      const drop = disk.dropMbPerHour >= 1024 ? ` (${diskSize(disk.dropMbPerHour)} less each hour)` : "";
      return `${disk.mount} ${diskSize(disk.freeMb)} free of ${diskSize(disk.totalMb)}${drop}`;
    });
    console.log(`Disks: ${each.join(", ")}.`);
  }
  // A daemon of an older version gives no writes and no owners of the resources.
  if (status.writes !== undefined) {
    const writers = status.writes.filter((each) => each.mbLastHour >= 10).slice(0, 5);
    console.log(`Writes (last hour): ${writers.length === 0 ? "none above 10 MB" : writers.map((each) => `${each.owner} ${diskSize(each.mbLastHour)}`).join(", ")}.`);
  }
  const cpu = (status.resources ?? []).find((each) => each.id === "cpu");
  if (cpu !== undefined && cpu.used !== null && cpu.capacity !== null) {
    const most = (cpu.owners ?? []).filter((each) => each.value >= 0.05).slice(0, 3);
    const named = most.length === 0 ? "" : ` Most: ${most.map((each) => `${each.owner} ${each.value.toFixed(1)}`).join(", ")}.`;
    console.log(`CPU: ${cpu.used.toFixed(1)} of ${cpu.capacity} cores in use.${named}`);
  }
  // H30: the battery and the power. A computer with no battery and no Energy Meter has no line.
  const power = powerLine(status.resources ?? [], status.power);
  if (power !== null) console.log(power);
  // H29: the process starts. A daemon of an older version gives none.
  const starts = status.starts === undefined ? null : startsLine(status.starts);
  if (starts !== null) console.log(starts);
  // H24: the network needs two reads of the adapters, so its first status after a start has no rate.
  const usedOf = (id: string): number | null => (status.resources ?? []).find((each) => each.id === id)?.used ?? null;
  const received = usedOf("net:in");
  const sent = usedOf("net:out");
  if (received !== null && sent !== null) console.log(`Network: ${rate(received)} in, ${rate(sent)} out.`);
  const ports = (status.resources ?? []).find((each) => each.id === "ports:tcp");
  if (status.tcp && ports !== undefined && ports.used !== null && ports.capacity) {
    const part = Math.round((ports.used / ports.capacity) * 100);
    console.log(`TCP: ${status.tcp.connections} connections (${status.tcp.timeWait} waiting to close), ${part}% of the dynamic ports.`);
  }
  // H27: the health of the shared services. A daemon of an older version gives none.
  const services = servicesLine((status.resources ?? []).flatMap((each) => (each.health === undefined ? [] : [each.health])));
  if (services !== null) console.log(services);
  const free = Object.entries(status.free).map(([name, amount]) => `${name} ${amountText(name, amount)}`);
  console.log(`Free for a new lease: ${free.join(", ")} (reserve ${mb(status.reserveMb)}).`);
  console.log(status.leases.length === 0 ? "\nNo active leases." : "\nActive leases:");
  for (const lease of status.leases) {
    const amounts = Object.entries(lease.amounts).map(([name, amount]) => `${name} ${amountText(name, amount)}`).join(", ");
    console.log(`  ${lease.state.padEnd(8)} ${lease.holder.padEnd(14)} ${lease.job.slice(0, 40).padEnd(40)} ${amounts}${lease.reason ? `  (${lease.reason})` : ""}`);
  }
  console.log("\nMemory by owner (private, then in RAM now):");
  for (const owner of status.owners.slice(0, 14)) {
    console.log(`  ${owner.owner.slice(0, 32).padEnd(32)} ${mb(owner.privateMb).padStart(9)} ${mb(owner.workingMb).padStart(9)}  ${owner.processes} processes`);
  }
}

/** The end of a command: the exit code that `headroom run` gives, and the exit of the command itself. */
interface CommandEnd {
  readonly code: number;
  readonly exit: JobExit;
}

/** The longest wait for the last output of a job with a log after its exit. A process that the job left can keep the pipes open. */
const LOG_DRAIN_MS = 2000;

/**
 * This function runs a command, and gives its exit code and its exit. `env` adds variables to the environment of the
 * command. With a log file, the output and the errors of the command go to the console and to the end of the file.
 */
function runCommand(command: readonly string[], env: Readonly<Record<string, string>> = {}, log: string | null = null): Promise<CommandEnd> {
  return new Promise((resolve) => {
    const [file, ...args] = command;
    if (!file) return resolve({ code: 2, exit: { code: null, signal: null } });
    const sink = log === null ? null : createWriteStream(log, { flags: "a" });
    sink?.on("error", (error) => console.error(`headroom: the log file ${log ?? ""} failed: ${error.message}`));
    const stdio: StdioOptions = sink === null ? "inherit" : ["inherit", "pipe", "pipe"];
    const options = { stdio, env: jobEnv(env) };
    // On Windows, a program starts directly. A .cmd file, such as npm, starts in cmd with each argument escaped.
    const win = process.platform === "win32" ? windowsCommand(command, { env: options.env }) : null;
    const child = win === null ? spawn(file, args, options) : spawn(win.file, win.args, { ...options, windowsVerbatimArguments: win.verbatim });
    let done = false;
    const finish = (end: CommandEnd): void => {
      if (done) return;
      done = true;
      if (sink === null || sink.closed) return resolve(end);
      sink.once("close", () => resolve(end));
      sink.end();
    };
    if (sink !== null) {
      for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
        from?.on("data", (chunk: Buffer) => {
          to.write(chunk);
          if (!done) sink.write(chunk);
        });
      }
    }
    child.on("error", (error) => {
      console.error(`headroom: the command did not start: ${error.message}`);
      finish({ code: 127, exit: { code: 127, signal: null } });
    });
    child.on("exit", (code, signal) => {
      const end: CommandEnd = { code: code ?? (signal ? 1 : 0), exit: { code, signal } };
      if (sink === null) return finish(end);
      const timer = setTimeout(() => finish(end), LOG_DRAIN_MS);
      child.on("close", () => {
        clearTimeout(timer);
        finish(end);
      });
    });
  });
}

/** This function waits until the lease is no longer waiting. When the daemon restarts, it connects again and continues to wait. */
/** The amount of `--mem auto` for a job with no run that has a peak, in MB. */
const AUTO_DEFAULT_MB = 1024;

/** How `headroom run` holds its job: a job object, and a memory limit with --limit. */
interface Enforcement {
  /** True (--keep): no job object, so the processes of the job can stay after the run. */
  readonly keep: boolean;
  /** True (--limit): the job cannot commit more memory than its lease. */
  readonly limit: boolean;
  readonly leaseMb: number | null;
  /** True (--no-eco): the job keeps its full speed on battery (H30). */
  readonly noEco?: boolean | undefined;
}

/** The time between two counts of the processes of a job for the daemon (H29). */
const PROCESS_REPORT_MS = 30_000;
/** The time from the start of a job to its first heartbeat, so a job on battery gets efficiency mode soon (H30). */
const FIRST_REPORT_MS = 3000;

/** The end of a job in a job object: the end of its command, its peak memory and the processes that it started (H29). */
interface EnforcedEnd extends CommandEnd {
  readonly peakMb: number | null;
  readonly processes: number | null;
}

/**
 * This function runs a command in a job object (H6, Windows). When this process exits, Windows stops each process of the
 * job that still runs, so no process of the job stays as an orphan. With --limit, the job cannot commit more memory than
 * its lease. The function prints the peak memory of the job, so the holder can size the next lease.
 *
 * Every 30 seconds, `report` gets the count of processes that the job started so far (H29). The count of the job object
 * includes this process, so the count of the job starts after it. The answer of `report` tells if the job runs in efficiency
 * mode (H30). On battery, the processes of the job go into EcoQoS, unless --no-eco. The first report comes after 3 seconds.
 */
async function runEnforced(
  command: readonly string[],
  enforcement: Enforcement,
  env: Readonly<Record<string, string>> = {},
  log: string | null = null,
  report?: (processes: number) => Promise<boolean | undefined>,
): Promise<EnforcedEnd> {
  let held: Job | null = null;
  if (!enforcement.keep) {
    // The process of headroom is in the job too: the limit adds its memory and a margin.
    const selfMb = process.memoryUsage().rss / MB;
    const limitMb = enforcement.limit && enforcement.leaseMb !== null ? enforcement.leaseMb + selfMb + 64 : undefined;
    try {
      held = await createJob(limitMb === undefined ? {} : { memoryMb: limitMb });
    } catch (error) {
      console.error(`headroom: no job object (${error instanceof Error ? error.message : String(error)}). The job runs without one.`);
    }
  }
  const base = held?.peakMb() ?? 0;
  const job = held;
  const baseProcesses = job?.processes() ?? 0;
  const started = (): number => Math.max(0, (job?.processes() ?? 0) - baseProcesses);
  let eco = false;
  const heartbeat = (): void => {
    if (job === null || report === undefined) return;
    void report(started()).then((on) => {
      if (enforcement.noEco === true || on === undefined) return;
      try {
        job.eco(on);
      } catch {
        return;
      }
      if (on !== eco) {
        console.error(on ? "headroom: the laptop runs on battery, so the job runs in efficiency mode (EcoQoS). --no-eco: full speed." : "headroom: the laptop runs on AC power again, so the job runs at full speed.");
      }
      eco = on;
    });
  };
  const timer = job === null || report === undefined ? null : setInterval(heartbeat, PROCESS_REPORT_MS);
  const first = job === null || report === undefined ? null : setTimeout(heartbeat, FIRST_REPORT_MS);
  // The timers do not keep this process alive.
  timer?.unref();
  first?.unref();
  let end: CommandEnd;
  try {
    end = await runCommand(command, env, log);
  } finally {
    if (timer !== null) clearInterval(timer);
    if (first !== null) clearTimeout(first);
  }
  const { code, exit } = end;
  if (!job) return { code, exit, peakMb: null, processes: null };
  const peakMb = Math.max(0, job.peakMb() - base);
  const processes = started();
  const of = enforcement.leaseMb === null ? "" : ` of its lease of ${mb(enforcement.leaseMb)}`;
  console.error(`headroom: the job used at most ${mb(peakMb)}${of}. It started ${processes} ${processes === 1 ? "process" : "processes"}.`);
  if (job.limitMb !== null && job.peakMb() >= job.limitMb * 0.97) {
    console.error(`headroom: the job reached its memory limit. Ask for a larger lease, for example --mem ${Math.ceil((enforcement.leaseMb ?? 0) * 1.5 / 1024)}g.`);
  }
  return { code, exit, peakMb, processes };
}

/** This function opens a log file of `headroom run --log` to append, with its folder. It gives the absolute path, or an error text. */
function openLog(path: string): { readonly path: string } | { readonly error: string } {
  const absolute = resolve(path);
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    closeSync(openSync(absolute, "a"));
    return { path: absolute };
  } catch (error) {
    return { error: `the log file ${absolute} does not open: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** This function gives the line that names a new lease, for example "headroom: lease 3f2a9c1e for e2e, queued for browser." */
function leaseLine(lease: Lease): string {
  const waitsFor = /^waits for ([^:]+):/.exec(lease.reason ?? "")?.[1];
  const state =
    lease.state === "granted" ? "granted" : lease.state === "waiting" ? `queued${waitsFor === undefined ? "" : ` for ${waitsFor}`}` : lease.state;
  return `headroom: lease ${lease.id.slice(0, 8)} for ${lease.job}, ${state}.`;
}

/** The longest wait of `headroom run` for the daemon after a planned stop: the repeat trigger of the task, and the start. */
const RESTART_GRACE_MS = 150_000;

/**
 * This function waits for the new daemon after a planned stop, so a job does not run without a lease during a restart.
 * It gives `null` when no planned stop is recent, or when no new daemon answers in time.
 */
async function afterPlannedRestart(): Promise<Connection | null> {
  const planned = readPlannedStop();
  if (planned === null || Date.now() - planned.at > RESTART_GRACE_MS) return null;
  console.error("headroom: the daemon restarts. The job waits for the new daemon.");
  while (Date.now() < planned.at + RESTART_GRACE_MS) {
    const discovery = readDiscovery();
    if (discovery && discovery.pid !== planned.pid && (await answers(discovery))) return connectTo(discovery);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

async function waitForGrant(start: Connection, lease: Lease, deadline: number): Promise<{ lease: Lease; connection: Connection }> {
  let connection = start;
  let current = lease;
  let said = "";
  while (current.state === "waiting" && Date.now() < deadline) {
    if (current.reason && current.reason !== said) {
      console.error(`headroom: ${current.job} ${current.reason}`);
      said = current.reason;
    }
    try {
      current = await connection.call<Lease>(["resources", "wait"], { id: current.id, timeoutMs: Math.max(1000, Math.min(60_000, deadline - Date.now())) });
    } catch (error) {
      if (!isRestartError(error)) throw error;
      // The new process of the daemon has a new token, and it keeps the lease.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      connection = connect() ?? connection;
    }
  }
  return { lease: current, connection };
}

/**
 * This function examines the fixed drives before a job starts, because a full drive stops the builds, the tests and git
 * of all the sessions. It gives 75 when a drive is nearly full and `force` is false. Otherwise, it gives `null`.
 */
function checkDisks(status: Status | null, force: boolean): number | null {
  for (const disk of status?.disks ?? []) {
    const level = diskLevel(disk);
    if (level === null) continue;
    const free = `headroom: drive ${disk.mount} has only ${diskSize(disk.freeMb)} free.`;
    if (level === "critical" && !force) {
      console.error(`${free} The job does not start, because a full drive stops the whole fleet. Free space, or start it with --force-disk.`);
      return 75;
    }
    console.error(`${free} Free space soon, because a full drive stops the whole fleet.${level === "critical" ? " The job starts because of --force-disk." : ""}`);
  }
  return null;
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      mem: { type: "string" },
      cpu: { type: "string" },
      slot: { type: "string", multiple: true },
      holder: { type: "string" },
      job: { type: "string" },
      priority: { type: "string" },
      wait: { type: "string" },
      disk: { type: "string", multiple: true },
      limit: { type: "boolean" },
      keep: { type: "boolean" },
      "keep-temp": { type: "boolean" },
      "no-auto-slot": { type: "boolean" },
      "force-disk": { type: "boolean" },
      "no-eco": { type: "boolean" },
      log: { type: "string" },
    },
  });
  if (positionals.length === 0) {
    console.error("headroom run needs a command after --. Example: headroom run --mem 2g -- pnpm test");
    return 2;
  }
  const opened = values.log === undefined ? null : openLog(values.log);
  if (opened !== null && "error" in opened) {
    console.error(`headroom: ${opened.error}`);
    return 2;
  }
  const log = opened?.path ?? null;
  const amounts: Record<string, number> = {};
  if (values.mem && values.mem !== "auto") amounts["memory"] = parseMemory(values.mem);
  if (values.cpu) amounts["cpu"] = Number(values.cpu);
  for (const slot of values.slot ?? []) amounts[slot] = (amounts[slot] ?? 0) + 1;
  // Browser tests of two sessions at the same time start many browser processes, and process starts can fail
  // (0xC0000142). The slot `browser` is a lock of 1 unless a pool sets more.
  for (const slot of values["no-auto-slot"] === true ? [] : autoSlots(positionals.join(" "))) {
    if (amounts[slot] !== undefined) continue;
    amounts[slot] = 1;
    if (slot === BROWSER_SLOT) console.error(`headroom: this job runs browser tests, so it takes the slot "${BROWSER_SLOT}": one browser test job at a time.`);
  }
  const job = values.job ?? positionals.join(" ").slice(0, 500);
  if (values.limit && !values.mem) {
    console.error("headroom run --limit needs --mem: the limit is the memory of the lease.");
    return 2;
  }
  const keep = values.keep === true;
  for (const value of values.disk ?? []) {
    try {
      parseDisk(value);
    } catch (error) {
      console.error(`headroom: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  let connection = connect() ?? (await afterPlannedRestart());
  if (!connection) {
    console.error("headroom: the daemon does not run, so the job runs without a lease.");
    return (await runEnforced(positionals, { keep, limit: false, leaseMb: null }, {}, log)).code;
  }
  // When the daemon does not answer, the lease request that comes next reports it.
  const status = await connection.call<Status>(["resources", "status"], {}).catch(() => null);
  const stopped = checkDisks(status, values["force-disk"] === true);
  if (stopped !== null) return stopped;
  const disks = diskAmounts(values.disk ?? [], (status?.disks ?? []).map((disk) => disk.mount));
  if (typeof disks === "string") {
    console.error(`headroom: ${disks}`);
    return 2;
  }
  Object.assign(amounts, disks);
  const holder = values.holder ?? (await holderOf());
  // --mem auto: the peaks of the last runs of this job give the amount.
  if (values.mem === "auto") {
    const suggestion = await connection.call<Suggestion>(["resources", "suggest"], { job, holder }).catch(() => null);
    amounts["memory"] = suggestion?.memoryMb ?? AUTO_DEFAULT_MB;
    console.error(
      suggestion?.memoryMb
        ? `headroom: --mem auto gives ${mb(amounts["memory"])}, from the peaks of ${suggestion.runs} ${suggestion.runs === 1 ? "run" : "runs"} (the highest ${mb(suggestion.peakMb ?? 0)}).`
        : `headroom: --mem auto gives ${mb(AUTO_DEFAULT_MB)}, because no run of this job has a peak yet.`,
    );
  }
  const enforcement: Enforcement = { keep, limit: values.limit === true, leaseMb: amounts["memory"] ?? null, noEco: values["no-eco"] === true };
  const request = {
    holder,
    job,
    amounts,
    pid: process.pid,
    ...(values.priority ? { priority: Number(values.priority) } : {}),
    ...(log === null ? {} : { log }),
  };
  let first: Lease;
  try {
    first = await connection.call<Lease>(["resources", "lease"], request);
  } catch (error) {
    if (!isRestartError(error)) throw error;
    // The daemon can stop for a planned restart between the discovery and the request.
    const next = await afterPlannedRestart();
    if (next === null) {
      if (!isNetworkError(error)) throw error;
      console.error("headroom: the daemon does not answer, so the job runs without a lease.");
      return (await runEnforced(positionals, enforcement, {}, log)).code;
    }
    connection = next;
    first = await next.call<Lease>(["resources", "lease"], request);
  }
  // H26: a session can wait on this id with `headroom job <id>`, also after its shell stops.
  console.error(leaseLine(first));
  const { lease, connection: latest } = await waitForGrant(connection, first, Date.now() + parseTime(values.wait ?? "30m"));
  if (lease.state === "waiting") {
    await latest.call(["resources", "release"], { id: lease.id, reason: "the wait ended" });
    console.error(`headroom: ${job} waited too long (${lease.reason ?? "no room"}). Nothing ran.`);
    return 75;
  }
  if (lease.state !== "granted") {
    console.error(`headroom: the lease ended before the job started: ${lease.reason ?? lease.state}`);
    return 75;
  }
  // H19: with a temp root, the job writes its temp files under its lease. With --keep, the job keeps the TEMP of its
  // parent, because a service that it starts on purpose can use its temp folder after the job ends.
  const temp = keep ? null : await prepareTemp(latest, lease.id);
  let result: EnforcedEnd = { code: 1, exit: { code: null, signal: null }, peakMb: null, processes: null };
  let tempMb: number | null = null;
  // H29: the heartbeat gives the daemon the count of processes of the job. A daemon that does not answer misses one count.
  // H30: its answer tells if the job runs in efficiency mode. A daemon of an older version gives no answer for it.
  const report = (processes: number): Promise<boolean | undefined> =>
    (connect() ?? latest).call<RenewAnswer>(["resources", "renew"], { id: lease.id, processes }).then(
      (answer) => (typeof answer.eco === "boolean" ? answer.eco : undefined),
      () => undefined,
    );
  try {
    result = await runEnforced(positionals, enforcement, temp?.env ?? {}, log, report);
  } finally {
    if (temp !== null) tempMb = finishTemp(temp, values["keep-temp"] === true);
  }
  const { code, exit, peakMb, processes } = result;
  const peak = peakMb === null ? "" : `, peak ${mb(peakMb)}`;
  const ended = exit.code === null && exit.signal !== null ? `the job ended with signal ${exit.signal}` : `the job ended with code ${code}`;
  const usage: JobUsage = { ...(peakMb === null ? {} : { peakMb }), ...(tempMb === null ? {} : { tempMb }) };
  try {
    await (connect() ?? latest).call(["resources", "release"], {
      id: lease.id,
      reason: `${ended}${peak}`,
      ...(peakMb === null ? {} : { peakMb }),
      ...(Object.keys(usage).length === 0 ? {} : { usage }),
      // H26: the exit of the job, for `headroom job`. A job that a signal stopped has no exit code.
      ...(exit.code === null ? {} : { exitCode: exit.code }),
      ...(exit.signal === null ? {} : { signal: exit.signal }),
      ...(processes === null ? {} : { processes }),
    });
  } catch {
    // The daemon ends the lease anyway when this process exits.
  }
  return code;
}

async function showAlerts(json: boolean): Promise<number> {
  const connection = connect();
  if (!connection) return (console.error("headroom does not run."), 1);
  const alerts = await connection.call<Alerts>(["resources", "alerts"], {});
  if (json) console.log(JSON.stringify(alerts, null, 2));
  else {
    if (alerts.active.length === 0) console.log("No active alerts.");
    for (const alert of alerts.active) console.log(`ALERT since ${clock(alert.since)} UTC: ${alert.message}`);
    for (const alert of alerts.ended.slice(0, 10)) console.log(`ended ${clock(alert.endedAt)} UTC (since ${clock(alert.since)}): ${alert.message}`);
  }
  return 0;
}

/**
 * This function writes one line when an alert starts and one line when it ends, until it is stopped.
 * A Claude Code session can follow it with the Monitor tool. It continues through a restart of the daemon.
 */
async function watchAlerts(): Promise<number> {
  const seen = new Map<string, Alert>();
  let connection = connect();
  for (;;) {
    try {
      if (!connection) throw Object.assign(new Error("headroom does not run"), { code: "NETWORK_ERROR" });
      const { active } = await connection.call<Alerts>(["resources", "alerts"], {});
      const ids = new Set(active.map((alert) => alert.id));
      for (const alert of active) if (!seen.has(alert.id)) console.log(`${clock(Date.now())} ALERT ${alert.message}`);
      for (const [id, alert] of seen) if (!ids.has(id)) console.log(`${clock(Date.now())} ENDED ${alert.message}`);
      seen.clear();
      for (const alert of active) seen.set(alert.id, alert);
    } catch (error) {
      if (!isRestartError(error)) throw error;
      connection = connect();
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

async function showPoolTags(drivers: boolean, json: boolean): Promise<number> {
  const connection = connect();
  if (!connection) return (console.error("headroom does not run."), 1);
  const tags = await connection.call<PoolTags>(["resources", "pooltags"], { limit: 15 });
  if (tags.at === null || tags.sinceAt === null) {
    console.log("No snapshot of the pool tags yet. The daemon reads them every 5 minutes, and only on Windows.");
    return 0;
  }
  const named = [...tags.largest, ...tags.growing, ...tags.pagedGrowing].map((row) => row.tag);
  const owners = drivers ? driversOf([...new Set(named)]) : new Map<string, string[]>();
  if (json) {
    console.log(JSON.stringify({ ...tags, drivers: Object.fromEntries(owners) }, null, 2));
    return 0;
  }
  const show = (rows: PoolTags["largest"]): void => {
    for (const row of rows) {
      const files = owners.get(row.tag) ?? [];
      const named = files.length === 0 ? "" : `  ${files.slice(0, 4).join(", ")}${files.length > 4 ? ` and ${files.length - 4} more` : ""}`;
      console.log(`  ${JSON.stringify(row.tag).padEnd(8)} ${`${row.nonPagedMb} MB`.padStart(10)} ${`${row.growthMb >= 0 ? "+" : ""}${row.growthMb} MB`.padStart(11)}${named}`);
    }
  };
  const minutes = Math.round((tags.at - tags.sinceAt) / 60_000);
  console.log(`The largest non-paged pool tags (the change over ${minutes} minutes):`);
  show(tags.largest);
  console.log("\nThe tags that grew most:");
  show(tags.growing);
  if (tags.pagedGrowing.length > 0) {
    console.log("\nThe tags that grew most in the paged pool:");
    for (const row of tags.pagedGrowing.slice(0, 8)) {
      const files = owners.get(row.tag) ?? [];
      const named = files.length === 0 ? "" : `  ${files.slice(0, 4).join(", ")}${files.length > 4 ? ` and ${files.length - 4} more` : ""}`;
      console.log(`  ${JSON.stringify(row.tag).padEnd(8)} ${`${row.pagedMb} MB`.padStart(10)} ${`+${row.growthMb} MB`.padStart(11)}${named}`);
    }
  }
  if (!drivers) console.log("\nTo name the driver of each tag: headroom pool-tags --drivers");
  return 0;
}

/**
 * `headroom ports`: the listening TCP ports with the process and the owner of each, by port. Sessions start dev servers
 * that collide on ports, so this list tells a session which port is free and which process holds a port.
 */
async function showPorts(json: boolean): Promise<number> {
  const connection = connect();
  if (!connection) return (console.error("headroom does not run."), 1);
  const ports = await connection.call<TcpPorts>(["resources", "ports"], {});
  if (json) {
    console.log(JSON.stringify(ports, null, 2));
    return 0;
  }
  if (ports.at === null) {
    console.log("No read of the TCP ports yet. The daemon reads them every 10 seconds.");
    return 0;
  }
  // The addresses come last, because an IPv6 address can be long.
  console.log(`${"PORT".padEnd(6)} ${"PID".padStart(7)}  ${"PROCESS".padEnd(26)} ${"OWNER".padEnd(22)} ADDRESSES`);
  for (const row of ports.listening) {
    const pid = row.pid === 0 ? "-" : String(row.pid);
    const name = (row.name || "-").slice(0, 26).padEnd(26);
    console.log(`${String(row.port).padEnd(6)} ${pid.padStart(7)}  ${name} ${(row.owner || "-").slice(0, 22).padEnd(22)} ${row.addresses.join(", ")}`);
  }
  const range = ports.dynamic;
  const dynamic = range === null ? "" : ` Outgoing connections use the dynamic ports ${range.first}-${range.first + range.count - 1}, so give a dev server a port below ${range.first}.`;
  console.log(`\n${ports.listening.length} listening ports.${dynamic}`);
  return 0;
}

/** The error codes of `resources.peer`. The command exits with 3 for each of them. */
const PEER_ERRORS = new Set(["NO_CONNECTION", "PEER_GONE", "NOT_SUPPORTED"]);

/**
 * `headroom peer <localPort> <remotePort>`: the process at the other end of a loopback connection, for a manual check of
 * `resources.peer` (H46). The two ports are the ports that the site sees: its listener and the port of the client.
 */
async function showPeer(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" } } });
  const [localPort, remotePort] = positionals.map(Number);
  const valid = (port: number | undefined): port is number => port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65_535;
  if (positionals.length !== 2 || !valid(localPort) || !valid(remotePort)) return (console.error("Usage: headroom peer <localPort> <remotePort> [--json]"), 2);
  const connection = connect();
  if (!connection) return (console.error("headroom does not run."), 1);
  let peer: Peer;
  try {
    peer = await connection.call<Peer>(["resources", "peer"], { localPort, remotePort });
  } catch (error) {
    const code = String((error as { code?: unknown } | null)?.code ?? "");
    if (!PEER_ERRORS.has(code)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (values.json) console.log(JSON.stringify({ error: { code, message } }, null, 2));
    else console.error(`headroom: ${code}: ${message}`);
    return 3;
  }
  if (values.json) {
    console.log(JSON.stringify(peer, null, 2));
    return 0;
  }
  console.log(`Peer: ${peer.exe} (process ${peer.pid})`);
  if (peer.via.length > 1) console.log(`Via: ${peer.via.join(" > ")} (the last is claude.exe)`);
  if (peer.session === undefined) {
    console.log(peer.via.length > 1 || peer.exe.toLowerCase() === "claude.exe" ? "Session: none (this claude.exe has no session file)" : "Session: none (no claude.exe above the peer: anonymous)");
    return 0;
  }
  console.log(`Session: ${peer.session}${peer.sessionId === undefined ? "" : ` (${peer.sessionId})`}`);
  console.log(`Role: ${peer.role ?? "none (no role of the fleet registry matches the session)"}`);
  return 0;
}

/** This function prints the settings. */
function printConfig(config: Config): void {
  console.log(`job-temp: ${config.jobTemp ?? "(none: each job of headroom run uses the TEMP of its parent)"}`);
  // A daemon of an older version has no setting health.
  if (config.health !== undefined) for (const line of healthLines(config.health)) console.log(line);
}

/** `headroom config`: show the settings. `headroom config job-temp <folder>` sets the temp root, and `--clear` removes it. */
async function configCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { clear: { type: "boolean" }, json: { type: "boolean" } } });
  const connection = connect();
  if (!connection) return (console.error("headroom does not run. Start it with: headroom service install"), 1);
  const [name, value] = positionals;
  if (name === undefined) {
    const config = await connection.call<Config>(["config", "get"], {});
    if (values.json) console.log(JSON.stringify(config, null, 2));
    else printConfig(config);
    return 0;
  }
  if (name === "health") {
    const [, check, url] = positionals;
    const current = (await connection.call<Config>(["config", "get"], {})).health ?? {};
    const health = positionals.length > 3 ? undefined : healthChange(current, check, url, values.clear === true);
    if (health === undefined && (check !== undefined || values.clear === true || positionals.length > 3)) {
      console.error("Usage: headroom config health, headroom config health <name> <url>, headroom config health <name> --clear, or headroom config health --clear");
      return 2;
    }
    if (health === undefined) for (const line of healthLines(current)) console.log(line);
    else printConfig(await connection.call<Config>(["config", "set"], { health }));
    return 0;
  }
  if (name !== "job-temp" || (value === undefined) === (values.clear !== true) || positionals.length > 2) {
    console.error("Usage: headroom config, headroom config job-temp <folder>, headroom config job-temp --clear, or headroom config health");
    return 2;
  }
  // The daemon has its own current folder, so a relative folder resolves here.
  printConfig(await connection.call<Config>(["config", "set"], { jobTemp: value === undefined ? null : resolve(value) }));
  return 0;
}

function resumePlan(): void {
  const sessions = readSessions().sort((a, b) => (a.name === "organizer" ? -1 : b.name === "organizer" ? 1 : a.name.localeCompare(b.name)));
  console.log("# The resume plan: one line for each live Claude Code session, the organizer first\n");
  for (const session of sessions) {
    console.log(`# ${session.name}`);
    console.log(`Set-Location "${session.cwd ?? "."}"; claude --resume ${session.sessionId}\n`);
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "serve": {
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: "string" }, reserve: { type: "string" }, background: { type: "boolean" }, log: { type: "string" } },
      });
      return serve({
        port: values.port ? Number(values.port) : undefined,
        reserveMb: values.reserve ? parseMemory(values.reserve) : undefined,
        mode: values.background ? "background" : "foreground",
        log: values.log ? fileLog(values.log) : undefined,
      });
    }
    case "service": {
      const [action, ...args] = rest;
      if (action === "install") {
        const { values } = parseArgs({ args, options: { port: { type: "string" }, reserve: { type: "string" } } });
        return service.install([...(values.port ? ["--port", values.port] : []), ...(values.reserve ? ["--reserve", values.reserve] : [])]);
      }
      if (action === "uninstall") return service.uninstall();
      if (action === "stop") return service.stop();
      if (action === "start") return service.start();
      if (action === "restart") {
        const { values } = parseArgs({
          args,
          options: {
            now: { type: "boolean" },
            wait: { type: "string" },
            "when-idle": { type: "boolean" },
            cancel: { type: "boolean" },
            // The helper of --when-idle: the daemon starts it with the process ID of the daemon and the log file.
            after: { type: "string" },
            log: { type: "string" },
          },
        });
        if (values["when-idle"] === true || values.cancel === true) return service.restartWhenIdle({ cancel: values.cancel === true });
        const after = values.after === undefined ? undefined : Number(values.after);
        if (after !== undefined && !(Number.isInteger(after) && after > 0)) return (console.error("headroom service restart --after needs a process ID."), 2);
        return service.restart({
          now: values.now === true,
          waitMs: values.wait ? parseTime(values.wait) : undefined,
          after,
          log: values.log ? fileLog(values.log) : undefined,
        });
      }
      if (action === "status") return service.status();
      console.error("Usage: headroom service install | restart | stop | start | uninstall | status");
      return 2;
    }
    case "status": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      const connection = connect();
      if (!connection) {
        console.error("headroom does not run. Start it with: headroom serve");
        return 1;
      }
      const status = await connection.call<DaemonStatus>(["resources", "status"], {});
      if (values.json) console.log(JSON.stringify(status, null, 2));
      else printStatus(status);
      return 0;
    }
    case "run":
      return run(rest);
    case "job":
      return jobCommand(rest, connect());
    case "pool-tags": {
      const { values } = parseArgs({ args: rest, options: { drivers: { type: "boolean" }, json: { type: "boolean" } } });
      return showPoolTags(values.drivers === true, values.json === true);
    }
    case "dashboard": {
      const endpoint = connect()?.endpoint;
      if (!endpoint) return (console.error("headroom does not run. Start it with: headroom service install"), 1);
      // The key of the dashboard is in a file that only this user can read. The page refuses a request without it.
      const url = `${new URL(endpoint).origin}/?k=${dashboardKey()}`;
      console.log(`The dashboard: ${url}`);
      const opener =
        process.platform === "win32"
          ? windowsCommand(["start", "", url])
          : { file: process.platform === "darwin" ? "open" : "xdg-open", args: [url], verbatim: false };
      spawn(opener.file, opener.args, { stdio: "ignore", detached: true, windowsHide: true, windowsVerbatimArguments: opener.verbatim })
        .on("error", () => undefined)
        .unref();
      return 0;
    }
    case "alerts": {
      const { values } = parseArgs({ args: rest, options: { watch: { type: "boolean" }, json: { type: "boolean" } } });
      return values.watch ? watchAlerts() : showAlerts(values.json === true);
    }
    case "history": {
      const { values } = parseArgs({ args: rest, options: { minutes: { type: "string" }, json: { type: "boolean" } } });
      const connection = connect();
      if (!connection) return (console.error("headroom does not run."), 1);
      const history = await connection.call<History>(["resources", "history"], { minutes: Number(values.minutes ?? 60) });
      if (values.json) console.log(JSON.stringify(history, null, 2));
      else for (const row of history.memory) console.log(`${new Date(row.at).toISOString().slice(11, 16)}  available ${mb(row.availableMb).padStart(8)}  committed ${mb(row.commitMb).padStart(8)}  non-paged ${mb(row.kernelNonpagedMb)}`);
      return 0;
    }
    case "pool": {
      const [name, capacity] = rest;
      const connection = connect();
      if (!connection || !name || capacity === undefined) return (console.error("Usage: headroom pool <name> <capacity>, with the daemon running"), 1);
      printStatus(await connection.call<Status>(["resources", "pool"], { name, capacity: Number(capacity) }));
      return 0;
    }
    case "release": {
      const connection = connect();
      if (!connection || !rest[0]) return (console.error("Usage: headroom release <id>, with the daemon running"), 1);
      const lease = await connection.call<Lease>(["resources", "release"], { id: rest[0], reason: "released by hand" });
      console.log(`${lease.id}: ${lease.state}`);
      return 0;
    }
    case "ports": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      return showPorts(values.json === true);
    }
    case "peer":
      return showPeer(rest);
    case "config":
      return configCommand(rest);
    case "services":
      return servicesCommand(rest, connect());
    case "mcp":
      return mcpCommand(rest, connect());
    case "resume-plan":
      resumePlan();
      return 0;
    default:
      console.log(HELP);
      return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`headroom: ${isNetworkError(error) ? "the daemon does not answer" : error instanceof Error ? error.message : String(error)}`);
  return 1;
});
