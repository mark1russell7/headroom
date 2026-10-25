/**
 * The disk report (H21): `headroom disk report` sizes a fixed list of known places on each drive.
 *
 * - The report runs in the process of the command, not in the daemon. The daemon only reads the saved summary for the dashboard.
 * - Each place has a class. The class tells what `headroom disk clean` does with it: it removes it, it removes a part, or Mark decides.
 * - The report has a time budget: 30 seconds, or 3 minutes with `--deep`. Each place gets a share of the time that is left.
 *   A place whose share runs out gets a partial size, and the report tells it.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync, type Dirent } from "node:fs";
import { mkdir, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { diskSize, isLeaseId, KEEP_MARK, type DiskSpace } from "@headroom/core";
import { walk, Walker, type WalkResult } from "./disk-walk.ts";

/** The time budget of the quick report, in ms. */
export const QUICK_BUDGET_MS = 30_000;

/** The time budget of the deep report, in ms. The quick places get `QUICK_BUDGET_MS` of it, and the deep walk gets the rest. */
export const DEEP_BUDGET_MS = 180_000;

/** The depth of the folders in the deep report. */
export const DEEP_DEPTH = 3;

/** The count of folders of each root in the deep report. */
const DEEP_SHOWN = 20;

/** The count of places that the summary of the dashboard keeps. */
const SUMMARY_SHOWN = 6;

/** The name end of the copies that the move to the Dev Drive kept. headroom does not delete them. Only Mark decides. */
export const BEFORE_DEVDRIVE = ".before-devdrive";

/**
 * What `headroom disk clean` does with a place.
 *
 * - `clean`: it removes the place, or it runs `pnpm store prune` when that is safe.
 * - `part`: it removes only the old trace files directly in the place.
 * - `live`: the temp folders of live jobs. The cleanup does not touch them.
 * - `ask`: Mark decides.
 * - `kept`: a `*.before-devdrive` copy, or a folder that `--keep-temp` keeps. It stays until Mark decides.
 * - `image`: a disk image of Docker or WSL. The report reads only its size.
 */
export type PlaceClass = "clean" | "part" | "live" | "ask" | "kept" | "image";

/** One known place: one folder or file, or a group of them. */
export interface Place {
  readonly id: string;
  readonly label: string;
  readonly paths: readonly string[];
  readonly class: PlaceClass;
  /** The steps for Mark, for the places that Mark decides. */
  readonly how?: string | undefined;
}

/** The size of one place. */
export interface ReportItem {
  readonly id: string;
  readonly label: string;
  readonly paths: readonly string[];
  /** The drive of the first path, for example `D:`, or `null` when the drive is not known. */
  readonly drive: string | null;
  readonly class: PlaceClass;
  readonly mb: number;
  readonly files: number;
  /** True when the time budget ran out. The size is then a lower limit. */
  readonly partial: boolean;
  /** True when no path of the place exists. */
  readonly missing: boolean;
  /** The links and the junctions that the walk did not follow. */
  readonly links: number;
  /** The folders and the files that the walk could not read, for example the folders of another user. */
  readonly errors: number;
  /** The MB of the files with one link. Only the pnpm store gives it. */
  readonly oneLinkMb?: number | undefined;
  readonly how?: string | undefined;
}

/** One folder of the deep report. */
export interface DeepFolder {
  readonly path: string;
  readonly mb: number;
}

/** The largest folders under one root, to the depth `DEEP_DEPTH`. */
export interface DeepRoot {
  readonly root: string;
  readonly mb: number;
  readonly partial: boolean;
  readonly folders: readonly DeepFolder[];
}

/** One line of the summary of the dashboard. */
export interface SummaryItem {
  readonly label: string;
  readonly drive: string | null;
  readonly mb: number;
  readonly class: PlaceClass;
  readonly partial: boolean;
}

/** The summary that the dashboard shows: the time of the last report and its largest places. */
export interface ReportSummary {
  readonly at: string;
  readonly mode: "quick" | "deep";
  readonly ms: number;
  readonly drives: readonly DiskSpace[];
  readonly top: readonly SummaryItem[];
  /** The count of places with a partial size. */
  readonly partial: number;
}

