/**
 * The life of the git worktrees of the agent sessions (H175).
 *
 * Each session makes a worktree for each task, with its own `node_modules`. On 2026-11-08, 654 worktrees filled a drive of
 * 195 GB. `git worktree remove` failed on Windows, because the paths in `node_modules/.pnpm` are longer than 260
 * characters. `fs.rmSync` deletes these paths with no error.
 *
 * - The scan finds each main checkout directly under each root, and asks git for its worktrees.
 * - Each linked worktree gets a state: `active`, `removable`, `keep` or `broken`.
 * - A folder next to a main checkout that git does not know, and that holds files, is an `orphan`. Nothing deletes it.
 * - The cleanup removes only what is on a remote or what a tool can make again.
 *
 * The rules of safety:
 *
 * - No step removes a main checkout, or a folder that holds one.
 * - No step acts on a path outside the roots.
 * - No step uses `--force` with `git worktree remove`. Thus git refuses a tree with changes.
 * - No step deletes an orphan.
 */

import { execFile } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Alert } from "./alerts.ts";
import { diskSize } from "./units.ts";

/** The state of a worktree. */
export type WorktreeState = "active" | "removable" | "keep" | "broken";

/** The states of the counts. An `orphan` is a folder that git does not know. */
export type WorktreeCountState = WorktreeState | "orphan";

/** The order of the states in the tables. */
export const WORKTREE_STATES: readonly WorktreeCountState[] = ["active", "removable", "keep", "broken", "orphan"];

/** The time with no change after which a worktree is idle: 24 hours. */
export const WORKTREE_IDLE_MS: number = 24 * 3_600_000;

/** The count of `keep` trees above which the daemon gives an alert. */
export const WORKTREE_KEEP_ALERT = 100;

/** The free space of a drive under which the daemon starts the cleanup early: 20 GB. */
export const WORKTREE_LOW_FREE_MB: number = 20 * 1024;

/** The result of one git command. A code of -1 tells that git did not start. */
export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The kind of a file system entry. A `link` is a symbolic link, a junction or another reparse point. */
export type EntryKind = "dir" | "file" | "link";

/** One entry of a folder. */
export interface FolderEntry {
  readonly name: string;
  readonly kind: EntryKind;
}

/** The data of one path, without a link that it follows. */
export interface PathStat {
  readonly kind: EntryKind;
  readonly mtimeMs: number;
}

/** The size of a folder and the newest time of change in it. */
export interface FolderMeasure {
  readonly bytes: number;
  readonly newestMs: number;
}

/** The access to git and to the file system. The tests replace it with a fixture. */
export interface WorktreeRunner {
  /** This function runs git with an argument array and no shell. */
  git(args: readonly string[]): Promise<GitResult>;
  /** This function gives the entries of a folder, or `null` when it cannot read the folder. */
  entries(path: string): readonly FolderEntry[] | null;
  /** This function gives the data of a path, or `null` when the path does not exist. */
  stat(path: string): PathStat | null;
  /** This function gives the text of a file, or `null`. */
  readText(path: string): string | null;
  /** This function deletes a folder and its contents, also with long paths. It does not follow a link. */
  remove(path: string): void;
  /** This function gives the free space of the drive of a path, in MB, or `null`. */
  freeMb(path: string): number | null;
  /** This function sizes a folder. Without it, the scan gives no sizes. */
  measure?: ((path: string) => Promise<FolderMeasure>) | undefined;
}

/** One entry of `git worktree list --porcelain`. */
export interface PorcelainEntry {
  readonly path: string;
  readonly head: string | null;
  /** The branch without `refs/heads/`, or `null` for a detached HEAD. */
  readonly branch: string | null;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

/** One linked worktree, with its state. */
export interface Worktree {
  readonly path: string;
  /** The main checkout of the worktree. */
  readonly main: string;
  /** The folder name of the main checkout. */
  readonly repo: string;
  readonly branch: string | null;
  readonly state: WorktreeState;
  /** The reasons of the state `keep` or `broken`. */
  readonly reasons: readonly string[];
  /** True when git status gives changes. `null` when git status failed. */
  readonly dirty: boolean | null;
  /** The count of commits that are on no remote. `null` when git failed. */
  readonly unpushed: number | null;
  /** The newest time of change, in ms since the epoch, or `null`. */
  readonly changedAt: number | null;
  readonly locked: boolean;
  /** False when the worktree is outside each root. The cleanup does not touch it. */
  readonly inRoots: boolean;
  /** The size of the `node_modules` folders, with `sizes`. */
  readonly nodeModulesBytes: number | null;
}

/** A folder next to a main checkout that git does not know as a worktree. Only its owner decides about it. */
export interface Orphan {
  readonly path: string;
  readonly repo: string;
  readonly reason: string;
  /** The size of the folder, or `null` with no measure. */
  readonly bytes: number | null;
  /** The newest time of change of a file outside `node_modules`, or `null`. */
  readonly newestMs: number | null;
}

/** The result of a scan. */
export interface WorktreeScan {
  readonly at: number;
  readonly roots: readonly string[];
  readonly mains: readonly string[];
  readonly trees: readonly Worktree[];
  readonly orphans: readonly Orphan[];
  /** The main checkouts where `git worktree list` failed, with the message of git. */
  readonly errors: readonly string[];
}

/** The options of a scan. */
export interface ScanOptions {
  readonly roots: readonly string[];
  readonly runner: WorktreeRunner;
  /** The time with no change after which a tree is idle. The default is 24 hours. */
  readonly idleMs?: number | undefined;
  /** True to size the `node_modules` folders. */
  readonly sizes?: boolean | undefined;
  readonly now?: number | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

/** This function gives a key of a path for a compare: forward slashes, no slash at the end, and lower case on Windows. */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const slashes = trimEndSlashes(path.replace(/\\/g, "/"));
  return platform === "win32" ? slashes.toLowerCase() : slashes;
}

/** This function tells if two paths are the same folder. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** This function tells if `path` is inside `root`, and is not `root` itself. */
export function isInside(root: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(path, platform).startsWith(`${pathKey(root, platform)}/`);
}

/**
 * This function removes the slashes and backslashes at the end of a path. It is a loop, not the expression `/[\\/]+$/`:
 * that expression takes a time of the square of the length on a path with many slashes that are not at the end.
 */
export function trimEndSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && (path[end - 1] === "/" || path[end - 1] === "\\")) end -= 1;
  return path.slice(0, end);
}

