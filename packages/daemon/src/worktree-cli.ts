/**
 * The command `headroom worktree` (H175): the life of the git worktrees of the agent sessions.
 *
 * - `headroom worktree list` gives the state of each worktree, with counts for each state and each repository.
 * - `headroom worktree clean` removes the trees whose work is on a remote, and the `node_modules` folders of the idle trees.
 * - `headroom worktree remove <path>` removes one tree when its work is on a remote. A session starts it after its merge.
 *
 * The command runs in its own process. The daemon starts `headroom worktree clean` each day, and when a drive is low.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  cleanWorktrees,
  diskSize,
  findMains,
  freedLine,
  freeSpace,
  isInside,
  nodeRunner,
  removeWorktree,
  samePath,
  scanWorktrees,
  summarize,
  WORKTREE_STATES,
  type CleanResult,
  type WorktreeRunner,
  type WorktreeScan,
  type WorktreeSummary,
} from "@headroom/core";
import { gitRootOf } from "./disk-report.ts";
import { walk } from "./disk-walk.ts";
import { parseTime } from "./parse.ts";
import { headroomHome, worktreeLogPath, worktreeSummaryPath } from "./paths.ts";

export const WORKTREE_USAGE =
  "headroom worktree list [--root <folder>]... [--idle 24h] [--sizes] [--json] | clean [--dry-run] [--idle 24h] [--root <folder>]... [--json] | remove <path> [--root <folder>]...";

/** The outputs of the command. The tests replace them. */
export interface WorktreeOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const CONSOLE: WorktreeOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };

/** The time limit of the size of one folder: 2 minutes. A folder that takes longer gets a lower limit. */
const MEASURE_MS = 120_000;

/** The record of the last cleanup in `~/.headroom/worktrees.json`. The daemon reads it for its schedule and its alert. */
export interface WorktreeRecord extends WorktreeSummary {
  readonly clean: {
    readonly at: string;
    readonly removed: number;
    readonly nodeModules: number;
    readonly pruned: number;
    readonly failed: number;
    readonly freeBefore: Readonly<Record<string, number>>;
    readonly freeAfter: Readonly<Record<string, number>>;
  };
}

/** This function gives the default root: the real folder of `~/git`, or no root. */
export function defaultRoots(home: string = homedir()): string[] {
  const link = gitRootOf(home);
  if (link === null) return [];
  try {
    return [realpathSync(link)];
  } catch {
    return [link];
  }
}

/** This function gives the real path of a folder, or the absolute path when the folder does not exist. */
function realOrAbsolute(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** This function gives the runner of this computer. It sizes a folder with the walk of the disk report. */
export function systemRunner(): WorktreeRunner {
  return nodeRunner({
    measure: async (path) => {
      const result = await walk(path, { deadline: Date.now() + MEASURE_MS });
      return { bytes: result.bytes, newestMs: result.newestMs };
    },
  });
}

/** This function reads the record of the last cleanup, or gives `null`. */
export function readWorktreeRecord(path: string = worktreeSummaryPath()): WorktreeRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as WorktreeRecord;
    return typeof record.clean?.at === "string" ? record : null;
  } catch {
    return null;
  }
}

