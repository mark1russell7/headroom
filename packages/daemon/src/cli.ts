#!/usr/bin/env node
/**
 * The `headroom` command.
 *
 * - `headroom serve`: run the daemon.
 * - `headroom service install`: start the daemon at login, and again when it stops.
 * - `headroom status`: show the memory, the free amounts, the leases and the owners.
 * - `headroom run --mem 2g -- pnpm test`: run a job under a lease.
 * - `headroom mcp list | add | remove | restart | warm | config`: the servers of the MCP gateway.
 * - `headroom dashboard`: open the dashboard of the daemon in the browser.
 * - `headroom alerts [--watch]`: a runaway process, an orphan, low memory, the commit charge, the kernel pool and low free space on a drive.
 * - `headroom config [job-temp <folder>]`: show or change the settings.
 * - `headroom history`, `headroom pool <name> <capacity>`, `headroom release <id>`, `headroom resume-plan`.
 */

import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createJob,
  createSampler,
  diskLevel,
  diskSize,
  kindOf,
  MB,
  readSessions,
  type Alert,
  type Alerts,
  type Config,
  type History,
  type Job,
  type JobUsage,
  type Lease,
  type PoolTags,
  type Status,
  type Suggestion,
} from "@headroom/core";
import { connect, isNetworkError, isRestartError, type Connection } from "./client.ts";
import { DEFAULT_PORT, fileLog, serve } from "./daemon.ts";
import { driversOf } from "./drivers.ts";
import { mcpCommand } from "./gateway-cli.ts";
import { sessionFromEnv } from "./holder.ts";
import { diskAmounts, finishTemp, jobEnv, prepareTemp } from "./job.ts";
import { parseDisk, parseMemory, parseTime } from "./parse.ts";
import { autoSlots, BROWSER_SLOT } from "./slots.ts";
import * as service from "./service.ts";

const HELP = `headroom: the memory and job broker of this computer

  headroom serve [--port ${DEFAULT_PORT}] [--reserve 1024] [--background] [--log file]
  headroom service install [--port ${DEFAULT_PORT}] [--reserve 1024]
  headroom service restart [--now] [--wait 60m] | stop | start | uninstall | status
  headroom mcp list | add | remove | restart | warm | config   (the MCP gateway)
  headroom mcp warm [name...] [--timeout 120s]   (start the MCP servers before the sessions)
  headroom status [--json]
  headroom run [--mem 2g|auto] [--cpu 2] [--disk 5g|D:=5g]... [--slot docker]... [--holder name] [--job name]
               [--priority 0] [--wait 30m] [--limit] [--keep] [--keep-temp] [--force-disk] -- <command> [args...]
               --limit: the job cannot use more memory than --mem. --keep: no job object.
               --disk 5g: space on the drive of the current folder. --disk D:=5g: on the drive D:.
               With a temp root (headroom config job-temp), the job gets its own TEMP folder,
               and the run removes it at the end. --keep-temp: keep the folder.
               A browser test (playwright test, e2e) takes the slot browser. --no-auto-slot: not.
               A drive with less than 5 GB free stops the start (exit 75). --force-disk: start anyway.
  headroom config [job-temp <folder> | job-temp --clear]   (show or change the settings)
  headroom dashboard                         (open the dashboard in the browser)
  headroom alerts [--watch] [--json]
  headroom pool-tags [--drivers] [--json]   (the kernel pool by tag, Windows)
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

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

/** This function writes an amount in the unit of its kind: MB or GB for the memory and the drives, else a count. */
function amountText(name: string, amount: number): string {
  const kind = kindOf(name);
  return kind === "memory" ? mb(Math.max(0, amount)) : kind === "disk" ? diskSize(Math.max(0, amount)) : String(amount);
}

function printStatus(status: Status): void {
  const { memory } = status;
  for (const alert of status.alerts ?? []) console.log(`ALERT since ${clock(alert.since)} UTC: ${alert.message}`);
  if ((status.alerts ?? []).length > 0) console.log("");
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

function quote(arg: string): string {
  return process.platform === "win32" && /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** This function runs a command, and gives its exit code. `env` adds variables to the environment of the command. */
function runCommand(command: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<number> {
  return new Promise((resolve) => {
    const [file, ...args] = command;
    if (!file) return resolve(2);
    const options = { stdio: "inherit" as const, env: jobEnv(env) };
    // On Windows, pnpm and npm are .cmd files, which only a shell starts. The shell gets one quoted command line.
    const child =
      process.platform === "win32"
        ? spawn([file, ...args].map(quote).join(" "), { ...options, shell: true })
        : spawn(file, args, options);
    child.on("error", (error) => {
      console.error(`headroom: the command did not start: ${error.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
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
}