/** This function gives the last part of a path. */
function baseName(path: string): string {
  return trimEndSlashes(path).split(/[\\/]/).pop() ?? path;
}

/** This function reads the output of `git worktree list --porcelain`. The first entry is the main checkout. */
export function parsePorcelain(text: string): PorcelainEntry[] {
  const list: PorcelainEntry[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").filter((line) => line !== "");
    const first = lines[0];
    if (first === undefined || !first.startsWith("worktree ")) continue;
    const value = (word: string): string | undefined => lines.find((line) => line === word || line.startsWith(`${word} `))?.slice(word.length + 1);
    const branch = value("branch");
    list.push({
      path: first.slice("worktree ".length),
      head: value("HEAD") ?? null,
      branch: branch === undefined ? null : branch.replace(/^refs\/heads\//, ""),
      bare: lines.includes("bare"),
      locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
    });
  }
  return list;
}

/** The input of `classifyWorktree`. */
export interface ClassifyInput {
  readonly exists: boolean;
  readonly prunable: boolean;
  readonly locked: boolean;
  readonly dirty: boolean | null;
  readonly unpushed: number | null;
  readonly changedAt: number | null;
  readonly now: number;
  readonly idleMs: number;
}

/**
 * This function gives the state of a worktree and its reasons. A fact that git could not read counts against the
 * removal: the tree is then `keep`. A tree with no time of change is `active`.
 */
export function classifyWorktree(input: ClassifyInput): { state: WorktreeState; reasons: string[] } {
  if (input.prunable) return { state: "broken", reasons: ["git marks it prunable"] };
  if (!input.exists) return { state: "broken", reasons: ["the folder does not exist"] };
  const reasons: string[] = [];
  if (input.dirty === null) reasons.push("git status failed");
  else if (input.dirty) reasons.push("changes that are not committed");
  if (input.unpushed === null) reasons.push("the count of commits that are not on a remote failed");
  else if (input.unpushed > 0) reasons.push(`${input.unpushed} ${input.unpushed === 1 ? "commit that is" : "commits that are"} not on a remote`);
  if (input.locked) reasons.push("locked");
  if (input.changedAt === null || input.now - input.changedAt < input.idleMs) return { state: "active", reasons };
  return { state: reasons.length > 0 ? "keep" : "removable", reasons };
}

/** The facts that the rules of safety use. */
export interface SafetyContext {
  readonly roots: readonly string[];
  /** The main checkouts that the scan found. */
  readonly mains: readonly string[];
  readonly runner: WorktreeRunner;
  readonly platform?: NodeJS.Platform | undefined;
}

/**
 * This function gives the reason to refuse an action on a path, or `null`. It refuses a path outside the roots and a root.
 * It also refuses a main checkout, a folder that holds one, and a folder with a `.git` folder.
 */
export function refusal(path: string, context: SafetyContext): string | null {
  const platform = context.platform ?? process.platform;
  if (!isAbsolute(path) && !/^[a-z]:[\\/]/i.test(path)) return `${path} is not an absolute path.`;
  if (!context.roots.some((root) => isInside(root, path, platform))) return `${path} is outside the roots (${context.roots.join(", ")}).`;
  if (context.mains.some((main) => samePath(main, path, platform) || isInside(path, main, platform))) return `${path} is a main checkout, or it holds one.`;
  if (context.runner.stat(join(path, ".git"))?.kind === "dir") return `${path} has a .git folder, so it is a main checkout.`;
  return null;
}

/** This function finds the main checkouts directly under the roots: the folders with a `.git` folder. It skips the links. */
export function findMains(roots: readonly string[], runner: WorktreeRunner, platform: NodeJS.Platform = process.platform): string[] {
  const seen = new Map<string, string>();
  for (const root of roots) {
    for (const entry of runner.entries(root) ?? []) {
      if (entry.kind !== "dir") continue;
      const path = join(root, entry.name);
      if (runner.stat(join(path, ".git"))?.kind === "dir" && !seen.has(pathKey(path, platform))) seen.set(pathKey(path, platform), path);
    }
  }
  return [...seen.values()];
}

/** This function gives the git folder of a linked worktree, from its `.git` file, or `null`. */
export function gitDirOf(path: string, runner: WorktreeRunner): string | null {
  const text = runner.readText(join(path, ".git"));
  const match = text === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match?.[1]) return null;
  return isAbsolute(match[1]) || /^[a-z]:[\\/]/i.test(match[1]) ? match[1] : resolve(path, match[1]);
}

