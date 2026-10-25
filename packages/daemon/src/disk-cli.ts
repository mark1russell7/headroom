/**
 * The command `headroom disk` (H21).
 *
 * - `headroom disk report [--drive C:] [--deep] [--json]` sizes the known places of each drive, and saves the report.
 * - `headroom disk clean [--apply] [--json]` removes only the data that is disposable by definition. Without `--apply`, it is a dry run.
 *
 * The command runs in its own process. The daemon only tells the temp root and the state of the leases.
 */

import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { isActive, type Config, type JobPhase, type JobState } from "@headroom/core";
import type { Connection } from "./client.ts";
import { cleanLines, listProcesses, pnpmStorePrune, runClean, type DaemonView } from "./disk-clean.ts";
import {
  driveLetters,
  gitRootOf,
  jobTempGroups,
  knownPlaces,
  parseWslImages,
  pnpmStorePath,
  readDrives,
  readReport,
  realOf,
  reportLines,
  runProgram,
  runReport,
  saveReport,
  userTemp,
  type DaemonFacts,
  type DiskReport,
} from "./disk-report.ts";
import { diskCleanLogPath, diskReportPath } from "./paths.ts";
import type { DaemonStatus } from "./procedures.ts";

export const DISK_USAGE = "headroom disk report [--drive C:] [--deep] [--json] | headroom disk clean [--apply] [--json]";

/** The outputs of the command. The tests replace them. */
export interface DiskOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const CONSOLE: DiskOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };

/** The age of a report that the cleanup uses for the list for Mark: 24 hours. */
const REPORT_MAX_AGE_MS = 24 * 3_600_000;

/** This function gives the view of the daemon for the report and the cleanup. Each error of a call counts as no answer. */
export function daemonView(connection: Connection | null): DaemonView {
  return {
    async facts(): Promise<DaemonFacts | null> {
      if (connection === null) return null;
      try {
        const [status, config] = await Promise.all([connection.call<DaemonStatus>(["resources", "status"], {}), connection.call<Config>(["config", "get"], {})]);
        return { tempRoot: config.jobTemp, live: new Set(status.leases.filter(isActive).map((lease) => lease.id)) };
      } catch {
        return null;
      }
    },
    async phase(id: string): Promise<JobPhase | null | undefined> {
      if (connection === null) return undefined;
      try {
        const jobs = await connection.call<JobState[]>(["resources", "job"], { query: id });
        return jobs.find((job) => job.id === id)?.state ?? null;
      } catch {
        return undefined;
      }
    },
  };
}

/** This function gives the drive of `--drive`: `D:` for `d`, `D` or `D:`. It gives `undefined` for a value that names no drive. */
export function parseDrive(value: string | undefined): string | null | undefined {
  if (value === undefined) return null;
  const letter = value.charAt(0).toUpperCase();
  const rest = value.slice(1);
  if (letter < "A" || letter > "Z" || (rest !== "" && rest !== ":" && rest !== ":\\")) return undefined;
  return `${letter}:`;
}

/** This function makes a disk report of this computer, and saves it. It gives the report and the path of the saved file. */
export async function makeReport(mode: "quick" | "deep", drive: string | null, connection: Connection | null): Promise<{ report: DiskReport; saved: string | null }> {
  const platform = process.platform;
  const home = homedir();
  const env = process.env;
  const facts = await daemonView(connection).facts();
  const drives = readDrives(platform === "win32" ? driveLetters() : ["/", home], platform);
  const store = await pnpmStorePath();
  const wsl = platform === "win32" ? parseWslImages((await runProgram("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss", "/s"])) ?? "") : [];
  const places = knownPlaces({ platform, env, home, drives, daemon: facts, pnpmStore: store, wslImages: wsl });
  const system = (env["SystemDrive"] ?? "C:").toUpperCase();
  const deepRoots = [home, ...(platform === "win32" ? drives.filter((each) => each.mount.toUpperCase() !== system).map((each) => `${each.mount}\\`) : [])];
  const groups = facts?.tempRoot ? jobTempGroups(facts.tempRoot, facts.live) : null;
  const notes = [
    ...(facts === null ? ["The daemon does not answer, so the report has no temp folders of the jobs."] : []),
    ...(facts !== null && groups === null ? ["No temp root of the jobs is set (headroom config job-temp)."] : []),
    ...(groups === null
      ? []
      : [`Temp root of the jobs ${facts?.tempRoot ?? ""}: folders of live jobs ${groups.live.length}, of jobs that are not live ${groups.ended.length}, kept ${groups.kept.length}, other entries ${groups.other.length}.`]),
    ...(store === null ? ["`pnpm store path` gave no answer, so the report has no pnpm store."] : []),
  ];
  const report = await runReport({ mode, drive, places, drives, deepRoots, notes });
  const path = diskReportPath();
  try {
    await saveReport(path, report);
    return { report, saved: path };
  } catch {
    return { report, saved: null };
  }
}

/** This function gives the output of `headroom disk report`, and its exit code. */
async function reportCommand(argv: readonly string[], connection: Connection | null, output: DiskOutput): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { drive: { type: "string" }, deep: { type: "boolean" }, json: { type: "boolean" } } });
  const drive = parseDrive(values.drive);
  if (drive === undefined) {
    output.err(`headroom disk report --drive needs a drive letter, for example C: or D:, not ${values.drive ?? ""}.`);
    return 2;
  }
  const { report, saved } = await makeReport(values.deep === true ? "deep" : "quick", drive, connection);
  if (values.json === true) output.out(JSON.stringify(report, null, 2));
  else for (const line of reportLines(report, saved)) output.out(line);
  return 0;
}

/** This function gives the output of `headroom disk clean`, and its exit code. */
async function cleanCommand(argv: readonly string[], connection: Connection | null, output: DiskOutput): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { apply: { type: "boolean" }, json: { type: "boolean" } } });
  const platform = process.platform;
  const home = homedir();
  let report = readReport(diskReportPath());
  if (report === null || report.drive !== null || Date.now() - Date.parse(report.at) > REPORT_MAX_AGE_MS) {
    output.err("No disk report of all the drives from the last 24 hours. The cleanup makes a quick report first.");
    report = (await makeReport("quick", null, connection)).report;
  }
  const gitRoot = gitRootOf(home);
  const fenced = gitRoot === null ? [] : [...new Set([gitRoot, await realOf(gitRoot)])];
  const plan = await runClean({
    apply: values.apply === true,
    view: daemonView(connection),
    userTemp: userTemp(process.env, home, platform),
    fenced,
    store: await pnpmStorePath(),
    processes: () => listProcesses(platform),
    prune: pnpmStorePrune,
    report,
    log: diskCleanLogPath(),
  });
  if (values.json === true) output.out(JSON.stringify(plan, null, 2));
  else for (const line of cleanLines(plan)) output.out(line);
  return 0;
}

/** This function gives the output of `headroom disk report|clean`, and its exit code. */
export async function diskCommand(argv: readonly string[], connection: Connection | null, output: DiskOutput = CONSOLE): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "report") return reportCommand(rest, connection, output);
  if (action === "clean") return cleanCommand(rest, connection, output);
  output.err(`Usage: ${DISK_USAGE}`);
  return 2;
}