/**
 * This function runs a command in a job object (H6, Windows). When this process exits, Windows stops each process of the
 * job that still runs, so no process of the job stays as an orphan. With --limit, the job cannot commit more memory than
 * its lease. The function prints the peak memory of the job, so the holder can size the next lease.
 */
async function runEnforced(
  command: readonly string[],
  enforcement: Enforcement,
  env: Readonly<Record<string, string>> = {},
): Promise<{ code: number; peakMb: number | null }> {
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
  const code = await runCommand(command, env);
  if (!held) return { code, peakMb: null };
  const peakMb = Math.max(0, held.peakMb() - base);
  const of = enforcement.leaseMb === null ? "" : ` of its lease of ${mb(enforcement.leaseMb)}`;
  console.error(`headroom: the job used at most ${mb(peakMb)}${of}.`);
  if (held.limitMb !== null && held.peakMb() >= held.limitMb * 0.97) {
    console.error(`headroom: the job reached its memory limit. Ask for a larger lease, for example --mem ${Math.ceil((enforcement.leaseMb ?? 0) * 1.5 / 1024)}g.`);
  }
  return { code, peakMb };
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
    },
  });
  if (positionals.length === 0) {
    console.error("headroom run needs a command after --. Example: headroom run --mem 2g -- pnpm test");
    return 2;
  }
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

  const connection = connect();
  if (!connection) {
    console.error("headroom: the daemon does not run, so the job runs without a lease.");
    return (await runEnforced(positionals, { keep, limit: false, leaseMb: null })).code;
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
  const enforcement: Enforcement = { keep, limit: values.limit === true, leaseMb: amounts["memory"] ?? null };
  let first: Lease;
  try {
    first = await connection.call<Lease>(["resources", "lease"], {
      holder,
      job,
      amounts,
      pid: process.pid,
      ...(values.priority ? { priority: Number(values.priority) } : {}),
    });
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    console.error("headroom: the daemon does not answer, so the job runs without a lease.");
    return (await runEnforced(positionals, enforcement)).code;
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
  let result: { code: number; peakMb: number | null } = { code: 1, peakMb: null };
  let tempMb: number | null = null;
  try {
    result = await runEnforced(positionals, enforcement, temp?.env ?? {});
  } finally {
    if (temp !== null) tempMb = finishTemp(temp, values["keep-temp"] === true);
  }
  const { code, peakMb } = result;
  const peak = peakMb === null ? "" : `, peak ${mb(peakMb)}`;
  const usage: JobUsage = { ...(peakMb === null ? {} : { peakMb }), ...(tempMb === null ? {} : { tempMb }) };
  try {
    await (connect() ?? latest).call(["resources", "release"], {
      id: lease.id,
      reason: `the job ended with code ${code}${peak}`,
      ...(peakMb === null ? {} : { peakMb }),
      ...(Object.keys(usage).length === 0 ? {} : { usage }),
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

/** This function prints the settings. */
function printConfig(config: Config): void {
  console.log(`job-temp: ${config.jobTemp ?? "(none: each job of headroom run uses the TEMP of its parent)"}`);
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
  if (name !== "job-temp" || (value === undefined) === (values.clear !== true) || positionals.length > 2) {
    console.error("Usage: headroom config, headroom config job-temp <folder>, or headroom config job-temp --clear");
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
        const { values } = parseArgs({ args, options: { now: { type: "boolean" }, wait: { type: "string" } } });
        return service.restart({ now: values.now === true, waitMs: values.wait ? parseTime(values.wait) : undefined });
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
      const status = await connection.call<Status>(["resources", "status"], {});
      if (values.json) console.log(JSON.stringify(status, null, 2));
      else printStatus(status);
      return 0;
    }
    case "run":
      return run(rest);
    case "pool-tags": {
      const { values } = parseArgs({ args: rest, options: { drivers: { type: "boolean" }, json: { type: "boolean" } } });
      return showPoolTags(values.drivers === true, values.json === true);
    }
    case "dashboard": {
      const endpoint = connect()?.endpoint;
      if (!endpoint) return (console.error("headroom does not run. Start it with: headroom service install"), 1);
      const url = `${new URL(endpoint).origin}/`;
      console.log(`The dashboard: ${url}`);
      const [open, ...args] = process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
      spawn(open as string, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => undefined).unref();
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
    case "config":
      return configCommand(rest);
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