/** This function gives the newest time of change of the top entries of a worktree, other than `node_modules`, and of its git `HEAD` and `index`. */
export function newestChange(path: string, runner: WorktreeRunner): number | null {
  let newest: number | null = null;
  const take = (file: string): void => {
    const stat = runner.stat(file);
    if (stat !== null && (newest === null || stat.mtimeMs > newest)) newest = stat.mtimeMs;
  };
  for (const entry of runner.entries(path) ?? []) if (entry.name !== "node_modules") take(join(path, entry.name));
  const gitDir = gitDirOf(path, runner);
  if (gitDir !== null) for (const name of ["HEAD", "index"]) take(join(gitDir, name));
  return newest;
}

/**
 * This function finds each `node_modules` folder in a tree. The walk stops at each `node_modules` folder and at `.git`.
 * It does not follow a symbolic link or a junction.
 */
export function findNodeModules(path: string, runner: WorktreeRunner): string[] {
  const found: string[] = [];
  const stack = [path];
  while (stack.length > 0) {
    const folder = stack.pop() as string;
    for (const entry of runner.entries(folder) ?? []) {
      if (entry.kind !== "dir" || entry.name === ".git") continue;
      const child = join(folder, entry.name);
      if (entry.name === "node_modules") found.push(child);
      else stack.push(child);
    }
  }
  return found.sort();
}

/** This function tells if a folder holds a file outside `node_modules` and `.git`, and gives the newest time of change of those files. */
function sourceFiles(path: string, runner: WorktreeRunner): { files: number; newestMs: number | null } {
  let files = 0;
  let newestMs: number | null = null;
  const stack = [path];
  while (stack.length > 0) {
    const folder = stack.pop() as string;
    for (const entry of runner.entries(folder) ?? []) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.kind === "link") continue;
      const child = join(folder, entry.name);
      if (entry.kind === "dir") {
        stack.push(child);
        continue;
      }
      files += 1;
      const stat = runner.stat(child);
      if (stat !== null && (newestMs === null || stat.mtimeMs > newestMs)) newestMs = stat.mtimeMs;
    }
  }
  return { files, newestMs };
}

/** This function gives the result of a function for each item. At most `parallel` items wait at the same time. It keeps the order. */
async function eachLimited<T, R>(items: readonly T[], parallel: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));
  return results;
}

