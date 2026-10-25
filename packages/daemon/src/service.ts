/**
 * The service: the daemon starts at login, and starts again when it stops.
 *
 * - On Windows, a scheduled task of the user starts `headroom serve` at logon. The task starts it again
 *   every 2 minutes when it stops. `conhost --headless` keeps the console window hidden.
 * - On Linux, a systemd user unit starts it, and starts it again after a failure.
 *
 * A service manager starts the daemon outside the process tree of a Claude Code session, so the
 * low-memory guard of a session cannot stop it.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { processIsAlive, startOutsideJob, waitsForRoom, type Status } from "@headroom/core";
import { answers, connect, connectTo, isNetworkError } from "./client.ts";
import { killTree } from "./gateway.ts";
import { headroomHome, logPath, readDiscovery, takePlannedStop, writePlannedStop } from "./paths.ts";
import type { DaemonStatus } from "./procedures.ts";
import type { IdleRestartState, PendingRestart } from "./restart.ts";

/**
 * The title of the daemon process. The command line of the daemon contains it. Thus a search can find
 * the daemon by its title, not by `cli.ts`.
 */
export const DAEMON_TITLE = "headroom-daemon";

/** The name of the scheduled task and of the systemd unit. */
export const SERVICE_NAME = "headroom";

/** The command that the service starts. */
export interface ServiceCommand {
  readonly node: string;
  /** The options of Node before the script, for example the title that marks the process. */
  readonly nodeOptions: readonly string[];
  readonly cli: string;
  readonly args: readonly string[];
}

/** This function gives the command of the service: this Node and this CLI, with the arguments of `serve`. */
export function serviceCommand(serveArgs: readonly string[] = []): ServiceCommand {
  return { node: process.execPath, nodeOptions: [`--title=${DAEMON_TITLE}`], cli: join(import.meta.dirname, "cli.ts"), args: ["serve", "--background", "--log", logPath(), ...serveArgs] };
}

/**
 * This function quotes one argument for a Windows command line. Backslashes before a quote and at the end are doubled.
 * One pass over the characters keeps the time linear, also for a long run of backslashes.
 */
export function windowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let quoted = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    quoted += char === '"' ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${char}`;
    slashes = 0;
  }
  return `${quoted}${"\\".repeat(slashes * 2)}"`;
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * This function gives the definition of the scheduled task for a user, for example `HOST\name`. One trigger
 * starts the task at logon. A second trigger starts it every few minutes from the time of the install. When the
 * daemon runs, the task ignores the second start.
 */
export function windowsTaskXml(command: ServiceCommand, user: string, everyMinutes: number = 2, from: Date = new Date()): string {
  const conhost = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "conhost.exe");
  const args = ["--headless", command.node, ...command.nodeOptions, command.cli, ...command.args].map(windowsArg).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>headroom: the memory and job broker of this computer. https://github.com/mark1russell7/headroom</Description>
    <URI>\\${SERVICE_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(user)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>${from.toISOString().slice(0, 19)}Z</StartBoundary>
      <Repetition>
        <Interval>PT${everyMinutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(conhost)}</Command>
      <Arguments>${xml(args)}</Arguments>
      <WorkingDirectory>${xml(headroomHome())}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** This function quotes one argument for the `ExecStart` line of a systemd unit. */
export function systemdArg(arg: string): string {
  const escaped = arg.replace(/%/g, "%%");
  return /[\s"'\\]/.test(escaped) || escaped === "" ? `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : escaped;
}

/** This function gives the systemd user unit. */
export function systemdUnit(command: ServiceCommand): string {
  const exec = [command.node, ...command.nodeOptions, command.cli, ...command.args].map(systemdArg).join(" ");
  return `[Unit]
Description=headroom: the memory and job broker of this computer
Documentation=https://github.com/mark1russell7/headroom

[Service]
ExecStart=${exec}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

function unitPath(): string {
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "systemd", "user", `${SERVICE_NAME}.service`);
}

function windowsUser(): string {
  const domain = process.env["USERDOMAIN"];
  const name = userInfo().username;
  return domain ? `${domain}\\${name}` : name;
}

/** This function starts a program, prints what it writes, and gives its exit code. */
function exec(file: string, args: readonly string[], quiet: boolean = false): { code: number; out: string } {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) return { code: 127, out: result.error.message };
  if (!quiet && out) console.log(out);
  return { code: result.status ?? 1, out };
}

function unsupported(): number {
  console.error(`headroom service supports Windows and Linux, not ${process.platform}.`);
  return 1;
}

/** This function registers the service and starts it. It gives the exit code. */
export function install(serveArgs: readonly string[] = []): number {
  const command = serviceCommand(serveArgs);
  mkdirSync(headroomHome(), { recursive: true });
  if (process.platform === "win32") {
    const file = join(headroomHome(), "service.xml");
    // Task Scheduler reads the definition as UTF-16 with a byte order mark.
    writeFileSync(file, Buffer.from(`\ufeff${windowsTaskXml(command, windowsUser())}`, "utf16le"));
    const created = exec("schtasks", ["/Create", "/TN", SERVICE_NAME, "/XML", file, "/F"]);
    if (created.code !== 0) return created.code;
    const started = exec("schtasks", ["/Run", "/TN", SERVICE_NAME]);
    if (started.code === 0) console.log(`The task "${SERVICE_NAME}" starts headroom at logon. The log is ${logPath()}.`);
    return started.code;
  }
  if (process.platform === "linux") {
    mkdirSync(dirname(unitPath()), { recursive: true });
    writeFileSync(unitPath(), systemdUnit(command));
    const reloaded = exec("systemctl", ["--user", "daemon-reload"]);
    if (reloaded.code !== 0) return reloaded.code;
    const enabled = exec("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`]);
    if (enabled.code === 0) console.log(`The unit ${unitPath()} starts headroom at login. Its log: journalctl --user -u ${SERVICE_NAME}`);
    return enabled.code;
  }
  return unsupported();
}

