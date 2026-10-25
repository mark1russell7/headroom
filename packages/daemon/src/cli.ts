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
 * - `headroom forecast [--json]`: the time of each resource to its nearest limit, from the fit of its history (H32).
 * - `headroom thermal [--json]`: the speed limits, the speed and the thermal zones of the CPU, and the throttle (H35).
 * - `headroom config [job-temp <folder>] [health <name> <url>] [spawn-heavy <n>] [battery-floor <pct>] [usage-file <path>] [cpu-reserve <cores>]`: show or change the settings.
 * - `headroom config [presence on|off] [away-after <time>] [busy-wait <time>] [present-reserve <cores>]`: the presence rules (H33).
 * - `headroom config auto-drain <size>|off`: the level of the kernel pools that starts an automatic drain (H34).
 * - `headroom presence [--json]`: the state of Mark at the laptop, and its history (H33).
 * - `headroom ports [--json]`: the listening TCP ports, with the process and the owner of each port (H24).
 * - `headroom gpu [--json]`: each GPU adapter with its memory, its use and its owners, and the leased jobs (H36).
 * - `headroom services [--json]`: the health of Docker, the MCP servers of the gateway and the configured URLs (H27).
 * - `headroom peer <localPort> <remotePort> [--json]`: the process, the session and the role at the other end of a loopback connection (H46).
 * - `headroom reboot-plan [--json]`: the reboot budget: the kernel pools, a waiting Windows update, the uptime and a recommendation (H34).
 * - `headroom drain --at <HH:MM|now> [--until <HH:MM>]` and `headroom drain --cancel`: a planned drain for a reboot (H34).
 * - `headroom history`, `headroom pool <name> <capacity>`, `headroom release <id>`, `headroom resume-plan`.
 */