/** The disk report. `~/.headroom/disk-report.json` keeps the last one. */
export interface DiskReport {
  readonly version: 1;
  readonly at: string;
  readonly mode: "quick" | "deep";
  /** The drive of `--drive`, or `null` for all the drives. */
  readonly drive: string | null;
  readonly ms: number;
  readonly budgetMs: number;
  readonly drives: readonly DiskSpace[];
  readonly items: readonly ReportItem[];
  readonly deep: readonly DeepRoot[];
  readonly notes: readonly string[];
  readonly summary: ReportSummary;
}

/** What the daemon tells the report: the temp root of the jobs and the live leases. `null` when the daemon does not answer. */
export interface DaemonFacts {
  readonly tempRoot: string | null;
  /** The ids of the active leases: granted or waiting. */
  readonly live: ReadonlySet<string>;
}

/** The text of each class in the report. */
export const CLASS_TEXT: Readonly<Record<PlaceClass, string>> = {
  clean: "the cleanup removes it",
  part: "the cleanup removes only old trace files",
  live: "live jobs: not touched",
  ask: "ask Mark",
  kept: "kept until Mark decides",
  image: "disk image: size only",
};

/** This function gives the text of what the cleanup does with a place. The pnpm store gets `pnpm store prune` only when it is safe. */
export function whatText(item: Pick<ReportItem, "id" | "class">): string {
  return item.id === "pnpm-store" ? "the cleanup prunes it only when safe" : CLASS_TEXT[item.class];
}

/** This function gives the drive of a path: `D:` on Windows, or `null` when the path names no drive. */
export function driveOf(path: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "win32") return null;
  const letter = path.charAt(0).toUpperCase();
  return letter >= "A" && letter <= "Z" && path.charAt(1) === ":" ? `${letter}:` : null;
}

/** This function tells if a drive name names the same drive as a filter. The filter `d` and `D:` both name `D:`. */
export function driveMatches(drive: string | null, filter: string | null): boolean {
  if (filter === null) return true;
  const wanted = filter.charAt(0).toUpperCase();
  return drive !== null && drive.charAt(0).toUpperCase() === wanted;
}

/** This function gives the entries of a folder, or none when the folder cannot be read. */
function entriesOf(folder: string): Dirent[] {
  try {
    return readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** This function gives the `*.before-devdrive` copies directly in the folders. The match ignores the case of the name. */
export function findBeforeDevdrive(folders: readonly string[]): string[] {
  const found = new Map<string, string>();
  for (const folder of folders) {
    for (const entry of entriesOf(folder)) {
      if (!entry.name.toLowerCase().endsWith(BEFORE_DEVDRIVE)) continue;
      const path = join(folder, entry.name);
      found.set(path.toLowerCase(), path);
    }
  }
  return [...found.values()].sort();
}

/** This function gives the `.vhdx` files under a folder, to a depth of 3. It does not follow a link or a junction. */
export function findImages(folder: string, depth = 3): string[] {
  const found: string[] = [];
  for (const entry of entriesOf(folder)) {
    if (entry.isSymbolicLink()) continue;
    const path = join(folder, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".vhdx")) found.push(path);
    else if (entry.isDirectory() && depth > 1) found.push(...findImages(path, depth - 1));
  }
  return found;
}

/** This function gives the disk images of Docker Desktop: under `%LOCALAPPDATA%\Docker\wsl`, and under the folder of its setting. */
export function dockerImages(local: string, roaming: string): string[] {
  const folders = [join(local, "Docker", "wsl")];
  try {
    const settings = JSON.parse(readFileSync(join(roaming, "Docker", "settings-store.json"), "utf8")) as Record<string, unknown>;
    const custom = settings["CustomWslDistroDir"];
    if (typeof custom === "string" && custom !== "") folders.push(custom);
  } catch {
    // Docker Desktop has no settings file, or its file has no custom folder.
  }
  return [...new Set(folders.flatMap((folder) => findImages(folder)))];
}

/**
 * This function reads the disk images of the WSL distributions from the output of
 * `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss /s`. The image is `<BasePath>\<VhdFileName>`.
 */
export function parseWslImages(output: string): string[] {
  const images: string[] = [];
  let base: string | null = null;
  let file: string | null = null;
  const flush = (): void => {
    if (base !== null) images.push(win32.join(base.startsWith("\\\\?\\") ? base.slice(4) : base, file ?? "ext4.vhdx"));
    base = null;
    file = null;
  };
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("HKEY_")) {
      flush();
      continue;
    }
    const parts = line.split("    ").map((part) => part.trim()).filter((part) => part !== "");
    if (parts.length < 3) continue;
    if (parts[0] === "BasePath") base = parts.slice(2).join(" ");
    if (parts[0] === "VhdFileName") file = parts.slice(2).join(" ");
  }
  flush();
  return images;
}