/** The options of `restart()`. */
export interface RestartOptions {
  /** True: restart at once. False (the default): wait until no lease waits, because an old client can lose its wait. */
  readonly now?: boolean | undefined;
  /** The longest wait for the queue, in ms. The default is 60 minutes. */
  readonly waitMs?: number | undefined;
  /**
   * The process ID of a daemon that stops by itself, for the helper of `--when-idle`. The restart waits until this
   * process exits, and does not stop its process tree, because the helper is in that tree.
   */
  readonly after?: number | undefined;
  /** This function prints the lines of the restart. The default is the console. */
  readonly log?: ((line: string) => void) | undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** This function waits until a process exits. It gives false when the process is still alive at the end of the time. */
async function exited(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
  return true;
}

/**
 * This function restarts the daemon through its service, for example to load a new version. It marks the stop
 * as planned, so the next daemon does not report it as a stop by another process. It gives the exit code.
 */
export async function restart(options: RestartOptions = {}): Promise<number> {
  const say = options.log ?? ((line: string) => console.log(line));
  const fail = options.log ?? ((line: string) => console.error(line));
  const deadline = Date.now() + (options.waitMs ?? 3_600_000);
  while (!options.now && options.after === undefined) {
    const connection = connect();
    if (!connection) break;
    // H31: a lease that waits for a condition does not hold the restart. The new daemon keeps it.
    const waiting = (await connection.call<Status>(["resources", "status"], {})).leases.filter(waitsForRoom).length;
    if (waiting === 0) break;
    if (Date.now() > deadline) {
      fail(`headroom: ${waiting} leases still wait. No restart. Use --now to restart anyway, or --when-idle.`);
      return 75;
    }
    say(`${waiting} leases wait. The restart waits for them. Next check in 30 s. With --when-idle, the daemon does the wait.`);
    await sleep(30_000);
  }
  let oldPid = readDiscovery()?.pid ?? null;
  if (options.after !== undefined) {
    oldPid = options.after;
    if (!(await exited(options.after, 30_000))) {
      fail(`The daemon (process ${options.after}) did not stop in 30 s. The restart stops it.`);
      try {
        process.kill(options.after);
      } catch {
        // The process stopped before the kill.
      }
    }
  }
  if (process.platform === "linux") {
    // systemd stops the daemon with a signal, so the daemon stops cleanly and the stop is not reported.
    const code = exec("systemctl", ["--user", "restart", `${SERVICE_NAME}.service`]).code;
    if (code !== 0) return code;
  } else if (process.platform === "win32") {
    if (options.after === undefined && oldPid !== null && processIsAlive(oldPid)) {
      writePlannedStop(oldPid);
      killTree(oldPid);
    }
    const code = exec("schtasks", ["/Run", "/TN", SERVICE_NAME], true).code;
    if (code !== 0) return (fail(`The task "${SERVICE_NAME}" did not start. Register it with: headroom service install`), code);
  } else {
    return unsupported();
  }
  for (let attempt = 1; attempt <= 60; attempt++) {
    await sleep(1000);
    const running = readDiscovery();
    if (running && running.pid !== oldPid && (await answers(running))) {
      say(`headroom restarted: process ${running.pid}.`);
      return 0;
    }
    // The task ignores a start while its old instance still ends (IgnoreNew). Thus the restart starts the task again.
    if (process.platform === "win32" && attempt % 10 === 0) exec("schtasks", ["/Run", "/TN", SERVICE_NAME], true);
  }
  fail("headroom did not answer 60 s after the restart. Look at the log: headroom service status");
  return 1;
}

/** The title of the helper process of `--when-idle`. It is not the title of the daemon, so a search for the daemon does not find the helper. */
export const RESTART_TITLE = "headroom-restart";

/** This function gives the command line of the helper that restarts the task after the daemon `pid` stops. */
export function helperCommandLine(pid: number, command: ServiceCommand = serviceCommand()): string {
  const args = [command.node, `--title=${RESTART_TITLE}`, command.cli, "service", "restart", "--after", String(pid), "--log", logPath()];
  return args.map(windowsArg).join(" ");
}

/**
 * This function starts the restart of the daemon from the daemon itself, at the first tick when no lease waits. It
 * gives true when the daemon must stop itself after the call.
 *
 * The choice of the mechanism on Windows:
 *
 * - The task has the `MultipleInstancesPolicy` `IgnoreNew`. Thus `schtasks /Run` has no effect while the old daemon runs.
 * - Task Scheduler puts the processes of the task in a job object. A process in that job can keep the task active, or
 *   stop with the task.
 * - Option a: the daemon stops, and the repeat trigger of the task starts it again. The gap is up to 2 minutes.
 * - Option b, the choice: the daemon starts a helper outside the job, with `CREATE_BREAKAWAY_FROM_JOB`. Then the daemon
 *   stops cleanly. The helper waits for the exit of the daemon and starts the task. The gap is approximately 3 seconds.
 * - Option a stays as the fallback. When the helper does not start the task, the repeat trigger starts the daemon.
 * - The daemon writes the mark of a planned stop first. Thus no `stop` alert starts, and `headroom run` waits for the
 *   new daemon.
 *
 * On Linux, `systemctl --no-block restart` gives the restart to systemd. systemd stops the daemon with a signal.
 */
export async function restartFromDaemon(pid: number, log: (line: string) => void): Promise<boolean> {
  if (process.platform === "linux") {
    writePlannedStop(pid);
    const result = exec("systemctl", ["--user", "--no-block", "restart", `${SERVICE_NAME}.service`], true);
    if (result.code === 0) return false;
    takePlannedStop();
    throw new Error(`systemctl did not restart the unit: ${result.out}`);
  }
  if (process.platform !== "win32") throw new Error(`headroom service supports Windows and Linux, not ${process.platform}`);
  writePlannedStop(pid);
  try {
    const helper = await startOutsideJob(helperCommandLine(pid), headroomHome());
    const job = helper.jobFlags === null ? "The daemon is in no job." : `The job of the daemon has the limit flags 0x${helper.jobFlags.toString(16)}.`;
    const where = helper.breakaway ? "outside the job of the task" : "in the job of the task, because the job refused a breakaway";
    log(`The helper (process ${helper.pid}) runs ${where}. It starts the task after this daemon stops. ${job}`);
  } catch (error) {
    log(`The helper did not start: ${error instanceof Error ? error.message : String(error)}. The task starts the daemon in 2 minutes or less.`);
  }
  return true;
}

/** The options of `restartWhenIdle()`. */
export interface RestartWhenIdleOptions {
  /** True: cancel the restart that waits. */
  readonly cancel?: boolean | undefined;
}

/** This function writes the line of a restart that waits for an idle queue. */
export function pendingLine(pending: PendingRestart): string {
  return `A restart waits for an idle queue (asked at ${new Date(pending.askedAt).toISOString().slice(11, 16)} UTC).`;
}

/**
 * This function asks the daemon to restart itself at the first tick when no lease waits. It does not wait. Without a
 * daemon, it starts the normal restart. It gives the exit code.
 */
export async function restartWhenIdle(options: RestartWhenIdleOptions = {}): Promise<number> {
  const cancel = options.cancel === true;
  const connection = connect();
  if (!connection) {
    if (cancel) return (console.log("headroom does not run, so no restart waits."), 0);
    console.log("headroom does not run, so the normal restart starts.");
    return restart({ now: true });
  }
  let state: IdleRestartState;
  try {
    state = await connection.call<IdleRestartState>(["service", "restartWhenIdle"], { cancel });
  } catch (error) {
    if (isNetworkError(error)) {
      if (cancel) return (console.log("The daemon does not answer, so no restart waits."), 0);
      console.log("The daemon does not answer, so the normal restart starts.");
      return restart({ now: true });
    }
    console.error(`headroom: the daemon refused the request (${error instanceof Error ? error.message : String(error)}).`);
    console.error("An older daemon has no --when-idle. Use: headroom service restart");
    return 1;
  }
  if (cancel) console.log(state.restarting ? "The restart started already." : "No restart waits for an idle queue.");
  else if (state.restarting) console.log("headroom restarts.");
  else console.log(`headroom restarts when no lease waits (now: ${state.waiting} waiting).`);
  return 0;
}

/**
 * This function stops the daemon and keeps it stopped until `start()`, for example while its folder moves.
 * On Windows it disables the task, so the trigger of every 2 minutes does not start the daemon again.
 */
export function stop(): number {
  if (process.platform === "linux") return exec("systemctl", ["--user", "stop", `${SERVICE_NAME}.service`]).code;
  if (process.platform !== "win32") return unsupported();
  const disabled = exec("schtasks", ["/Change", "/TN", SERVICE_NAME, "/DISABLE"], true).code;
  if (disabled !== 0) return (console.error(`The task "${SERVICE_NAME}" is not registered.`), disabled);
  const running = readDiscovery();
  if (running && processIsAlive(running.pid)) {
    writePlannedStop(running.pid);
    killTree(running.pid);
  }
  console.log(`headroom stopped. The task "${SERVICE_NAME}" is disabled until: headroom service start`);
  return 0;
}

/** This function enables the service again and starts the daemon. It gives the exit code. */
export function start(): number {
  if (process.platform === "linux") return exec("systemctl", ["--user", "start", `${SERVICE_NAME}.service`]).code;
  if (process.platform !== "win32") return unsupported();
  const enabled = exec("schtasks", ["/Change", "/TN", SERVICE_NAME, "/ENABLE"], true).code;
  if (enabled !== 0) return (console.error(`The task "${SERVICE_NAME}" is not registered. Register it with: headroom service install`), enabled);
  return exec("schtasks", ["/Run", "/TN", SERVICE_NAME]).code;
}

/** This function stops the daemon and removes the service. It gives the exit code. */
export function uninstall(): number {
  let code: number;
  if (process.platform === "win32") {
    exec("schtasks", ["/End", "/TN", SERVICE_NAME], true);
    code = exec("schtasks", ["/Delete", "/TN", SERVICE_NAME, "/F"]).code;
  } else if (process.platform === "linux") {
    code = exec("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.service`]).code;
    rmSync(unitPath(), { force: true });
    exec("systemctl", ["--user", "daemon-reload"], true);
  } else {
    return unsupported();
  }
  // The end of the task can leave the Node process of the daemon. This stops it.
  const running = readDiscovery();
  if (running && processIsAlive(running.pid)) {
    try {
      process.kill(running.pid);
      console.log(`The daemon (process ${running.pid}) stopped.`);
    } catch {
      // The process stopped before the kill.
    }
  }
  return code;
}

/** This function prints the state of the service and tells if the daemon answers. */
export async function status(): Promise<number> {
  if (process.platform === "win32") {
    const query = exec("schtasks", ["/Query", "/TN", SERVICE_NAME, "/V", "/FO", "LIST"], true);
    if (query.code !== 0) console.log(`The task "${SERVICE_NAME}" is not registered. Register it with: headroom service install`);
    else {
      const keys = /^(Status|Last Run Time|Last Result|Next Run Time|Task To Run):/;
      // The list has one record for each trigger, so the same line can come twice.
      const lines = [...new Set(query.out.split(/\r?\n/).filter((line) => keys.test(line)))];
      console.log((lines.length > 0 ? lines : query.out.split(/\r?\n/)).join("\n"));
    }
  } else if (process.platform === "linux") {
    exec("systemctl", ["--user", "status", `${SERVICE_NAME}.service`, "--no-pager"]);
  } else {
    return unsupported();
  }
  const running = readDiscovery();
  const live = running !== null && (await answers(running));
  console.log(live && running ? `The daemon answers at ${running.endpoint} (process ${running.pid}).` : "The daemon does not answer.");
  if (live && running) {
    const pending = (await connectTo(running).call<DaemonStatus>(["resources", "status"], {}).catch(() => null))?.restart;
    if (pending) console.log(pendingLine(pending));
  }
  return live ? 0 : 1;
}