/** This function gives the count of commits of `HEAD` that are on no remote, or `null` when git failed. */
async function unpushedOf(path: string, runner: WorktreeRunner): Promise<number | null> {
  const result = await runner.git(["-C", path, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
  const count = Number(result.stdout.trim());
  return result.code === 0 && Number.isInteger(count) ? count : null;
}

/** This function tells if git status gives changes. `node_modules` and the other ignored files do not count. It gives `null` when git failed. */
async function dirtyOf(path: string, runner: WorktreeRunner): Promise<boolean | null> {
  // `--no-optional-locks`: git status does not write the index, so the scan does not change the idle time.
  const result = await runner.git(["--no-optional-locks", "-C", path, "status", "--porcelain", "--untracked-files=normal"]);
  return result.code === 0 ? result.stdout.trim() !== "" : null;
}

/** This function sums the sizes of the `node_modules` folders of a tree. */
async function nodeModulesBytes(path: string, runner: WorktreeRunner): Promise<number | null> {
  if (runner.measure === undefined) return null;
  let bytes = 0;
  for (const folder of findNodeModules(path, runner)) bytes += (await runner.measure(folder)).bytes;
  return bytes;
}

/**
 * This function gives the possible orphans of one main checkout. These are the folders `<repo>-*` next to it.
 * For a folder `<repo>-*wt`, they are its children.
 */
function orphanCandidates(main: string, runner: WorktreeRunner): string[] {
  const parent = dirname(main);
  const repo = baseName(main).toLowerCase();
  const list: string[] = [];
  for (const entry of runner.entries(parent) ?? []) {
    if (entry.kind !== "dir" || !entry.name.toLowerCase().startsWith(`${repo}-`)) continue;
    const path = join(parent, entry.name);
    if (/-wt$/i.test(entry.name)) {
      for (const child of runner.entries(path) ?? []) if (child.kind === "dir") list.push(join(path, child.name));
    } else list.push(path);
  }
  return list;
}

/**
 * This function finds the worktrees under the roots, and gives the state of each. It also finds the orphans. It reads
 * only: it changes no file.
 */
export async function scanWorktrees(options: ScanOptions): Promise<WorktreeScan> {
  const { roots, runner } = options;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now();
  const idleMs = options.idleMs ?? WORKTREE_IDLE_MS;
  const mains = findMains(roots, runner, platform);
  const errors: string[] = [];
  const entries: { entry: PorcelainEntry; main: string }[] = [];
  const known = new Set<string>();
  for (const main of mains) {
    known.add(pathKey(main, platform));
    const result = await runner.git(["-C", main, "worktree", "list", "--porcelain"]);
    if (result.code !== 0) {
      errors.push(`${main}: ${result.stderr.trim() || `git worktree list ended with code ${result.code}`}`);
      continue;
    }
    for (const entry of parsePorcelain(result.stdout).slice(1)) {
      const key = pathKey(entry.path, platform);
      if (entry.bare || known.has(key)) continue;
      known.add(key);
      entries.push({ entry, main });
    }
  }
  const trees = await eachLimited(entries, 4, async ({ entry, main }): Promise<Worktree> => {
    const path = entry.path;
    const exists = runner.stat(path)?.kind === "dir";
    const live = exists && !entry.prunable;
    const changedAt = live ? newestChange(path, runner) : null;
    const [dirty, unpushed] = live ? await Promise.all([dirtyOf(path, runner), unpushedOf(path, runner)]) : [null, null];
    const { state, reasons } = classifyWorktree({ exists, prunable: entry.prunable, locked: entry.locked, dirty, unpushed, changedAt, now, idleMs });
    return {
      path,
      main,
      repo: baseName(main),
      branch: entry.branch,
      state,
      reasons,
      dirty,
      unpushed,
      changedAt,
      locked: entry.locked,
      inRoots: roots.some((root) => isInside(root, path, platform)),
      nodeModulesBytes: live && options.sizes === true ? await nodeModulesBytes(path, runner) : null,
    };
  });
  const orphans: Orphan[] = [];
  for (const main of mains) {
    for (const path of orphanCandidates(main, runner)) {
      const key = pathKey(path, platform);
      if (known.has(key)) continue;
      known.add(key);
      const dotGit = runner.stat(join(path, ".git"));
      if (dotGit?.kind === "dir") continue;
      const source = sourceFiles(path, runner);
      if (source.files === 0) continue;
      const reason = dotGit === null ? "No .git, and git lists no worktree here" : "A .git file, but git lists no worktree here";
      const measured = runner.measure === undefined ? null : await runner.measure(path);
      orphans.push({ path, repo: baseName(main), reason, bytes: measured?.bytes ?? null, newestMs: source.newestMs });
    }
  }
  return { at: now, roots, mains, trees, orphans, errors };
}

/** The result of the removal of one worktree. */
export interface RemoveResult {
  readonly path: string;
  /** True when the folder is gone and git does not list it. In a dry run, true when the removal can start. */
  readonly ok: boolean;
  /** The reason of a refusal. The removal then changed nothing. */
  readonly refused: string | null;
  /** The steps, in their order, as text. */
  readonly steps: readonly string[];
  /** The `node_modules` folders that the removal deleted. */
  readonly nodeModules: readonly string[];
}

/** The options of a removal. */
export interface RemoveOptions extends SafetyContext {
  /** The main checkout of the worktree. */
  readonly main: string;
  readonly dryRun?: boolean | undefined;
}

/** This function gives the paths of a list that git ignores in a tree, with one `git check-ignore` for each 100 paths. */
async function ignoredOf(tree: string, paths: readonly string[], runner: WorktreeRunner, platform: NodeJS.Platform): Promise<Set<string>> {
  const ignored = new Set<string>();
  const relative = paths.map((path) => pathKey(path, "linux").slice(pathKey(tree, "linux").length + 1));
  for (let at = 0; at < relative.length; at += 100) {
    const result = await runner.git(["-C", tree, "check-ignore", "--", ...relative.slice(at, at + 100)]);
    if (result.code !== 0) continue;
    for (const line of result.stdout.replace(/\r/g, "").split("\n")) if (line.trim() !== "") ignored.add(pathKey(join(tree, line.trim()), platform));
  }
  return ignored;
}

/**
 * This function deletes each `node_modules` folder of a tree that git ignores. A tool can make these folders again. It
 * gives the deleted folders. It refuses by the rules of safety.
 */
export async function removeNodeModules(tree: string, context: SafetyContext): Promise<{ refused: string | null; removed: string[]; failed: string[] }> {
  const platform = context.platform ?? process.platform;
  const refused = refusal(tree, context);
  if (refused !== null) return { refused, removed: [], failed: [] };
  const folders = findNodeModules(tree, context.runner);
  if (folders.length === 0) return { refused: null, removed: [], failed: [] };
  const ignored = await ignoredOf(tree, folders, context.runner, platform);
  const removed: string[] = [];
  const failed: string[] = [];
  for (const folder of folders) {
    if (!ignored.has(pathKey(folder, platform))) continue;
    try {
      context.runner.remove(folder);
      removed.push(folder);
    } catch (error) {
      failed.push(`${folder}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { refused: null, removed, failed };
}

/** This function gives the entry of a path in `git worktree list` of a main checkout. It gives `undefined` for no entry, and `null` when git failed. */
async function listedEntry(main: string, path: string, context: SafetyContext): Promise<{ entry: PorcelainEntry | undefined; first: boolean } | null> {
  const platform = context.platform ?? process.platform;
  const result = await context.runner.git(["-C", main, "worktree", "list", "--porcelain"]);
  if (result.code !== 0) return null;
  const entries = parsePorcelain(result.stdout);
  const index = entries.findIndex((entry) => samePath(entry.path, path, platform));
  return { entry: index < 0 ? undefined : entries[index], first: index === 0 };
}

/**
 * This function removes one linked worktree whose work is all on a remote. The steps:
 *
 * 1. It refuses by the rules of safety, and it refuses a path that git does not list as a linked worktree of `main`.
 * 2. It refuses a locked tree, a tree with changes and a tree with commits that are on no remote.
 * 3. It deletes each `node_modules` folder that git ignores, with `fs.rmSync`.
 * 4. It starts `git worktree remove` with no `--force`.
 * 5. When git fails and still lists the tree, the removal stops. When git does not list it, the removal deletes the folder.
 *
 * Step 5 is safe, because steps 1 and 2 examined the tree before the removal started. The local branch stays.
 */
export async function removeWorktree(path: string, options: RemoveOptions): Promise<RemoveResult> {
  const runner = options.runner;
  const steps: string[] = [];
  const refuse = (reason: string): RemoveResult => ({ path, ok: false, refused: reason, steps, nodeModules: [] });
  const unsafe = refusal(path, options);
  if (unsafe !== null) return refuse(unsafe);
  const listed = await listedEntry(options.main, path, options);
  if (listed === null) return refuse(`git worktree list failed in ${options.main}.`);
  if (listed.entry === undefined) return refuse(`git does not list ${path} as a worktree of ${options.main}.`);
  if (listed.first) return refuse(`${path} is the main checkout of ${options.main}.`);
  if (listed.entry.locked) return refuse(`${path} is locked. Its owner unlocks it with git worktree unlock.`);
  if (listed.entry.prunable || runner.stat(path)?.kind !== "dir") return refuse(`${path} is broken. headroom worktree clean prunes it.`);
  const dirty = await dirtyOf(path, runner);
  if (dirty === null) return refuse(`git status failed in ${path}.`);
  if (dirty) return refuse(`${path} has changes that are not committed. Commit and push them, or remove them.`);
  const unpushed = await unpushedOf(path, runner);
  if (unpushed === null) return refuse(`git could not count the commits of ${path} that are not on a remote.`);
  if (unpushed > 0) return refuse(`${path} has ${unpushed} ${unpushed === 1 ? "commit that is" : "commits that are"} not on a remote. Push ${unpushed === 1 ? "it" : "them"} first.`);
  steps.push("The tree has no changes, and each commit is on a remote.");
  if (options.dryRun === true) {
    steps.push("A dry run: the removal changed nothing.");
    return { path, ok: true, refused: null, steps, nodeModules: [] };
  }
  const modules = await removeNodeModules(path, options);
  if (modules.removed.length > 0) steps.push(`Deleted ${modules.removed.length} node_modules ${modules.removed.length === 1 ? "folder" : "folders"}.`);
  for (const failure of modules.failed) steps.push(`Could not delete ${failure}`);
  const removed = await runner.git(["-C", options.main, "worktree", "remove", path]);
  const exists = (): boolean => runner.stat(path) !== null;
  if (removed.code === 0 && !exists()) {
    steps.push("git worktree remove removed the tree.");
    return { path, ok: true, refused: null, steps, nodeModules: modules.removed };
  }
  const message = removed.stderr.trim().split(/\r?\n/).slice(-2).join(" ");
  if (removed.code !== 0) steps.push(`git worktree remove failed: ${message || `code ${removed.code}`}`);
  const after = await listedEntry(options.main, path, options);
  if (after === null || after.entry !== undefined) {
    steps.push("git still lists the tree, so the removal stops. Nothing else changed.");
    return { path, ok: false, refused: null, steps, nodeModules: modules.removed };
  }
  const again = refusal(path, options);
  if (again !== null) {
    steps.push(`The rest of the folder stays: ${again}`);
    return { path, ok: false, refused: null, steps, nodeModules: modules.removed };
  }
  try {
    runner.remove(path);
  } catch (error) {
    steps.push(`Could not delete the rest of the folder: ${error instanceof Error ? error.message : String(error)}`);
  }
  const gone = !exists();
  steps.push(gone ? "git did not list the tree any more, so the rest of the folder was deleted." : "The rest of the folder is still there.");
  return { path, ok: gone, refused: null, steps, nodeModules: modules.removed };
}

/** One action of the cleanup. */
export interface CleanAction {
  readonly path: string;
  readonly repo: string;
  readonly state: WorktreeState;
  /** `node_modules`: delete only the `node_modules` folders. `remove`: remove the tree. `prune`: `git worktree prune`. `skip`: no action, with the reason. */
  readonly action: "node_modules" | "remove" | "prune" | "skip";
  readonly ok: boolean;
  readonly detail: string;
}

/** The most trees that one run of the cleanup changes: 20. */
export const WORKTREE_BATCH_MAX = 20;

/** The run of the cleanup stops before a tree when less memory than this is available: 2 GB, in MB. */
export const WORKTREE_MIN_FREE_MB = 2048;

/** The pause between two trees that the cleanup changes: 5 seconds. */
export const WORKTREE_PAUSE_MS = 5000;

/** The options of a cleanup. */
export interface CleanOptions {
  readonly runner: WorktreeRunner;
  /** True: the run changes nothing and gives the whole plan. The limits below apply only to a run that is not a dry run. */
  readonly dryRun: boolean;
  readonly platform?: NodeJS.Platform | undefined;
  /** The most trees that the run changes. The default is 20. */
  readonly max?: number | undefined;
  /** The run stops before a tree when less memory than this is available, in MB. The default is 2048. 0 turns the check off. */
  readonly minFreeMb?: number | undefined;
  /** This function gives the available memory in MB, or `null` when it cannot read it. Without it, the run does no memory check. */
  readonly availableMb?: (() => number | null) | undefined;
  /** The pause between two trees that the run changes, in ms. The default is 5000. */
  readonly pauseMs?: number | undefined;
  /** This function waits. The tests replace it. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** The reason that a run stopped before the end: `max` (the batch is full) or `memory` (too little memory is available). */
export type CleanStop = "max" | "memory";

/** The result of a cleanup. */
export interface CleanResult {
  readonly dryRun: boolean;
  readonly actions: readonly CleanAction[];
  /** The reason that the run stopped before the end, or `null` when it examined each tree. */
  readonly stopped: CleanStop | null;
  /** The trees that the run did not examine because it stopped. The next run examines them. */
  readonly remaining: number;
  /** The available memory in MB at the stop for memory, else `null`. */
  readonly availableMb: number | null;
  /** The free space of each drive of the roots before and after the cleanup, in MB. */
  readonly freeBefore: Readonly<Record<string, number>>;
  readonly freeAfter: Readonly<Record<string, number>>;
}

/** This function gives the drive of a path: `D:` on Windows, else the path itself. */
function driveOf(path: string): string {
  const drive = /^([a-z]):/i.exec(path);
  return drive?.[1] ? `${drive[1].toUpperCase()}:` : path;
}

/** This function gives the free space of each drive of the roots, in MB. */
export function freeSpace(roots: readonly string[], runner: WorktreeRunner): Record<string, number> {
  const free: Record<string, number> = {};
  for (const root of roots) {
    const mb = runner.freeMb(root);
    if (mb !== null) free[driveOf(root)] = mb;
  }
  return free;
}

/**
 * This function cleans the worktrees of a scan:
 *
 * - `active`: no action.
 * - `keep`: it deletes only the `node_modules` folders. The owner decides about the rest.
 * - `removable`: `removeWorktree`, which examines the tree again first.
 * - `broken`: `git worktree prune` in its main checkout.
 * - An orphan: no action at any time.
 *
 * A run that is not a dry run changes at most `max` trees. It waits `pauseMs` between two trees that it changes. Before
 * each tree, it reads the available memory, and it stops when the memory is less than `minFreeMb`. A refusal or a tree
 * with no work does not count. The result gives the count of the trees that the run did not examine.
 */
export async function cleanWorktrees(scan: WorktreeScan, options: CleanOptions): Promise<CleanResult> {
  const context: SafetyContext = { roots: scan.roots, mains: scan.mains, runner: options.runner, platform: options.platform };
  const limited = !options.dryRun;
  const max = options.max ?? WORKTREE_BATCH_MAX;
  const minFreeMb = options.minFreeMb ?? WORKTREE_MIN_FREE_MB;
  const pauseMs = options.pauseMs ?? WORKTREE_PAUSE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const freeBefore = freeSpace(scan.roots, options.runner);
  const actions: CleanAction[] = [];
  const pruned = new Set<string>();
  let changed = 0;
  let stopped: CleanStop | null = null;
  let remaining = 0;
  let availableMb: number | null = null;
  /** This function gives true when the run can change one more tree. It pauses after a change, then reads the memory. */
  const proceed = async (): Promise<boolean> => {
    if (!limited) return true;
    if (stopped !== null) return false;
    if (changed >= max) {
      stopped = "max";
      return false;
    }
    if (changed > 0 && pauseMs > 0) await sleep(pauseMs);
    const available = minFreeMb > 0 ? (options.availableMb?.() ?? null) : null;
    if (available !== null && available < minFreeMb) {
      stopped = "memory";
      availableMb = available;
      return false;
    }
    return true;
  };
  for (const tree of scan.trees) {
    const base = { path: tree.path, repo: tree.repo, state: tree.state };
    if (tree.state === "active") continue;
    if (!tree.inRoots) {
      actions.push({ ...base, action: "skip", ok: true, detail: "outside the roots" });
      continue;
    }
    if (tree.state === "broken") {
      if (pruned.has(tree.main)) continue;
      if (!(await proceed())) {
        remaining += 1;
        continue;
      }
      pruned.add(tree.main);
      if (options.dryRun) {
        actions.push({ ...base, path: tree.main, action: "prune", ok: true, detail: "git worktree prune (dry run)" });
        continue;
      }
      const result = await options.runner.git(["-C", tree.main, "worktree", "prune"]);
      changed += 1;
      actions.push({ ...base, path: tree.main, action: "prune", ok: result.code === 0, detail: result.code === 0 ? "git worktree prune" : `git worktree prune failed: ${result.stderr.trim()}` });
      continue;
    }
    if (stopped !== null) {
      remaining += 1;
      continue;
    }
    if (tree.state === "keep") {
      const folders = findNodeModules(tree.path, options.runner);
      if (folders.length === 0) continue;
      if (options.dryRun) {
        const unsafe = refusal(tree.path, context);
        actions.push({ ...base, action: unsafe === null ? "node_modules" : "skip", ok: true, detail: unsafe ?? `delete ${folders.length} node_modules (dry run). Kept: ${tree.reasons.join(", ")}` });
        continue;
      }
      if (!(await proceed())) {
        remaining += 1;
        continue;
      }
      const result = await removeNodeModules(tree.path, context);
      if (result.refused === null) changed += 1;
      const detail = result.refused ?? `deleted ${result.removed.length} node_modules${result.failed.length > 0 ? `, ${result.failed.length} failed` : ""}. Kept: ${tree.reasons.join(", ")}`;
      actions.push({ ...base, action: result.refused === null ? "node_modules" : "skip", ok: result.refused === null && result.failed.length === 0, detail });
      continue;
    }
    if (!(await proceed())) {
      remaining += 1;
      continue;
    }
    const result = await removeWorktree(tree.path, { ...context, main: tree.main, dryRun: options.dryRun });
    if (result.refused === null && !options.dryRun) changed += 1;
    actions.push({ ...base, action: result.refused === null ? "remove" : "skip", ok: result.ok, detail: result.refused ?? result.steps.join(" ") });
  }
  const freeAfter = options.dryRun ? freeBefore : freeSpace(scan.roots, options.runner);
  return { dryRun: options.dryRun, actions, stopped, remaining, availableMb, freeBefore, freeAfter };
}

/** The counts of one repository. */
export interface RepoCounts {
  readonly repo: string;
  readonly counts: Readonly<Record<WorktreeCountState, number>>;
  /** The size of the `node_modules` folders of its trees, or `null` with no sizes. */
  readonly nodeModulesBytes: number | null;
}

/** The summary of a scan: the counts of each state and of each repository. */
export interface WorktreeSummary {
  readonly at: string;
  readonly roots: readonly string[];
  readonly counts: Readonly<Record<WorktreeCountState, number>>;
  /** The repositories, the most trees first. */
  readonly repos: readonly RepoCounts[];
}

/** This function gives the empty counts. */
function noCounts(): Record<WorktreeCountState, number> {
  return { active: 0, removable: 0, keep: 0, broken: 0, orphan: 0 };
}

/** This function gives the summary of a scan. */
export function summarize(scan: WorktreeScan): WorktreeSummary {
  const counts = noCounts();
  const repos = new Map<string, { counts: Record<WorktreeCountState, number>; bytes: number | null }>();
  const add = (repo: string, state: WorktreeCountState, bytes: number | null): void => {
    counts[state] += 1;
    const row = repos.get(repo) ?? { counts: noCounts(), bytes: null };
    row.counts[state] += 1;
    if (bytes !== null) row.bytes = (row.bytes ?? 0) + bytes;
    repos.set(repo, row);
  };
  for (const tree of scan.trees) add(tree.repo, tree.state, tree.nodeModulesBytes);
  for (const orphan of scan.orphans) add(orphan.repo, "orphan", null);
  const total = (row: Record<WorktreeCountState, number>): number => WORKTREE_STATES.reduce((sum, state) => sum + row[state], 0);
  return {
    at: new Date(scan.at).toISOString(),
    roots: scan.roots,
    counts,
    repos: [...repos].map(([repo, row]) => ({ repo, counts: row.counts, nodeModulesBytes: row.bytes })).sort((a, b) => total(b.counts) - total(a.counts) || a.repo.localeCompare(b.repo)),
  };
}

/** The alert id of too many `keep` trees. */
export const WORKTREE_KEEP_ALERT_ID = "worktree:keep";

/** This function gives the alert when more than `limit` trees are `keep`, with the 3 repositories that have the most, or `null`. */
export function keepAlert(summary: Pick<WorktreeSummary, "counts" | "repos">, limit: number = WORKTREE_KEEP_ALERT): Omit<Alert, "since"> | null {
  const keep = summary.counts.keep;
  if (keep <= limit) return null;
  const top = [...summary.repos]
    .filter((row) => row.counts.keep > 0)
    .sort((a, b) => b.counts.keep - a.counts.keep)
    .slice(0, 3)
    .map((row) => `${row.repo} ${row.counts.keep}`);
  return {
    id: WORKTREE_KEEP_ALERT_ID,
    kind: "worktree",
    subject: "git worktrees",
    pid: null,
    mb: 0,
    message: `${keep} idle worktrees have changes or commits that are not on a remote (the limit is ${limit}). Most: ${top.join(", ")}. Their owners push or remove them. Run headroom worktree list.`,
  };
}

/** The time between two cleanups of the daemon: 24 hours. */
export const WORKTREE_CLEAN_EVERY_MS: number = 24 * 3_600_000;

/** The shortest time between two cleanups for low free space: 1 hour. */
export const WORKTREE_LOW_SPACE_EVERY_MS = 3_600_000;

/** The reason of a cleanup of the daemon. `batch`: the last run stopped before the end, so the next batch starts. */
export type CleanReason = "daily" | "low-space" | "batch";

/**
 * This function tells if the daemon starts a cleanup. It gives `batch` when the last run left trees. It gives `daily`
 * 24 hours after the last cleanup. It gives `low-space` when a drive of a root has less than 20 GB free, 1 hour or more
 * after the last cleanup. Else it gives `null`.
 */
export function cleanDue(now: number, lastAt: number | null, lowSpace: boolean, more: boolean = false): CleanReason | null {
  if (more) return "batch";
  if (lastAt === null || now - lastAt >= WORKTREE_CLEAN_EVERY_MS) return "daily";
  if (lowSpace && now - lastAt >= WORKTREE_LOW_SPACE_EVERY_MS) return "low-space";
  return null;
}

/** This function gives the line of the free space before and after a cleanup. */
export function freedLine(result: Pick<CleanResult, "freeBefore" | "freeAfter" | "dryRun">): string {
  const drives = Object.keys(result.freeBefore);
  if (drives.length === 0) return "No free space read.";
  const parts = drives.map((drive) => {
    const before = result.freeBefore[drive] ?? 0;
    const after = result.freeAfter[drive] ?? before;
    return result.dryRun ? `${drive} ${diskSize(before)} free` : `${drive} ${diskSize(before)} free before, ${diskSize(after)} after (${diskSize(Math.max(0, after - before))} freed)`;
  });
  return `${parts.join("; ")}.`;
}

/** The options of the runner of this computer. */
export interface NodeRunnerOptions {
  /** The environment of git. The default is the environment of this process. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The size of a folder. Without it, the scan gives no sizes. */
  readonly measure?: ((path: string) => Promise<FolderMeasure>) | undefined;
  /** The time limit of each git command. The default is 10 minutes. */
  readonly timeoutMs?: number | undefined;
}

/** This function gives the kind of an entry of `readdirSync` or of `lstatSync`. */
function kindOf(entry: { isSymbolicLink(): boolean; isDirectory(): boolean }): EntryKind {
  return entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file";
}

/** This function gives the runner of this computer: git with no shell, and the file system of Node. */
export function nodeRunner(options: NodeRunnerOptions = {}): WorktreeRunner {
  return {
    git: (args) =>
      new Promise((done) => {
        execFile(
          "git",
          [...args],
          { env: options.env ?? process.env, timeout: options.timeoutMs ?? 600_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
            done({ code, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? "") });
          },
        );
      }),
    entries: (path) => {
      try {
        return readdirSync(path, { withFileTypes: true }).map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
      } catch {
        return null;
      }
    },
    stat: (path) => {
      try {
        const stats = lstatSync(path);
        return { kind: kindOf(stats), mtimeMs: stats.mtimeMs };
      } catch {
        return null;
      }
    },
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    // `rmSync` unlinks a link or a junction, and does not follow it. It also deletes the paths longer than 260 characters.
    remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
    freeMb: (path) => {
      try {
        const stats = statfsSync(path);
        return Math.round((stats.bavail * stats.bsize) / (1024 * 1024));
      } catch {
        return null;
      }
    },
    measure: options.measure,
  };
}
