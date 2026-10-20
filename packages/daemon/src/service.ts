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
import { processIsAlive, type Status } from "@headroom/core";
import { answers, connect } from "./client.ts";
import { killTree } from "./gateway.ts";
import { headroomHome, logPath, readDiscovery, writePlannedStop } from "./paths.ts";

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

/** This function quotes one argument for a Windows command line. */
export function windowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
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
}

/**
 * This function restarts the daemon through its service, for example to load a new version. It marks the stop
 * as planned, so the next daemon does not report it as a stop by another process. It gives the exit code.
 */
export async function restart(options: RestartOptions = {}): Promise<number> {
  const deadline = Date.now() + (options.waitMs ?? 3_600_000);
  while (!options.now) {
    const connection = connect();
    if (!connection) break;
    const waiting = (await connection.call<Status>(["resources", "status"], {})).leases.filter((lease) => lease.state === "waiting").length;
    if (waiting === 0) break;
    if (Date.now() > deadline) {
      console.error(`headroom: ${waiting} leases still wait. No restart. Use --now to restart anyway.`);
      return 75;
    }
    console.log(`${waiting} leases wait. The restart waits for them. Next check in 30 s.`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  const old = readDiscovery();
  if (process.platform === "linux") {
    // systemd stops the daemon with a signal, so the daemon stops cleanly and the stop is not reported.
    const code = exec("systemctl", ["--user", "restart", `${SERVICE_NAME}.service`]).code;
    if (code !== 0) return code;
  } else if (process.platform === "win32") {
    if (old && processIsAlive(old.pid)) {
      writePlannedStop(old.pid);
      killTree(old.pid);
    }
    const code = exec("schtasks", ["/Run", "/TN", SERVICE_NAME], true).code;
    if (code !== 0) return (console.error(`The task "${SERVICE_NAME}" did not start. Register it with: headroom service install`), code);
  } else {
    return unsupported();
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const running = readDiscovery();
    if (running && running.pid !== old?.pid && (await answers(running))) {
      console.log(`headroom restarted: process ${running.pid}.`);
      return 0;
    }
  }
  console.error("headroom did not answer 60 s after the restart. Look at the log: headroom service status");
  return 1;
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
  return live ? 0 : 1;
}