/** This function gives a time as UTC text, for example `2026-11-08 10:40 UTC`. */
function timeText(ms: number | null): string {
  return ms === null || ms <= 0 ? "unknown" : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** This function gives the lines of `headroom worktree list`. */
export function listLines(scan: WorktreeScan, summary: WorktreeSummary = summarize(scan)): string[] {
  const total = scan.trees.length + scan.orphans.length;
  const counts = WORKTREE_STATES.map((state) => `${state} ${summary.counts[state]}`).join(", ");
  const lines = [`Worktrees under ${scan.roots.join(", ") || "no root"}: ${total} (${counts}).`];
  if (summary.repos.length > 0) {
    const width = Math.max(10, ...summary.repos.map((row) => row.repo.length));
    const sized = summary.repos.some((row) => row.nodeModulesBytes !== null);
    lines.push(`${"repository".padEnd(width)}  ${WORKTREE_STATES.map((state) => state.padStart(9)).join(" ")}${sized ? "  node_modules" : ""}`);
    for (const row of summary.repos) {
      const size = sized ? `  ${row.nodeModulesBytes === null ? "" : diskSize(row.nodeModulesBytes / (1024 * 1024)).padStart(12)}` : "";
      lines.push(`${row.repo.padEnd(width)}  ${WORKTREE_STATES.map((state) => String(row.counts[state]).padStart(9)).join(" ")}${size}`);
    }
  }
  if (scan.orphans.length > 0) {
    lines.push("Orphans: folders that git does not know. headroom does not delete them. Their owners decide.");
    for (const orphan of scan.orphans) {
      const size = orphan.bytes === null ? "" : ` ${diskSize(orphan.bytes / (1024 * 1024))},`;
      lines.push(`  ${orphan.path}:${size} last change ${timeText(orphan.newestMs)}. ${orphan.reason}.`);
    }
  }
  for (const error of scan.errors) lines.push(`git worktree list failed: ${error}`);
  lines.push("The states: active (a change in the idle time), removable (all on a remote), keep (changes or commits that are not on a remote), broken (git can prune it).");
  return lines;
}

/** This function gives the lines of `headroom worktree clean`. */
export function cleanLines(result: CleanResult, scan: WorktreeScan): string[] {
  const count = (action: string, ok: boolean): number => result.actions.filter((each) => each.action === action && each.ok === ok).length;
  const removed = count("remove", true);
  const modules = count("node_modules", true);
  const pruned = count("prune", true);
  const lines = [
    result.dryRun
      ? `A dry run. The cleanup removes ${removed} worktrees, deletes node_modules in ${modules} idle trees that it keeps, and prunes ${pruned} main checkouts.`
      : `Removed ${removed} worktrees, deleted node_modules in ${modules} idle trees that it kept, and pruned ${pruned} main checkouts.`,
  ];
  const active = scan.trees.filter((tree) => tree.state === "active").length;
  lines.push(`No action on ${active} active trees and ${scan.orphans.length} orphans.`);
  for (const action of result.actions) {
    if (action.action === "skip" || !action.ok) lines.push(`  ${action.ok ? "skipped" : "failed"}: ${action.path}: ${action.detail}`);
  }
  for (const orphan of scan.orphans) lines.push(`  orphan, kept: ${orphan.path} (last change ${timeText(orphan.newestMs)})`);
  lines.push(`Free space: ${freedLine(result)}`);
  return lines;
}

/** This function writes the record and one log line for each action. A file that cannot be written does not stop the cleanup. */
function record(scan: WorktreeScan, result: CleanResult): void {
  const summary = summarize(scan);
  const count = (action: string): number => result.actions.filter((each) => each.action === action && each.ok).length;
  const entry: WorktreeRecord = {
    ...summary,
    clean: {
      at: new Date().toISOString(),
      removed: count("remove"),
      nodeModules: count("node_modules"),
      pruned: count("prune"),
      failed: result.actions.filter((each) => !each.ok).length,
      freeBefore: result.freeBefore,
      freeAfter: result.freeAfter,
    },
  };
  try {
    mkdirSync(headroomHome(), { recursive: true });
    writeFileSync(worktreeSummaryPath(), `${JSON.stringify(entry, null, 2)}\n`);
    const at = entry.clean.at;
    const lines = result.actions.map((action) => `${at} ${action.action} ${action.ok ? "ok" : "failed"} ${action.path} ${action.detail}\n`);
    appendFileSync(worktreeLogPath(), lines.join(""));
  } catch {
    // The record is for the daemon and the reader. The cleanup is done.
  }
}

/** The options of `list` and `clean`. */
interface ScanArgs {
  readonly roots: string[];
  readonly idleMs: number;
}

/** This function reads `--root` and `--idle`, or gives the message of an error. */
function scanArgs(values: { root?: string[] | undefined; idle?: string | undefined }): ScanArgs | string {
  const roots = (values.root ?? []).length > 0 ? (values.root ?? []).map(realOrAbsolute) : defaultRoots();
  if (roots.length === 0) return "No root. Give a folder of repositories with --root.";
  const missing = roots.filter((root) => !existsSync(root));
  if (missing.length > 0) return `The root ${missing.join(", ")} does not exist.`;
  try {
    return { roots, idleMs: values.idle === undefined ? 24 * 3_600_000 : parseTime(values.idle) };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const SCAN_OPTIONS = { root: { type: "string", multiple: true }, idle: { type: "string" }, json: { type: "boolean" } } as const;

/** This function gives the output of `headroom worktree list`, and its exit code. */
async function listCommand(argv: readonly string[], runner: WorktreeRunner, output: WorktreeOutput): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { ...SCAN_OPTIONS, sizes: { type: "boolean" } } });
  const args = scanArgs(values);
  if (typeof args === "string") return (output.err(`headroom worktree list: ${args}`), 2);
  const scan = await scanWorktrees({ roots: args.roots, runner, idleMs: args.idleMs, sizes: values.sizes === true });
  if (values.json === true) output.out(JSON.stringify({ summary: summarize(scan), ...scan }, null, 2));
  else for (const line of listLines(scan)) output.out(line);
  return 0;
}