/** This function runs a program with an argument array, with no shell, and gives its output, or `null` on an error. */
export function runProgram(file: string, args: readonly string[], options: { cwd?: string; timeoutMs?: number; verbatim?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, timeout: options.timeoutMs ?? 20_000, windowsHide: true, windowsVerbatimArguments: options.verbatim ?? false, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });
}

/**
 * This function runs one fixed pnpm command from the home folder, so the `packageManager` field of a project does not
 * change the version of pnpm. On Windows, `pnpm` is a batch file, so `cmd.exe` starts it. The command line is a constant.
 */
export function runPnpm(action: "store path" | "store prune", timeoutMs = 20_000): Promise<string | null> {
  const cwd = homedir();
  if (process.platform !== "win32") return runProgram("pnpm", action === "store path" ? ["store", "path"] : ["store", "prune"], { cwd, timeoutMs });
  return runProgram("cmd.exe", ["/d", "/s", "/c", action === "store path" ? "pnpm store path" : "pnpm store prune"], { cwd, timeoutMs });
}

/** This function gives the store folder of pnpm from `pnpm store path`, or `null` when pnpm does not answer. */
export async function pnpmStorePath(): Promise<string | null> {
  const output = await runPnpm("store path");
  const line = output
    ?.split("\n")
    .map((each) => each.trim())
    .filter((each) => each !== "")
    .pop();
  return line === undefined || line === "" ? null : line;
}

/** This function gives the store folder of pnpm from the path of one store version: `D:\pnpm-store` for `D:\pnpm-store\v11`. */
export function storeRootOf(path: string): string {
  const name = win32.basename(path);
  const digits = name.slice(1);
  const version = name.startsWith("v") && digits !== "" && [...digits].every((char) => char >= "0" && char <= "9");
  return version ? (path.includes("\\") ? win32.dirname(path) : posix.dirname(path)) : path;
}

/** This function gives the cache folder of npm: `npm_config_cache`, then the line `cache=` of `~/.npmrc`, then the default. */
export function npmCacheOf(env: Readonly<Record<string, string | undefined>>, home: string, platform: NodeJS.Platform): { current: string; fallback: string } {
  const fallback = platform === "win32" ? join(env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), "npm-cache") : join(home, ".npm");
  const fromEnv = env["npm_config_cache"] ?? env["NPM_CONFIG_CACHE"];
  if (fromEnv !== undefined && fromEnv !== "") return { current: fromEnv, fallback };
  try {
    for (const raw of readFileSync(join(home, ".npmrc"), "utf8").split("\n")) {
      const line = raw.trim();
      if (line.startsWith("cache=")) return { current: line.slice("cache=".length).trim(), fallback };
    }
  } catch {
    // The user has no .npmrc.
  }
  return { current: fallback, fallback };
}

/** The data that `knownPlaces()` needs. The command reads it, and the tests give it. */
export interface PlaceInput {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly drives: readonly DiskSpace[];
  readonly daemon: DaemonFacts | null;
  readonly pnpmStore: string | null;
  readonly wslImages: readonly string[];
}

/** This function gives the temp folder of the user. On Windows, it is `%LOCALAPPDATA%\Temp`, also inside a job of `headroom run`. */
export function userTemp(env: Readonly<Record<string, string | undefined>>, home: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return tmpdir();
  return join(env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), "Temp");
}

/** This function gives the folder of the repositories, `~/git`, or `null`. On this computer, it is a junction to `D:\git`. */
export function gitRootOf(home: string): string | null {
  const link = join(home, "git");
  return existsSync(link) ? link : null;
}

/** This function sorts the folders directly under the temp root of the jobs: live, not live, kept and other. */
export function jobTempGroups(root: string, live: ReadonlySet<string>): { live: string[]; ended: string[]; kept: string[]; other: string[] } {
  const groups = { live: [] as string[], ended: [] as string[], kept: [] as string[], other: [] as string[] };
  for (const entry of entriesOf(root)) {
    const path = join(root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isLeaseId(entry.name)) groups.other.push(path);
    else if (existsSync(join(path, KEEP_MARK))) groups.kept.push(path);
    else if (live.has(entry.name)) groups.live.push(path);
    else groups.ended.push(path);
  }
  return groups;
}