import { spawn, type StdioOptions } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, openSync } from "node:fs";
import { availableParallelism, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createJob,
  createSampler,
  diskLevel,
  diskSize,
  forecastLine,
  forecastText,
  gpuLines,
  leaseGpuText,
  kindOf,
  MB,
  powerLine,
  isBrowserLease,
  isSpawnWait,
  AUTO_DRAIN_DEFAULT_MB,
  AUTO_DRAIN_MARGIN_MB,
  BATTERY_FLOOR_DEFAULT,
  coresText,
  drainLine,
  localClock,
  nextClock,
  rebootLines,
  CPU_AUTO_DEFAULT,
  CPU_RESERVE_DEFAULT,
  cpuLine,
  conditionsText,
  defaultUsageFile,
  parseWhen,
  AWAY_AFTER_DEFAULT_MS,
  BUSY_WAIT_DEFAULT_MS,
  PRESENT_RESERVE_DEFAULT,
  elapsedText,
  presenceHistoryLines,
  presenceLine,
  stateText,
  readSessions,
  unmetText,
  SPAWN_HEAVY_DEFAULT,
  spawnClassText,
  spawnLine,
  startsLine,
  thermalLine,
  thermalLines,
  SUM_WAIT_START,
  type Alert,
  type Alerts,
  type Config,
  type DrainStatus,
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
import { GPU_USAGE, gpuCommand } from "./gpu-cli.ts";
import { sessionFromEnv } from "./holder.ts";
import { diskAmounts, finishTemp, jobEnv, jobLimits, prepareTemp, type LimitOptions } from "./job.ts";
import { JOB_USAGE, jobCommand } from "./job-cli.ts";
import { parseDisk, parseMemory, parseTime } from "./parse.ts";
import { dashboardKey, readDiscovery, readPlannedStop } from "./paths.ts";
import { resumePlanLines, writeResumePlan } from "./resume.ts";
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
  headroom run [--mem 2g|auto] [--cpu 2|auto] [--disk 5g|D:=5g]... [--slot docker]... [--holder name] [--job name]
               [--priority 0] [--wait 30m] [--limit] [--keep] [--keep-temp] [--force-disk] [--no-eco] [--log file]
               [--spawn-heavy | --no-spawn-heavy] [--when ac,battery>=50,usage<80] [--timing]
               [--battery-ok] [--during-drain] [--ignore-presence] -- <command> [args...]
               --limit: the job cannot use more memory than --mem, or more cores than --cpu (a hard cap).
               Without --limit, the leased jobs share the processors by equal weights. --keep: no job object.
               --cpu auto: the peak cores of the last runs of the job, as --mem auto does for memory.
               The leases do not take the last ${CPU_RESERVE_DEFAULT} cores: headroom config cpu-reserve changes them.
               On battery, the job runs in efficiency mode (EcoQoS). --no-eco: not.
               --log file: the output of the job also goes to the end of the file.
               The run prints the lease id first: headroom job <id> gives the state of the job.
               --disk 5g: space on the drive of the current folder. --disk D:=5g: on the drive D:.
               With a temp root (headroom config job-temp), the job gets its own TEMP folder,
               and the run removes it at the end. --keep-temp: keep the folder.
               A browser test (playwright test, e2e) takes the slot browser. --no-auto-slot: not.
               A job whose past runs start more than 600 processes a minute is spawn-heavy:
               it does not run beside a browser test. --spawn-heavy: say so for a new job.
               --no-spawn-heavy: a normal job, also with high past runs. Beside a browser test, the
               other leases together start at most 600 processes a minute.
               --when: the job waits until each condition holds. ac: plugged in. battery>=50: 50% or
               more, or plugged in. usage<80: the five-hour usage window of Claude is under 80%.
               starts<700: the computer starts fewer than 700 processes a minute (last 2 minutes).
               --timing: a timing-sensitive job waits for AC power. Timing tests belong in CI.
               On battery below the floor (${BATTERY_FLOOR_DEFAULT}%), a heavy job waits: 2 GB or more, the slot
               browser, or spawn-heavy. --battery-ok: start it anyway.
               In a planned drain for a reboot, a new job waits. --during-drain: start it anyway.
               While Mark is on a call, presents or uses a full-screen app, a new heavy job waits
               (up to 20 min). While Mark is at the laptop, a heavy job runs in efficiency mode, and
               2 more cores stay for Mark. --when away: wait until Mark is away. --ignore-presence: not.
               A drive with less than 5 GB free stops the start (exit 75). --force-disk: start anyway.
  ${JOB_USAGE}
               The state of a job: queued, running or exited, with its exit code. No job: exit 3.
  headroom config [job-temp <folder> | job-temp --clear]   (show or change the settings)
  headroom config health [<name> <url> | <name> --clear | --clear]
               The URLs that the service monitor checks. The default: ${DEFAULT_HEALTH_TEXT}.
  headroom config spawn-heavy [<n> | --clear]
               The limit of a spawn-heavy job, in process starts a minute. The default: ${SPAWN_HEAVY_DEFAULT}.
  headroom config battery-floor [<pct> | --clear]
               On battery below this charge, a heavy job waits. 0: no floor. The default: ${BATTERY_FLOOR_DEFAULT}.
  headroom config usage-file [<path> | --clear]
               The usage file of the fleet for --when usage<N.
  headroom config cpu-reserve [<cores> | --clear]
               The cores that the leases do not take, for Mark. 0: no reserve. The default: ${CPU_RESERVE_DEFAULT}.
  headroom config presence [on | off | --clear]
               The presence rules: heavy jobs wait or run slower while Mark works. The default: on.
  headroom config away-after [<time> | --clear]
               With no input for this time, Mark is away. The default: ${elapsedText(AWAY_AFTER_DEFAULT_MS)}.
  headroom config busy-wait [<time> | --clear]
               The longest wait of a heavy job while Mark is busy. The default: ${elapsedText(BUSY_WAIT_DEFAULT_MS)}.
  headroom config present-reserve [<cores> | --clear]
               The cores that the reserve gets while Mark is at the laptop. While away: no reserve. The default: ${PRESENT_RESERVE_DEFAULT}.
  headroom config auto-drain [<size> | off | --clear]
               When the two kernel pools stay at or above this size for 2 minutes, an automatic drain
               starts: new jobs wait for a reboot. off: no automatic drain. The default: ${mb(AUTO_DRAIN_DEFAULT_MB)}.
  headroom presence [--json]                (Mark at the laptop: present, busy or away, and the history)
  ${SERVICES_USAGE}                 (Docker, the MCP servers and the URLs: ok, slow, down, idle)
  headroom dashboard                         (open the dashboard in the browser)
  headroom alerts [--watch] [--json]
  headroom forecast [--json]                (the time of each resource to its nearest limit, from its history)
  headroom thermal [--json]                 (the speed limits, the speed and the heat of the CPU, and the throttle)
  headroom reboot-plan [--json]             (the reboot budget: the kernel pools, a waiting update, the uptime)
  headroom drain --at <HH:MM|now> [--until <HH:MM>] | --cancel
               A planned drain for a reboot: from the time, new jobs wait and the running jobs finish.
               An alert tells when no job runs. --until: the drain ends at that time if no reboot came.
               headroom does not reboot the computer. Only Mark does.
               The kernel pools at the level of headroom config auto-drain start a drain with no end.
  headroom pool-tags [--drivers] [--json]   (the kernel pool by tag, Windows)
  headroom ports [--json]                   (the listening TCP ports, with their process and owner)
  ${GPU_USAGE}                     (each GPU: its memory, its use, its owners and the leased jobs)
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
  // H34: the planned drain, and a recommendation to reboot. A daemon of an older version gives no reboot budget.
  const drain = status.reboot === undefined ? null : drainLine(status.reboot.drain);
  if (drain !== null) console.log(drain);
  const advice = status.reboot?.advice;
  if (advice !== undefined && advice.level !== "none") console.log(`Reboot: ${advice.text}`);
  if ((status.alerts ?? []).length > 0 || status.restart || drain !== null || (advice !== undefined && advice.level !== "none")) console.log("");
  // H33: Mark at the laptop. A daemon of an older version and a computer with no read of the presence give no line.
  const you = presenceLine(status.presence, status.leases);
  if (you !== null) console.log(you);
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
  // H23: the reserve for Mark and the capped jobs. A daemon of an older version gives no reserve.
  const cpu = cpuLine((status.resources ?? []).find((each) => each.id === "cpu"), status.cpuReserve, status.leases);
  if (cpu !== null) console.log(cpu);
  // H30: the battery and the power. A computer with no battery and no Energy Meter has no line.
  const power = powerLine(status.resources ?? [], status.power);
  if (power !== null) console.log(power);
  // H35: a line only while the CPU is throttled or hot. A daemon of an older version gives no state.
  const heat = thermalLine(status.thermal);
  if (heat !== null) console.log(heat);
  // H36: the GPU memory and use of each adapter. A daemon of an older version and a computer with no GPU counters give none.
  for (const line of gpuLines(status.gpu)) console.log(line);
  // H32: the forecasts under 24 hours, the nearest first. A daemon of an older version gives none.
  const forecasts = forecastLine(status.resources ?? []);
  if (forecasts !== null) console.log(forecasts);
  // H29: the process starts. A daemon of an older version gives none.
  const starts = status.starts === undefined ? null : startsLine(status.starts);
  if (starts !== null) console.log(starts);
  // H47: the spawn-heavy jobs that run. A browser test waits until they end.
  const heavy = spawnLine(status.leases);
  if (heavy !== null) console.log(heavy);
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
    // H31: the conditions of the lease. A granted lease that runs without one of its conditions says so.
    const conditions = conditionsText(lease.conditions);
    const note = (lease.unmet?.until === null ? unmetText(lease.unmet) : null) ?? lease.reason;
    // H36: the GPU memory of the job and its peak.
    const gpu = leaseGpuText(lease, status.gpu);
    console.log(
      `  ${lease.state.padEnd(8)} ${lease.holder.padEnd(14)} ${lease.job.slice(0, 40).padEnd(40)} ${amounts}${conditions === null ? "" : `  [${conditions}]`}${gpu === null ? "" : `  ${gpu}`}${note ? `  (${note})` : ""}`,
    );
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

/** How `headroom run` holds its job: a job object, and a memory limit and a CPU cap with --limit (H23). */
interface Enforcement extends LimitOptions {
  /** True (--keep): no job object, so the processes of the job can stay after the run. */
  readonly keep: boolean;
  /** True (--no-eco): the job keeps its full speed on battery (H30). */
  readonly noEco?: boolean | undefined;
}

/** The efficiency mode of a job from the answer of a heartbeat (H30), with its reason (H33). */
interface EcoAnswer {
  readonly on: boolean;
  /** The reason, for example "Mark works at the laptop". A daemon of an older version gives none. */
  readonly reason: string | null;
}

/** This function writes the message of a change of the efficiency mode of a job (H30, H33). */
function ecoText(answer: EcoAnswer): string {
  if (!answer.on) return "headroom: the job runs at full speed again.";
  return `headroom: ${answer.reason ?? "the laptop runs on battery"}, so the job runs in efficiency mode (EcoQoS). --no-eco: full speed.`;
}

/** The time between two counts of the processes of a job for the daemon (H29). */
const PROCESS_REPORT_MS = 30_000;
/** The time from the start of a job to its first heartbeat, so a job on battery gets efficiency mode soon (H30). */
const FIRST_REPORT_MS = 3000;

/** The end of a job in a job object: the end of its command and its peak memory. It also has the processes that it started (H29) and its processor time (H23). */
interface EnforcedEnd extends CommandEnd {
  readonly peakMb: number | null;
  readonly processes: number | null;
  readonly cpuMs: number | null;
}

/**
 * This function runs a command in a job object (H6, Windows). When this process exits, Windows stops each process of the
 * job that still runs, so no process of the job stays as an orphan. With --limit, the job cannot commit more memory than
 * its lease. The function prints the peak memory of the job, so the holder can size the next lease.
 *
 * Every 30 seconds, `report` gets the count of processes that the job started so far (H29). The count of the job object
 * includes this process, so the count of the job starts after it. The answer of `report` tells if the job runs in efficiency
 * mode (H30), and why. On battery, or for a heavy job while Mark is at the laptop (H33), the processes of the job go into
 * EcoQoS, unless --no-eco. The first report comes after 3 seconds.
 */
async function runEnforced(
  command: readonly string[],
  enforcement: Enforcement,
  env: Readonly<Record<string, string>> = {},
  log: string | null = null,
  report?: (processes: number) => Promise<EcoAnswer | undefined>,
): Promise<EnforcedEnd> {
  let held: Job | null = null;
  const processors = availableParallelism();
  if (!enforcement.keep) {
    const limits = jobLimits(enforcement, process.memoryUsage().rss / MB, processors);
    try {
      held = await createJob(limits);
    } catch (error) {
      console.error(`headroom: no job object (${error instanceof Error ? error.message : String(error)}). The job runs without one.`);
    }
    // H23: a refused CPU rate does not stop the job. Only a refused cap needs a word.
    if (held !== null && limits.cpuRate !== undefined) {
      console.error(
        held.cpu === null
          ? `headroom: Windows refused the CPU cap (${held.cpuError ?? "no reason"}). The job runs without it.`
          : `headroom: the job cannot use more than ${coresText(enforcement.leaseCores ?? 0)} (--limit).`,
      );
    }
  }
  const base = held?.peakMb() ?? 0;
  const job = held;
  const baseProcesses = job?.processes() ?? 0;
  const baseCpuMs = job?.cpuMs() ?? 0;
  const startedAt = Date.now();
  const started = (): number => Math.max(0, (job?.processes() ?? 0) - baseProcesses);
  let eco = false;
  const heartbeat = (): void => {
    if (job === null || report === undefined) return;
    void report(started()).then((answer) => {
      if (enforcement.noEco === true || answer === undefined) return;
      const on = answer.on;
      try {
        job.eco(on);
      } catch {
        return;
      }
      if (on !== eco) console.error(ecoText(answer));
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
  if (!job) return { code, exit, peakMb: null, processes: null, cpuMs: null };
  const peakMb = Math.max(0, job.peakMb() - base);
  const processes = started();
  // H23: the processor time of the job object, also of the processes that ended. The daemon keeps the average as a peak.
  const cpuMs = Math.max(0, Math.round(job.cpuMs() - baseCpuMs));
  const ranMs = Math.max(1, Date.now() - startedAt);
  const of = enforcement.leaseMb === null ? "" : ` of its lease of ${mb(enforcement.leaseMb)}`;
  console.error(
    `headroom: the job used at most ${mb(peakMb)}${of}. It started ${processes} ${processes === 1 ? "process" : "processes"}, and used ${coresText(cpuMs / ranMs)} on average.`,
  );
  if (job.limitMb !== null && job.peakMb() >= job.limitMb * 0.97) {
    console.error(`headroom: the job reached its memory limit. Ask for a larger lease, for example --mem ${Math.ceil((enforcement.leaseMb ?? 0) * 1.5 / 1024)}g.`);
  }
  return { code, exit, peakMb, processes, cpuMs };
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

/**
 * This function gives the line that names a new lease, for example "headroom: lease 3f2a9c1e for e2e, queued for browser."
 * A lease that waits for the spawn rule (H47) is queued for the browser tests, or for a job that starts many processes.
 */
function leaseLine(lease: Lease): string {
  const browserWait = lease.reason?.startsWith(SUM_WAIT_START) === true ? "the other jobs to start fewer processes" : "a job that starts many processes";
  const spawnWait = !isSpawnWait(lease.reason) ? undefined : isBrowserLease(lease) ? browserWait : "the browser tests";
  // H31: a lease that waits for a condition is queued until the condition holds, for example "until the laptop is plugged in".
  const until = /^waits until ([^(:]+)/.exec(lease.reason ?? "")?.[1]?.trim();
  const waitsFor = spawnWait ?? /^waits for ([^:]+):/.exec(lease.reason ?? "")?.[1];
  const queued = until !== undefined ? ` until ${until}` : waitsFor === undefined ? "" : ` for ${waitsFor}`;
  const state = lease.state === "granted" ? "granted" : lease.state === "waiting" ? `queued${queued}` : lease.state;
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
      "spawn-heavy": { type: "boolean" },
      "no-spawn-heavy": { type: "boolean" },
      when: { type: "string", multiple: true },
      timing: { type: "boolean" },
      "battery-ok": { type: "boolean" },
      "during-drain": { type: "boolean" },
      "ignore-presence": { type: "boolean" },
    },
  });
  if (positionals.length === 0) {
    console.error("headroom run needs a command after --. Example: headroom run --mem 2g -- pnpm test");
    return 2;
  }
  // H31: the conditions of the job. A wrong condition stops the run here, with the list of the known conditions.
  let when: string[];
  try {
    when = parseWhen(values.when ?? []).map((spec) => spec.text);
  } catch (error) {
    console.error(`headroom: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const timing = values.timing === true;
  const batteryOk = values["battery-ok"] === true;
  const duringDrain = values["during-drain"] === true;
  const ignorePresence = values["ignore-presence"] === true;
  if (values["spawn-heavy"] === true && values["no-spawn-heavy"] === true) {
    console.error("headroom run takes --spawn-heavy or --no-spawn-heavy, not both.");
    return 2;
  }
  // H47: the option of the run. Without it, the past runs of the job decide.
  const spawnHeavy = values["spawn-heavy"] === true ? true : values["no-spawn-heavy"] === true ? false : undefined;
  const opened = values.log === undefined ? null : openLog(values.log);
  if (opened !== null && "error" in opened) {
    console.error(`headroom: ${opened.error}`);
    return 2;
  }
  const log = opened?.path ?? null;
  const amounts: Record<string, number> = {};
  if (values.mem && values.mem !== "auto") amounts["memory"] = parseMemory(values.mem);
  if (values.cpu && values.cpu !== "auto") {
    const cores = Number(values.cpu);
    if (!(Number.isFinite(cores) && cores > 0)) {
      console.error(`headroom: --cpu needs a count of cores above 0, or auto, not ${values.cpu}.`);
      return 2;
    }
    amounts["cpu"] = cores;
  }
  for (const slot of values.slot ?? []) amounts[slot] = (amounts[slot] ?? 0) + 1;
  // Browser tests of two sessions at the same time start many browser processes, and process starts can fail
  // (0xC0000142). The slot `browser` is a lock of 1 unless a pool sets more.
  for (const slot of values["no-auto-slot"] === true ? [] : autoSlots(positionals.join(" "))) {
    if (amounts[slot] !== undefined) continue;
    amounts[slot] = 1;
    if (slot === BROWSER_SLOT) console.error(`headroom: this job runs browser tests, so it takes the slot "${BROWSER_SLOT}": one browser test job at a time.`);
  }
  const job = values.job ?? positionals.join(" ").slice(0, 500);
  if (values.limit && !values.mem && !values.cpu) {
    console.error("headroom run --limit needs --mem or --cpu: the limit is the memory or the cores of the lease.");
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
    const conditions = when.length > 0 || timing ? " and without its conditions" : "";
    console.error(`headroom: the daemon does not run, so the job runs without a lease${conditions}.`);
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
  // --mem auto and --cpu auto: the peaks of the last runs of this job give the amounts.
  const suggestion =
    values.mem === "auto" || values.cpu === "auto" ? await connection.call<Suggestion>(["resources", "suggest"], { job, holder }).catch(() => null) : null;
  if (values.mem === "auto") {
    amounts["memory"] = suggestion?.memoryMb ?? AUTO_DEFAULT_MB;
    console.error(
      suggestion?.memoryMb
        ? `headroom: --mem auto gives ${mb(amounts["memory"])}, from the peaks of ${suggestion.runs} ${suggestion.runs === 1 ? "run" : "runs"} (the highest ${mb(suggestion.peakMb ?? 0)}).`
        : `headroom: --mem auto gives ${mb(AUTO_DEFAULT_MB)}, because no run of this job has a peak yet.`,
    );
  }
  // H23: a daemon of an older version gives no cores.
  if (values.cpu === "auto") {
    const cores = typeof suggestion?.cores === "number" ? suggestion.cores : null;
    amounts["cpu"] = cores ?? CPU_AUTO_DEFAULT;
    console.error(
      cores !== null && suggestion !== null
        ? `headroom: --cpu auto gives ${coresText(cores)}, from the peak cores of ${suggestion.coreRuns} ${suggestion.coreRuns === 1 ? "run" : "runs"} (the highest ${coresText(suggestion.peakCores ?? 0)}).`
        : `headroom: --cpu auto gives ${coresText(CPU_AUTO_DEFAULT)}, because no run of this job has peak cores yet.`,
    );
  }
  const limit = values.limit === true;
  const leaseCores = amounts["cpu"] ?? null;
  const enforcement: Enforcement = { keep, limit, leaseMb: amounts["memory"] ?? null, leaseCores, noEco: values["no-eco"] === true };
  const request = {
    holder,
    job,
    amounts,
    pid: process.pid,
    ...(values.priority ? { priority: Number(values.priority) } : {}),
    ...(log === null ? {} : { log }),
    ...(spawnHeavy === undefined ? {} : { spawnHeavy }),
    ...(when.length === 0 ? {} : { when }),
    ...(timing ? { timing } : {}),
    ...(batteryOk ? { batteryOk } : {}),
    ...(duringDrain ? { duringDrain } : {}),
    ...(ignorePresence ? { ignorePresence } : {}),
    // H23: the status names the capped jobs. The job object of this process holds the cap.
    ...(limit && leaseCores !== null && !keep ? { cpuCap: leaseCores } : {}),
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
  // H31: a daemon of an older version does not know the conditions, and it grants the lease without them.
  if ((when.length > 0 || timing) && first.conditions === undefined) {
    console.error("headroom: the daemon is older than --when and --timing, so the job runs without its conditions. Run headroom service restart.");
  }
  // H47: a spawn-heavy job does not run beside a browser test. A daemon of an older version gives no class.
  if (first.spawn?.heavy === true) {
    const opt = first.spawn.source === "declared" ? "" : " --no-spawn-heavy: not.";
    console.error(`headroom: this job is ${spawnClassText(first.spawn)}, so it does not run beside a browser test.${opt}`);
  }
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
  let result: EnforcedEnd = { code: 1, exit: { code: null, signal: null }, peakMb: null, processes: null, cpuMs: null };
  let tempMb: number | null = null;
  // H29: the heartbeat gives the daemon the count of processes of the job. A daemon that does not answer misses one count.
  // H30: its answer tells if the job runs in efficiency mode. A daemon of an older version gives no answer for it.
  // H33: the answer also tells why, for example "Mark works at the laptop".
  const report = (processes: number): Promise<EcoAnswer | undefined> =>
    (connect() ?? latest).call<RenewAnswer>(["resources", "renew"], { id: lease.id, processes }).then(
      (answer) => (typeof answer.eco === "boolean" ? { on: answer.eco, reason: typeof answer.ecoReason === "string" ? answer.ecoReason : null } : undefined),
      () => undefined,
    );
  try {
    result = await runEnforced(positionals, enforcement, temp?.env ?? {}, log, report);
  } finally {
    if (temp !== null) tempMb = finishTemp(temp, values["keep-temp"] === true);
  }
  const { code, exit, peakMb, processes, cpuMs } = result;
  const peak = peakMb === null ? "" : `, peak ${mb(peakMb)}`;
  const ended = exit.code === null && exit.signal !== null ? `the job ended with signal ${exit.signal}` : `the job ended with code ${code}`;
  const usage: JobUsage = { ...(peakMb === null ? {} : { peakMb }), ...(tempMb === null ? {} : { tempMb }), ...(cpuMs === null ? {} : { cpuMs }) };
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

/**
 * `headroom forecast`: the forecast of each instance to its nearest target, the nearest first (H32). The daemon fits the
 * history of the last hour at each sample. The battery gives the time left that Windows estimates.
 */
async function showForecasts(json: boolean): Promise<number> {
  const connection = connect();
  if (!connection) return (console.error("headroom does not run."), 1);
  const status = await connection.call<DaemonStatus>(["resources", "status"], {});
  const list = (status.resources ?? []).filter((each) => each.forecast !== undefined).sort((a, b) => (a.forecast?.minutes ?? 0) - (b.forecast?.minutes ?? 0));
  if (json) {
    console.log(JSON.stringify(list.map(({ id, kind, unit, capacity, used, free, forecast }) => ({ id, kind, unit, capacity, used, free, forecast })), null, 2));
    return 0;
  }
  if (list.length === 0) console.log("No resource moves toward a limit. A forecast needs 30 minutes of history with a clear trend.");
  for (const each of list) console.log(forecastText(each));
  return 0;
}

/**
 * `headroom thermal`: the reads of the speed and the heat of the CPU, the throttle and the condition `cool` (H35). While the
 * CPU is throttled, it also names the owners with the most cores.
 */
async function showThermal(json: boolean): Promise<number> {
  const connection = connect();
  if (!connection) return (console.error("headroom does not run."), 1);
  const status = await connection.call<DaemonStatus>(["resources", "status"], {});
  if (json) {
    console.log(JSON.stringify(status.thermal ?? null, null, 2));
    return 0;
  }
  if (status.thermal === undefined) return (console.error("headroom: the daemon is older than the heat reads (H35). Run headroom service restart."), 1);
  for (const line of thermalLines(status.thermal)) console.log(line);
  return 0;
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
  // H47: a daemon of an older version has no setting spawn-heavy.
  if (typeof config.spawnHeavy === "number") {
    const named = config.spawnHeavy === SPAWN_HEAVY_DEFAULT ? " (the default)" : "";
    console.log(`spawn-heavy: ${config.spawnHeavy} process starts a minute${named}. A job above it does not run beside a browser test.`);
  }
  // H31: a daemon of an older version has no battery floor and no usage file.
  if (typeof config.batteryFloor === "number") {
    const named = config.batteryFloor === BATTERY_FLOOR_DEFAULT ? " (the default)" : "";
    console.log(
      config.batteryFloor === 0
        ? "battery-floor: 0 (no floor). A heavy job starts on each charge."
        : `battery-floor: ${config.batteryFloor}%${named}. On battery below it, a heavy job waits. --battery-ok starts it.`,
    );
  }
  if (typeof config.usageFile === "string") {
    console.log(`usage-file: ${config.usageFile}${config.usageFile === defaultUsageFile() ? " (the default)" : ""}. The condition usage<N reads it.`);
  }
  // H23: a daemon of an older version has no CPU reserve.
  if (typeof config.cpuReserve === "number") {
    const named = config.cpuReserve === CPU_RESERVE_DEFAULT ? " (the default)" : "";
    console.log(
      config.cpuReserve === 0
        ? "cpu-reserve: 0 (no reserve). The leases can take each core."
        : `cpu-reserve: ${coresText(config.cpuReserve)}${named}. The cpu amounts of the leases do not take them, so Mark keeps them.`,
    );
  }
  // H33: a daemon of an older version has no presence rules.
  if (typeof config.presence === "boolean") {
    console.log(
      config.presence
        ? "presence: on (the default). While Mark works or is on a call, heavy jobs wait or run in efficiency mode."
        : "presence: off. The daemon measures the presence, but it changes no wait, no efficiency mode and no reserve.",
    );
  }
  const byDefault = (value: number, fallback: number): string => (value === fallback ? " (the default)" : "");
  if (typeof config.awayAfterMs === "number") {
    console.log(`away-after: ${elapsedText(config.awayAfterMs)}${byDefault(config.awayAfterMs, AWAY_AFTER_DEFAULT_MS)}. With no input for this time, Mark is away.`);
  }
  if (typeof config.busyWaitMs === "number") {
    console.log(`busy-wait: ${elapsedText(config.busyWaitMs)}${byDefault(config.busyWaitMs, BUSY_WAIT_DEFAULT_MS)}. A heavy job waits at most this time while Mark is busy.`);
  }
  if (typeof config.presentReserve === "number") {
    console.log(
      `present-reserve: ${coresText(config.presentReserve)}${byDefault(config.presentReserve, PRESENT_RESERVE_DEFAULT)} more for Mark while Mark is at the laptop. While Mark is away, the reserve is 0.`,
    );
  }
  // H34: a daemon of an older version has no automatic drain.
  if (typeof config.autoDrainMb === "number") {
    console.log(
      config.autoDrainMb === 0
        ? "auto-drain: off. The kernel pools start no drain."
        : `auto-drain: ${mb(config.autoDrainMb)}${byDefault(config.autoDrainMb, AUTO_DRAIN_DEFAULT_MB)}. When the kernel pools stay at or above it for 2 minutes, new jobs wait for a reboot.`,
    );
  }
}

/** `headroom config auto-drain <size>|off` sets the level of the automatic drain (H34). `--clear` gives the default. */
async function autoDrainConfig(connection: Connection, value: string | undefined, clear: boolean, extra: boolean): Promise<number> {
  let level: number | null = null;
  try {
    level = value === undefined ? null : value.trim().toLowerCase() === "off" ? 0 : parseMemory(value);
  } catch {
    level = Number.NaN;
  }
  if ((value === undefined) === !clear || extra || (level !== null && !(level === 0 || (Number.isInteger(level) && level >= 1024)))) {
    console.error(`Usage: headroom config auto-drain <size>, for example 6g, from 1g, or headroom config auto-drain off, or --clear (the default: ${mb(AUTO_DRAIN_DEFAULT_MB)})`);
    return 2;
  }
  printConfig(await connection.call<Config>(["config", "set"], { autoDrainMb: level }));
  return 0;
}

/** `headroom config presence on|off` turns the presence rules on or off (H33). `--clear` gives the default: on. */
async function presenceConfig(connection: Connection, value: string | undefined, clear: boolean, extra: boolean): Promise<number> {
  if ((value === undefined) === !clear || extra || (value !== undefined && value !== "on" && value !== "off")) {
    console.error("Usage: headroom config presence on, headroom config presence off, or headroom config presence --clear (the default: on)");
    return 2;
  }
  printConfig(await connection.call<Config>(["config", "set"], { presence: value === undefined ? null : value === "on" }));
  return 0;
}

/** `headroom config away-after <time>` and `busy-wait <time>` set a time of the presence rules (H33). `--clear` gives the default. */
async function presenceTimeConfig(
  connection: Connection,
  name: "away-after" | "busy-wait",
  value: string | undefined,
  clear: boolean,
  extra: boolean,
): Promise<number> {
  let ms: number | null = null;
  try {
    ms = value === undefined ? null : parseTime(value);
  } catch {
    ms = Number.NaN;
  }
  const min = name === "away-after" ? 30_000 : 0;
  if ((value === undefined) === !clear || extra || (ms !== null && !(Number.isInteger(ms) && ms >= min && ms <= 86_400_000))) {
    const fallback = elapsedText(name === "away-after" ? AWAY_AFTER_DEFAULT_MS : BUSY_WAIT_DEFAULT_MS);
    console.error(`Usage: headroom config ${name} <time>, for example 10m, from ${elapsedText(min)} to 24h, or headroom config ${name} --clear (the default: ${fallback})`);
    return 2;
  }
  printConfig(await connection.call<Config>(["config", "set"], name === "away-after" ? { awayAfterMs: ms } : { busyWaitMs: ms }));
  return 0;
}

/** `headroom config present-reserve <cores>` sets the cores that the reserve gets while Mark is at the laptop (H33). */
async function presentReserveConfig(connection: Connection, value: string | undefined, clear: boolean, extra: boolean): Promise<number> {
  const cores = value === undefined ? null : Number(value);
  if ((value === undefined) === !clear || extra || (cores !== null && !(Number.isFinite(cores) && cores >= 0))) {
    console.error(`Usage: headroom config present-reserve <cores>, with a number of 0 or more, or headroom config present-reserve --clear (the default: ${PRESENT_RESERVE_DEFAULT})`);
    return 2;
  }
  printConfig(await connection.call<Config>(["config", "set"], { presentReserve: cores }));
  return 0;
}

/** `headroom presence [--json]`: the state of Mark at the laptop, with its reason and its history (H33). */
async function showPresence(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean" } } });
  const connection = connect();
  if (!connection) return (console.error("headroom does not run."), 1);
  const status = await connection.call<DaemonStatus>(["resources", "status"], {});
  const presence = status.presence;
  if (values.json) {
    console.log(JSON.stringify(presence ?? null, null, 2));
    return 0;
  }
  if (presence === undefined) return (console.error("headroom: the daemon is older than the presence rules (H33). Run headroom service restart."), 1);
  if (presence.state === null || presence.since === null) {
    console.log("You: no read of the presence on this computer. The presence rules change nothing.");
    return 0;
  }
  console.log(presenceLine(presence, status.leases) ?? "");
  console.log(`State: ${stateText(presence.state, presence.busy)} since ${localClock(presence.since)} (${presence.reason ?? "no reason"}).`);
  if (presence.idleSeconds !== null) console.log(`Last input: ${elapsedText(presence.idleSeconds * 1000)} ago. Away after ${elapsedText(presence.awayAfterMs)} with no input.`);
  console.log(`A call: ${presence.call === null ? "no" : `yes (${presence.call})`}.`);
  console.log(`Rules: ${presence.enabled ? `on. Heavy jobs wait at most ${elapsedText(presence.busyWaitMs)} while Mark is busy.` : "off (headroom config presence on)."}`);
  console.log(`CPU reserve for Mark: ${coresText(status.cpuReserve)} now.`);
  console.log("\nHistory (the oldest first):");
  for (const line of presenceHistoryLines(presence.history)) console.log(`  ${line}`);
  return 0;
}

/** `headroom config cpu-reserve <cores>` sets the cores that the leases do not take (H23). `--clear` gives the default. */
async function cpuReserveConfig(connection: Connection, value: string | undefined, clear: boolean, extra: boolean): Promise<number> {
  const reserve = value === undefined ? null : Number(value);
  if ((value === undefined) === !clear || extra || (reserve !== null && !(Number.isFinite(reserve) && reserve >= 0))) {
    console.error(`Usage: headroom config cpu-reserve <cores>, with a number of 0 or more, or headroom config cpu-reserve --clear (the default: ${CPU_RESERVE_DEFAULT})`);
    return 2;
  }
  printConfig(await connection.call<Config>(["config", "set"], { cpuReserve: reserve }));
  return 0;
}

/** `headroom config battery-floor <pct>` sets the battery floor for heavy jobs (H31), and `--clear` gives the default. */
async function batteryFloorConfig(connection: Connection, value: string | undefined, clear: boolean, extra: boolean): Promise<number> {
  const floor = value === undefined ? null : Number(value.replace(/%$/, ""));
  if ((value === undefined) === !clear || extra || (floor !== null && !(Number.isInteger(floor) && floor >= 0 && floor <= 100))) {
    console.error(`Usage: headroom config battery-floor <pct>, with a whole number from 0 to 100, or headroom config battery-floor --clear (the default: ${BATTERY_FLOOR_DEFAULT})`);
    return 2;
  }
  printConfig(await connection.call<Config>(["config", "set"], { batteryFloor: floor }));
  return 0;
}

/** `headroom config usage-file <path>` sets the usage file for `usage<N` (H31), and `--clear` gives the default file. */
async function usageFileConfig(connection: Connection, value: string | undefined, clear: boolean, extra: boolean): Promise<number> {
  if ((value === undefined) === !clear || extra) {
    console.error("Usage: headroom config usage-file <path>, or headroom config usage-file --clear (the default file of the fleet)");
    return 2;
  }
  // The daemon has its own current folder, so a relative path resolves here.
  printConfig(await connection.call<Config>(["config", "set"], { usageFile: value === undefined ? null : resolve(value) }));
  return 0;
}

/** `headroom config spawn-heavy <n>` sets the limit of a spawn-heavy job (H47), and `--clear` gives the default. */
async function spawnHeavyConfig(connection: Connection, value: string | undefined, clear: boolean, extra: boolean): Promise<number> {
  const limit = value === undefined ? null : Number(value);
  if ((value === undefined) === !clear || extra || (limit !== null && !(Number.isInteger(limit) && limit > 0))) {
    console.error(`Usage: headroom config spawn-heavy <n>, with a whole number above 0, or headroom config spawn-heavy --clear (the default: ${SPAWN_HEAVY_DEFAULT})`);
    return 2;
  }
  printConfig(await connection.call<Config>(["config", "set"], { spawnHeavy: limit }));
  return 0;
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
  if (name === "spawn-heavy") return spawnHeavyConfig(connection, value, values.clear === true, positionals.length > 2);
  if (name === "battery-floor") return batteryFloorConfig(connection, value, values.clear === true, positionals.length > 2);
  if (name === "usage-file") return usageFileConfig(connection, value, values.clear === true, positionals.length > 2);
  if (name === "cpu-reserve") return cpuReserveConfig(connection, value, values.clear === true, positionals.length > 2);
  if (name === "presence") return presenceConfig(connection, value, values.clear === true, positionals.length > 2);
  if (name === "away-after" || name === "busy-wait") return presenceTimeConfig(connection, name, value, values.clear === true, positionals.length > 2);
  if (name === "present-reserve") return presentReserveConfig(connection, value, values.clear === true, positionals.length > 2);
  if (name === "auto-drain") return autoDrainConfig(connection, value, values.clear === true, positionals.length > 2);
  if (name !== "job-temp" || (value === undefined) === (values.clear !== true) || positionals.length > 2) {
    console.error(
      "Usage: headroom config, headroom config job-temp <folder>, headroom config job-temp --clear, headroom config health, headroom config spawn-heavy <n>, headroom config battery-floor <pct>, headroom config usage-file <path>, headroom config cpu-reserve <cores>, headroom config auto-drain <size>|off, or headroom config presence on|off, away-after <time>, busy-wait <time> or present-reserve <cores>",
    );
    return 2;
  }
  // The daemon has its own current folder, so a relative folder resolves here.
  printConfig(await connection.call<Config>(["config", "set"], { jobTemp: value === undefined ? null : resolve(value) }));
  return 0;
}

/** `headroom resume-plan` (H13): print the command of each live session, and write the plan to its file (H34). */
function resumePlan(): void {
  const sessions = readSessions();
  for (const line of resumePlanLines(sessions)) console.log(line);
  try {
    console.log(`# The plan is also in ${writeResumePlan(undefined, sessions).path}`);
  } catch (error) {
    console.error(`headroom: the file of the resume plan was not written: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `headroom reboot-plan` (H34): the reboot budget of the daemon, with its recommendation. */
async function rebootPlan(json: boolean): Promise<number> {
  const connection = connect();
  if (!connection) return (console.error("headroom does not run. Start it with: headroom service install"), 1);
  const status = await connection.call<DaemonStatus>(["resources", "status"], {});
  if (status.reboot === undefined) return (console.error("The daemon is older than the reboot budget (H34). Run headroom service restart."), 1);
  if (json) console.log(JSON.stringify(status.reboot, null, 2));
  else for (const line of rebootLines(status.reboot)) console.log(line);
  return 0;
}

/** This function writes a time for a person: the local clock, and the day when it is not today. */
function whenText(at: number, now: number = Date.now()): string {
  const day = new Date(at).toDateString() === new Date(now).toDateString() ? "" : ` on ${new Date(at).toDateString().slice(0, 10)}`;
  return `${localClock(at)}${day}`;
}

/**
 * `headroom drain --at <HH:MM|now> [--until <HH:MM>]` plans a drain for a reboot, and `--cancel` cancels it (H34). With no
 * option, it shows the drain. headroom does not reboot the computer.
 */
async function drainCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { at: { type: "string" }, until: { type: "string" }, cancel: { type: "boolean" }, json: { type: "boolean" } },
  });
  const usage = "Usage: headroom drain --at <HH:MM|now> [--until <HH:MM>], headroom drain --cancel, or headroom drain";
  if (positionals.length > 0 || (values.cancel === true && (values.at !== undefined || values.until !== undefined)) || (values.until !== undefined && values.at === undefined)) {
    console.error(usage);
    return 2;
  }
  const connection = connect();
  if (!connection) return (console.error("headroom does not run. Start it with: headroom service install"), 1);
  const now = Date.now();
  let input: { at?: number; until?: number | null; cancel?: boolean } = {};
  try {
    if (values.cancel === true) input = { cancel: true };
    else if (values.at !== undefined) {
      const at = values.at.trim().toLowerCase() === "now" ? now : nextClock(values.at, now);
      input = { at, until: values.until === undefined ? null : nextClock(values.until, at) };
    }
  } catch (error) {
    console.error(`headroom: ${error instanceof Error ? error.message : String(error)}. ${usage}`);
    return 2;
  }
  const drain = await connection.call<DrainStatus | null>(["resources", "drain"], input);
  if (values.json === true) {
    console.log(JSON.stringify(drain, null, 2));
    return 0;
  }
  if (values.cancel === true) {
    if (drain === null) console.log("No drain was planned.");
    else if (drain.auto) {
      const under = mb(drain.auto.levelMb - AUTO_DRAIN_MARGIN_MB);
      console.log(`The automatic drain of ${whenText(drain.at, now)} is cancelled. The waiting jobs start when they fit.`);
      console.log(`The automatic rule starts no new drain until the kernel pools fall under ${under}, or until a reboot.`);
    } else console.log(`The drain for the reboot at ${whenText(drain.at, now)} is cancelled. The waiting jobs start when they fit.`);
    return 0;
  }
  if (drain === null) {
    console.log("No drain is planned. headroom drain --at 02:30 plans one.");
    return 0;
  }
  if (input.at !== undefined) {
    const until = drain.until === null ? "" : ` If no reboot comes, it ends at ${whenText(drain.until, now)}.`;
    console.log(`The drain for the reboot starts at ${whenText(drain.at, now)}: new jobs wait, and the running jobs finish.${until}`);
    console.log("An alert tells when no job runs. The daemon writes the resume plan at the start. headroom does not reboot the computer.");
  }
  console.log(drainLine(drain) ?? "");
  return 0;
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
    case "forecast": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      return showForecasts(values.json === true);
    }
    case "thermal": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      return showThermal(values.json === true);
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
    case "gpu":
      return gpuCommand(rest, connect());
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
    case "reboot-plan": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      return rebootPlan(values.json === true);
    }
    case "drain":
      return drainCommand(rest);
    case "presence":
      return showPresence(rest);
    default:
      console.log(HELP);
      return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`headroom: ${isNetworkError(error) ? "the daemon does not answer" : error instanceof Error ? error.message : String(error)}`);
  return 1;
});