/** This function gives the output of `headroom worktree clean`, and its exit code. */
async function cleanCommand(argv: readonly string[], runner: WorktreeRunner, output: WorktreeOutput): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { ...SCAN_OPTIONS, "dry-run": { type: "boolean" } } });
  const args = scanArgs(values);
  if (typeof args === "string") return (output.err(`headroom worktree clean: ${args}`), 2);
  const dryRun = values["dry-run"] === true;
  const scan = await scanWorktrees({ roots: args.roots, runner, idleMs: args.idleMs });
  const result = await cleanWorktrees(scan, { runner, dryRun });
  if (!dryRun) record(scan, result);
  if (values.json === true) output.out(JSON.stringify({ summary: summarize(scan), ...result, orphans: scan.orphans }, null, 2));
  else for (const line of cleanLines(result, scan)) output.out(line);
  return result.actions.some((action) => !action.ok) ? 1 : 0;
}

/** This function gives the main checkout of a worktree from `git rev-parse --git-common-dir`, or `null`. */
async function mainOf(path: string, runner: WorktreeRunner): Promise<string | null> {
  const result = await runner.git(["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const common = result.stdout.trim();
  return result.code === 0 && common !== "" ? dirname(common) : null;
}

/** This function gives the output of `headroom worktree remove <path>`, and its exit code: 0 when the tree is gone, else 1. */
async function removeCommand(argv: readonly string[], runner: WorktreeRunner, output: WorktreeOutput, cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...argv], options: { root: SCAN_OPTIONS.root }, allowPositionals: true });
  const [given] = positionals;
  if (given === undefined || positionals.length > 1) return (output.err(`Usage: ${WORKTREE_USAGE}`), 2);
  const args = scanArgs(values);
  if (typeof args === "string") return (output.err(`headroom worktree remove: ${args}`), 2);
  const path = realOrAbsolute(given);
  const here = realOrAbsolute(cwd);
  if (samePath(here, path) || isInside(path, here)) {
    output.err(`headroom worktree remove: the current folder is in ${path}. Windows cannot delete a folder in use. Start the command from a different folder.`);
    return 1;
  }
  const main = existsSync(path) ? await mainOf(path, runner) : null;
  if (main === null) {
    output.err(`headroom worktree remove: ${path} is not a git worktree. Nothing changed.`);
    return 1;
  }
  const before = freeSpace(args.roots, runner);
  const mains = [...findMains(args.roots, runner), main];
  const result = await removeWorktree(path, { roots: args.roots, mains, runner, main });
  if (result.refused !== null) {
    output.err(`headroom worktree remove: refused. ${result.refused} Nothing changed.`);
    return 1;
  }
  for (const step of result.steps) output.out(step);
  output.out(`Free space: ${freedLine({ dryRun: false, freeBefore: before, freeAfter: freeSpace(args.roots, runner) })}`);
  if (!result.ok) output.err(`headroom worktree remove: ${path} is not removed. Read the steps above.`);
  return result.ok ? 0 : 1;
}

/** This function gives the output of `headroom worktree list|clean|remove`, and its exit code. */
export async function worktreeCommand(argv: readonly string[], output: WorktreeOutput = CONSOLE, runner: WorktreeRunner = systemRunner(), cwd: string = process.cwd()): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "list") return listCommand(rest, runner, output);
  if (action === "clean") return cleanCommand(rest, runner, output);
  if (action === "remove") return removeCommand(rest, runner, output, cwd);
  output.err(`Usage: ${WORKTREE_USAGE}`);
  return 2;
}