/**
 * This function gives the known places, the cheap ones first. The pnpm store and the `node_modules` folders come last,
 * because they have the most files.
 */
export function knownPlaces(input: PlaceInput): Place[] {
  const { platform, env, home } = input;
  const win = platform === "win32";
  const local = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
  const roaming = env["APPDATA"] ?? join(home, "AppData", "Roaming");
  const places: Place[] = [];
  const add = (place: Place): void => {
    if (place.paths.length > 0) places.push(place);
  };

  if (win) {
    const docker = dockerImages(local, roaming);
    const known = new Set(docker.map((path) => path.toLowerCase()));
    for (const path of docker) {
      add({ id: `docker:${path}`, label: `Docker Desktop disk image (${win32.basename(path)})`, paths: [path], class: "image", how: "Docker Desktop: Troubleshoot, then Clean / Purge data. Or `docker system prune`." });
    }
    for (const path of input.wslImages.filter((image) => !known.has(image.toLowerCase()))) {
      add({ id: `wsl:${path}`, label: "WSL disk image", paths: [path], class: "image", how: "`wsl --manage <distribution> --set-sparse true`, or `wsl --unregister` for a distribution that is not used." });
    }
  }

  const root = input.daemon?.tempRoot ?? null;
  if (root !== null) {
    const groups = jobTempGroups(root, input.daemon?.live ?? new Set());
    add({ id: "job-temp:live", label: `Temp folders of live jobs (${groups.live.length})`, paths: groups.live, class: "live" });
    add({ id: "job-temp:ended", label: `Temp folders of jobs that are not live (${groups.ended.length})`, paths: groups.ended, class: "clean" });
    add({ id: "job-temp:kept", label: `Temp folders kept with --keep-temp (${groups.kept.length})`, paths: groups.kept, class: "kept", how: "Remove each folder by hand when its job is done." });
    add({ id: "job-temp:other", label: "Other entries in the temp root of the jobs", paths: groups.other, class: "ask" });
  }

  add({ id: "temp", label: "Temp folder of the user", paths: [userTemp(env, home, platform)], class: "part", how: "Close the programs, then remove old files in the temp folder." });
  if (win) {
    add({ id: "windows-temp", label: "Temp folder of Windows", paths: [join(env["SystemRoot"] ?? "C:\\Windows", "Temp")], class: "ask", how: "Settings, System, Storage, Temporary files." });
    add({ id: "recycle", label: "Recycle bins", paths: input.drives.map((drive) => `${drive.mount}\\$Recycle.Bin`), class: "ask", how: "Empty the Recycle Bin." });
    const code = join(roaming, "Code");
    const caches = ["Cache", "CachedData", "CachedExtensionVSIXs", "CachedProfilesData", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Crashpad", "logs", join("Service Worker", "CacheStorage")];
    add({ id: "vscode-cache", label: "VS Code caches", paths: caches.map((name) => join(code, name)), class: "ask", how: "Close VS Code, then remove these cache folders. VS Code fills them again." });
    add({ id: "vscode-workspaces", label: "VS Code workspace storage", paths: [join(code, "User", "workspaceStorage")], class: "ask" });
  } else {
    add({ id: "vscode-cache", label: "VS Code caches", paths: ["Cache", "CachedData", "CachedExtensionVSIXs", "logs"].map((name) => join(home, ".config", "Code", name)), class: "ask" });
  }

  const playwright = env["PLAYWRIGHT_BROWSERS_PATH"] ?? (win ? join(local, "ms-playwright") : join(home, ".cache", "ms-playwright"));
  add({ id: "playwright", label: "Playwright browsers", paths: [playwright], class: "ask", how: "`npx playwright uninstall --all` removes the browsers. Each project installs its browsers again." });

  const npm = npmCacheOf(env, home, platform);
  add({ id: "npm-cache", label: "npm cache", paths: [npm.current], class: "ask", how: "`npm cache clean --force`." });
  if (npm.fallback.toLowerCase() !== npm.current.toLowerCase()) {
    add({ id: "npm-cache:old", label: "Old npm cache (before the move to the Dev Drive)", paths: [npm.fallback], class: "ask" });
  }

  add({ id: "claude-projects", label: "Claude Code transcripts (~/.claude/projects)", paths: [join(home, ".claude", "projects")], class: "ask" });

  const gitRoot = gitRootOf(home);
  const store = input.pnpmStore === null ? null : storeRootOf(input.pnpmStore);
  const copyFolders = [home, ...(win ? [local, roaming] : []), ...input.drives.map((drive) => (win ? `${drive.mount}\\` : drive.mount))];
  if (store !== null) copyFolders.push(dirname(store));
  for (const path of findBeforeDevdrive(copyFolders)) {
    add({ id: `before-devdrive:${path}`, label: `Copy before the Dev Drive move (${(win ? win32 : posix).basename(path)})`, paths: [path], class: "kept", how: "Mark decides (docs/DEV-DRIVE.md, part B, step 8)." });
  }

  const oldStore = win ? join(local, "pnpm", "store") : join(home, ".local", "share", "pnpm", "store");
  if (store === null || store.toLowerCase() !== oldStore.toLowerCase()) {
    add({ id: "pnpm-store:old", label: "Old pnpm store (before the move to the Dev Drive)", paths: [oldStore], class: "ask", how: "Remove it when no project uses it. `pnpm store path` names the store in use." });
  }
  // The store folder has one folder for each store version, for example v10 and v11. The report sizes all of them.
  if (store !== null) add({ id: "pnpm-store", label: "pnpm store (all versions)", paths: [store], class: "clean" });

  if (gitRoot !== null) {
    for (const entry of entriesOf(gitRoot)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const modules = join(gitRoot, entry.name, "node_modules");
      if (existsSync(modules)) add({ id: `node_modules:${entry.name}`, label: `node_modules of ${entry.name}`, paths: [modules], class: "ask", how: "Remove `node_modules` of a repository that is not in use. `pnpm install` brings it back." });
    }
  }
  return places;
}

/** The options of a report run. */
export interface ReportOptions {
  readonly mode: "quick" | "deep";
  readonly drive: string | null;
  readonly places: readonly Place[];
  readonly drives: readonly DiskSpace[];
  /** The folders of the deep report. */
  readonly deepRoots: readonly string[];
  readonly platform?: NodeJS.Platform | undefined;
  readonly now?: (() => number) | undefined;
  readonly budgetMs?: number | undefined;
  readonly notes?: readonly string[] | undefined;
}

const MBYTES = 1024 * 1024;

/** This function gives the real path of a path, or the path itself when it does not exist. */
export async function realOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** One place of a report run, with one walker for each of its paths. */
interface Sizing {
  readonly place: Place;
  readonly paths: readonly string[];
  readonly walkers: readonly Walker[];
}

/** This function gives the walkers of one place. A place with no path on the drive of the filter gives `null`. */
async function sizingOf(place: Place, drive: string | null, platform: NodeJS.Platform, seen: Set<string>, now: () => number): Promise<Sizing | null> {
  const paths: string[] = [];
  for (const path of place.paths) {
    const real = await realOf(path);
    if (driveMatches(driveOf(real, platform), drive)) paths.push(real);
  }
  if (paths.length === 0) return null;
  return { place, paths, walkers: paths.map((path) => new Walker(path, { seen, now })) };
}

/** This function continues the walks of one place until the deadline. */
async function runSizing(sizing: Sizing, deadline: number): Promise<void> {
  for (const walker of sizing.walkers) if (!walker.done) await walker.run(deadline);
}

/** This function gives the item of one place from the results of its walkers. */
function itemOf(sizing: Sizing, platform: NodeJS.Platform): ReportItem {
  const { place, paths } = sizing;
  const results: WalkResult[] = sizing.walkers.map((walker) => walker.result());
  const bytes = results.reduce((sum, result) => sum + result.bytes, 0);
  const oneLink = results.reduce((sum, result) => sum + result.oneLinkBytes, 0);
  return {
    id: place.id,
    label: place.label,
    paths,
    drive: driveOf(paths[0] ?? "", platform),
    class: place.class,
    mb: bytes / MBYTES,
    files: results.reduce((sum, result) => sum + result.files, 0),
    partial: results.some((result) => result.partial),
    missing: results.every((result) => !result.exists),
    links: results.reduce((sum, result) => sum + result.links, 0),
    errors: results.reduce((sum, result) => sum + result.errors, 0),
    ...(place.id === "pnpm-store" ? { oneLinkMb: oneLink / MBYTES } : {}),
    ...(place.how === undefined ? {} : { how: place.how }),
  };
}

/** This function gives the summary of a report for the dashboard. */
export function summaryOf(report: Omit<DiskReport, "summary">): ReportSummary {
  const top = [...report.items]
    .filter((item) => !item.missing)
    .sort((a, b) => b.mb - a.mb)
    .slice(0, SUMMARY_SHOWN)
    .map((item) => ({ label: item.label, drive: item.drive, mb: Math.round(item.mb), class: item.class, partial: item.partial }));
  return { at: report.at, mode: report.mode, ms: report.ms, drives: report.drives, top, partial: report.items.filter((item) => item.partial).length };
}

/** The most passes of a report over the places that are not done. */
const PASSES = 20;

/**
 * This function runs a report. The first pass sizes the places one after the other in half of the time. Each place gets
 * the time that is left, divided by the count of places that are left. The next passes continue the places that are not
 * done, in the same way. Thus the small places give their unused time to the large places.
 */
export async function runReport(options: ReportOptions): Promise<DiskReport> {
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const start = now();
  const budget = options.budgetMs ?? (options.mode === "deep" ? DEEP_BUDGET_MS : QUICK_BUDGET_MS);
  const quickEnd = start + Math.min(budget, QUICK_BUDGET_MS);
  const seen = new Set<string>();
  const sizings: Sizing[] = [];
  for (const place of options.places) {
    const sizing = await sizingOf(place, options.drive, platform, seen, now);
    if (sizing !== null) sizings.push(sizing);
  }
  const firstEnd = start + (quickEnd - start) / 2;
  for (const [index, sizing] of sizings.entries()) {
    await runSizing(sizing, now() + Math.max(0, firstEnd - now()) / (sizings.length - index));
  }
  for (let pass = 0; pass < PASSES && now() < quickEnd; pass++) {
    const open = sizings.filter((sizing) => sizing.walkers.some((walker) => !walker.done));
    if (open.length === 0) break;
    for (const [index, sizing] of open.entries()) {
      await runSizing(sizing, now() + Math.max(0, quickEnd - now()) / (open.length - index));
    }
  }
  const items = sizings.map((sizing) => itemOf(sizing, platform));
  for (const sizing of sizings) for (const walker of sizing.walkers) await walker.close();
  const deep: DeepRoot[] = [];
  if (options.mode === "deep") {
    const end = start + budget;
    const roots = options.deepRoots.filter((root) => driveMatches(driveOf(root, platform), options.drive));
    for (const [index, root] of roots.entries()) {
      const deadline = now() + Math.max(0, end - now()) / (roots.length - index);
      // The deep walk has its own set of seen files, so a file of a known place also counts in its folder.
      const result = await walk(root, { deadline, depth: DEEP_DEPTH, now });
      const folders = [...result.folderBytes.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, DEEP_SHOWN)
        .map(([path, bytes]) => ({ path, mb: bytes / MBYTES }));
      deep.push({ root, mb: result.bytes / MBYTES, partial: result.partial, folders });
    }
  }
  const drives = options.drives.filter((each) => driveMatches(each.mount, options.drive) || platform !== "win32");
  const base = {
    version: 1 as const,
    at: new Date(start).toISOString(),
    mode: options.mode,
    drive: options.drive,
    ms: now() - start,
    budgetMs: budget,
    drives,
    items,
    deep,
    notes: options.notes ?? [],
  };
  return { ...base, summary: summaryOf(base) };
}

/** This function gives the free space of each drive of a list, with `statfs`. A drive that cannot be read is not in the list. */
export function readDrives(mounts: readonly string[], platform: NodeJS.Platform = process.platform): DiskSpace[] {
  const list: DiskSpace[] = [];
  for (const mount of mounts) {
    try {
      const stats = statfsSync(platform === "win32" ? `${mount}\\` : mount);
      list.push({ mount, freeMb: Math.round((stats.bavail * stats.bsize) / MBYTES), totalMb: Math.round((stats.blocks * stats.bsize) / MBYTES) });
    } catch {
      // The drive is not ready.
    }
  }
  return list;
}

/** This function gives the drive letters from `C:` to `Z:` that have a root folder. */
export function driveLetters(): string[] {
  const found: string[] = [];
  for (let code = 67; code <= 90; code++) {
    const mount = `${String.fromCharCode(code)}:`;
    if (existsSync(`${mount}\\`)) found.push(mount);
  }
  return found;
}

/** This function writes a size with a fixed width for the table of the report. */
function sizeText(mb: number): string {
  return diskSize(mb).padStart(8);
}

/** The count of places in the table of the text report. */
const LINES_SHOWN = 25;

/** This function gives the lines of the text report. */
export function reportLines(report: DiskReport, savedTo: string | null): string[] {
  const seconds = (report.ms / 1000).toFixed(1);
  const lines = [
    `Disk report (${report.mode}${report.drive === null ? "" : `, drive ${report.drive}`}): ${report.at.slice(0, 16).replace("T", " ")} UTC, ${seconds} s of ${report.budgetMs / 1000} s.${savedTo === null ? "" : ` Saved to ${savedTo}.`}`,
  ];
  if (report.drives.length > 0) lines.push(report.drives.map((drive) => `Drive ${drive.mount} has ${diskSize(drive.freeMb)} free of ${diskSize(drive.totalMb)}.`).join(" "));
  const shown = [...report.items].filter((item) => !item.missing).sort((a, b) => b.mb - a.mb);
  lines.push("", `${"SIZE".padStart(8)}  DRIVE  ${"PLACE".padEnd(56)} WHAT HAPPENS`);
  for (const item of shown.slice(0, LINES_SHOWN)) {
    const label = item.label.length > 56 ? `${item.label.slice(0, 55)}~` : item.label;
    lines.push(`${sizeText(item.mb)}  ${(item.drive ?? "-").padEnd(5)}  ${label.padEnd(56)} ${whatText(item)}${item.partial ? " (partial)" : ""}`);
  }
  if (shown.length > LINES_SHOWN) {
    const rest = shown.slice(LINES_SHOWN);
    lines.push(`${sizeText(rest.reduce((sum, item) => sum + item.mb, 0))}         More places: ${rest.length}. --json gives each one.`);
  }
  const copies = report.items.filter((item) => item.id.startsWith("before-devdrive:"));
  lines.push("", copies.length === 0 ? "Kept: no *.before-devdrive copy found." : `Kept until Mark decides: ${copies.map((item) => `${item.paths[0]} (${diskSize(item.mb)})`).join(", ")}.`);
  const store = report.items.find((item) => item.id === "pnpm-store");
  if (store?.oneLinkMb !== undefined && store.mb > 0) {
    lines.push(`pnpm store: ${Math.round((store.oneLinkMb / store.mb) * 100)}% of its size has one link. pnpm store prune counts these files as unused.`);
  }
  const partial = report.items.filter((item) => item.partial).length;
  if (partial > 0) lines.push(`Partial places: ${partial}. The time ran out, so their sizes are lower limits. --deep gives more time.`);
  if (report.items.some((item) => item.id.startsWith("node_modules:"))) {
    lines.push("A block clone of ReFS shares its blocks. Thus node_modules on a Dev Drive uses less space than its size.");
  }
  for (const root of report.deep) {
    lines.push("", `The largest folders under ${root.root} (${diskSize(root.mb)}${root.partial ? ", partial" : ""}):`);
    for (const folder of root.folders) lines.push(`${sizeText(folder.mb)}  ${folder.path}`);
  }
  for (const note of report.notes) lines.push(note);
  return lines;
}

/** This function saves a report as JSON. It writes a new file and then renames it, so a reader does not get half a file. */
export async function saveReport(path: string, report: DiskReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const next = `${path}.${process.pid}.tmp`;
  await writeFile(next, `${JSON.stringify(report, null, 2)}\n`);
  await rename(next, path);
}

/** This function reads a saved report, or gives `null` when the file is absent or not valid. */
export function readReport(path: string): DiskReport | null {
  try {
    const report = JSON.parse(readFileSync(path, "utf8")) as Partial<DiskReport>;
    return report.version === 1 && Array.isArray(report.items) && report.summary !== undefined ? (report as DiskReport) : null;
  } catch {
    return null;
  }
}

/** This function reads the summary of the saved report for the dashboard, or gives `null`. */
export function readSummary(path: string): ReportSummary | null {
  return readReport(path)?.summary ?? null;
}

/** This function lists a folder for the tests and the cleanup. It gives no entries when the folder cannot be read. */
export async function listFolder(folder: string): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}
