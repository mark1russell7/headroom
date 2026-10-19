#!/usr/bin/env node
/**
 * The `headroom` command.
 *
 * - `headroom serve`: run the daemon.
 * - `headroom status`: show the memory, the free amounts, the leases and the owners.
 * - `headroom run --mem 2g -- pnpm test`: run a job under a lease.
 * - `headroom history`, `headroom pool <name> <capacity>`, `headroom release <id>`, `headroom resume-plan`.
 */

import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { createSampler, readSessions, type History, type Lease, type Status } from "@headroom/core";
import { connect, type Connection } from "./client.ts";
import { DEFAULT_PORT, serve } from "./daemon.ts";
import { parseMemory, parseTime } from "./parse.ts";

const HELP = `headroom: the memory and job broker of this computer

  headroom serve [--port ${DEFAULT_PORT}] [--reserve 1024] [--background]
  headroom status [--json]
  headroom run [--mem 2g] [--cpu 2] [--slot docker]... [--holder name] [--job name]
               [--priority 0] [--wait 30m] -- <command> [args...]
  headroom history [--minutes 60] [--json]
  headroom pool <name> <capacity>
  headroom release <id>
  headroom resume-plan
`;

/** This function finds the Claude Code session that started this process, by its process tree. */
async function holderOf(): Promise<string> {
  const fromEnv = process.env["HEADROOM_HOLDER"];
  if (fromEnv) return fromEnv;
  try {
    const sampler = await createSampler();
    const byPid = new Map(sampler.processes().map((info) => [info.pid, info]));
    const sessions = new Map(readSessions().map((session) => [session.pid, session.name]));
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

function printStatus(status: Status): void {
  const { memory } = status;
  console.log(`Memory: ${mb(memory.availableMb)} available of ${mb(memory.totalMb)}. Committed ${mb(memory.commitMb)} of ${mb(memory.commitLimitMb)}.`);
  console.log(`Kernel pools: ${mb(memory.kernelNonpagedMb)} non-paged, ${mb(memory.kernelPagedMb)} paged.`);
  const free = Object.entries(status.free).map(([name, amount]) => `${name} ${name === "memory" ? mb(Math.max(0, amount)) : amount}`);
  console.log(`Free for a new lease: ${free.join(", ")} (reserve ${mb(status.reserveMb)}).`);
  console.log(status.leases.length === 0 ? "\nNo active leases." : "\nActive leases:");
  for (const lease of status.leases) {
    const amounts = Object.entries(lease.amounts).map(([name, amount]) => `${name} ${name === "memory" ? mb(amount) : amount}`).join(", ");
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

/** This function runs a command, and gives its exit code. */
function runCommand(command: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const [file, ...args] = command;
    if (!file) return resolve(2);
    // On Windows, pnpm and npm are .cmd files, which only a shell starts. The shell gets one quoted command line.
    const child =
      process.platform === "win32"
        ? spawn([file, ...args].map(quote).join(" "), { stdio: "inherit", shell: true })
        : spawn(file, args, { stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`headroom: the command did not start: ${error.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function waitForGrant(connection: Connection, lease: Lease, deadline: number): Promise<Lease> {
  let current = lease;
  let said = "";
  while (current.state === "waiting" && Date.now() < deadline) {
    if (current.reason && current.reason !== said) {
      console.error(`headroom: ${current.job} ${current.reason}`);
      said = current.reason;
    }
    current = await connection.call<Lease>(["resources", "wait"], { id: current.id, timeoutMs: Math.max(1000, Math.min(60_000, deadline - Date.now())) });
  }
  return current;
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
    },
  });
  if (positionals.length === 0) {
    console.error("headroom run needs a command after --. Example: headroom run --mem 2g -- pnpm test");
    return 2;
  }
  const amounts: Record<string, number> = {};
  if (values.mem) amounts["memory"] = parseMemory(values.mem);
  if (values.cpu) amounts["cpu"] = Number(values.cpu);
  for (const slot of values.slot ?? []) amounts[slot] = (amounts[slot] ?? 0) + 1;
  const job = values.job ?? positionals.join(" ").slice(0, 500);

  const connection = connect();
  if (!connection) {
    console.error("headroom: the daemon does not run, so the job runs without a lease.");
    return runCommand(positionals);
  }
  const holder = values.holder ?? (await holderOf());
  const first = await connection.call<Lease>(["resources", "lease"], {
    holder,
    job,
    amounts,
    pid: process.pid,
    ...(values.priority ? { priority: Number(values.priority) } : {}),
  });
  const lease = await waitForGrant(connection, first, Date.now() + parseTime(values.wait ?? "30m"));
  if (lease.state === "waiting") {
    await connection.call(["resources", "release"], { id: lease.id, reason: "the wait ended" });
    console.error(`headroom: ${job} waited too long (${lease.reason ?? "no room"}). Nothing ran.`);
    return 75;
  }
  if (lease.state !== "granted") {
    console.error(`headroom: the lease ended before the job started: ${lease.reason ?? lease.state}`);
    return 75;
  }
  const code = await runCommand(positionals);
  try {
    await connection.call(["resources", "release"], { id: lease.id, reason: `the job ended with code ${code}` });
  } catch {
    // The daemon ends the lease anyway when this process exits.
  }
  return code;
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
      const { values } = parseArgs({ args: rest, options: { port: { type: "string" }, reserve: { type: "string" }, background: { type: "boolean" } } });
      return serve({
        port: values.port ? Number(values.port) : undefined,
        reserveMb: values.reserve ? parseMemory(values.reserve) : undefined,
        mode: values.background ? "background" : "foreground",
      });
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
    case "resume-plan":
      resumePlan();
      return 0;
    default:
      console.log(HELP);
      return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
