/**
 * The gate of long native paths (H203). On Windows, a new process that maps a native image (`.node`, `.exe` or `.dll`)
 * with a long path can stop the computer with a bugcheck. The image-load callback of a driver gets the full NT path, for
 * example `\Device\HarddiskVolume3\git\app\node_modules\.pnpm\...\binding.node`. A path over MAX_PATH (260) is the risk.
 *
 * The hook (`hook-face.ts`) and `headroom run` refuse a command that runs node in a folder with a long native image. The
 * limit of the NT path of the longest image is 240, a margin under 260. The refusal gives the longest folder path that passes.
 *
 * - The longest image of a folder comes from a walk of each `node_modules` folder at and above it. The walk does not
 *   follow the links of pnpm, so it reads each package one time, in the store of the workspace.
 * - A cache keeps the result for each `node_modules` folder until its time of change (or the time of its `.pnpm`) changes.
 * - A worktree with a lockfile and no `node_modules` gets an estimate from the `node_modules` of its main checkout. Thus
 *   the gate also refuses `pnpm install` in a long folder, before the images exist.
 * - The hook has a time limit of 1 second. When a walk takes longer, the verdict uses a prior for the part of the path
 *   after the folder. The prior is the largest length that a walk measured, and at least {@link DEFAULT_RELATIVE}.
 *
 * The gate works only on Windows. On other systems, each check passes.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { expandHome, findFilesAsync, findUp, isInside, toPosix } from "@mark1russell7/files";
import { commandWords, SHELLS } from "./hook-rating.ts";
import { ASSIGNMENT, programName } from "./slots.ts";

/** The longest NT path of a native image that the gate lets go on: a margin of 20 under MAX_PATH (260). */
export const NATIVE_PATH_LIMIT = 240;
/** The length of the device part of the NT path of a drive, with a volume number of two digits: `\Device\HarddiskVolume12`. */
export const NT_DEVICE_LENGTH: number = "\\Device\\HarddiskVolume12".length;
/**
 * The prior for the length of the path of an image after the folder of its `node_modules`, when no walk measured it. The
 * walks of 11-18 measured 141 for a workspace of Vite 8 (the binding of rolldown). The prior adds a margin to that.
 */
export const DEFAULT_RELATIVE = 160;
/** The longest wait of the hook for a walk. The hook of Claude Code has a time limit of 1 second. */
export const HOOK_MEASURE_BUDGET_MS = 600;

/** The patterns of the native images: the modules of node, the programs and the libraries. */
const IMAGE_PATTERNS: readonly string[] = ["**/*.node", "**/*.exe", "**/*.dll"];
/** The lockfiles of the package managers of node. The folder of a lockfile is the folder of its `node_modules`. */
const LOCKFILES: readonly string[] = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"];

/** The programs that run node with the modules of the folder: package managers, runners, test runners and build tools. */
export const NODE_PROGRAMS: ReadonlySet<string> = new Set([
  "node",
  "npx",
  "npm",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "corepack",
  "tsx",
  "ts-node",
  "vite-node",
  "vitest",
  "vite",
  "jest",
  "playwright",
  "tsc",
  "tsgo",
  "tsdown",
  "tsup",
  "esbuild",
  "rolldown",
  "rollup",
  "webpack",
  "turbo",
  "nx",
  "eslint",
  "oxlint",
  "biome",
  "prettier",
  "astro",
  "next",
  "electron",
  "wrangler",
  "changeset",
]);
/** The subcommands of git that run the hooks of the repository. A hook of a node project runs node. */
const GIT_HOOK_COMMANDS: ReadonlySet<string> = new Set(["commit", "push", "merge", "rebase", "am", "checkout", "switch", "pull", "cherry-pick", "revert"]);
/** The programs that change the current folder of a shell. */
const FOLDER_CHANGERS: ReadonlySet<string> = new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);
/** The words before a program that run it: `env`, `time` and similar. */
const PREFIXES: ReadonlySet<string> = new Set(["env", "time", "nice", "nohup", "exec", "command"]);
/** The options that give the folder of a command: `pnpm -C`, `npm --prefix`, `git -C` and similar. */
const FOLDER_OPTIONS: ReadonlySet<string> = new Set(["-C", "--dir", "--prefix", "--cwd", "--root"]);
/** A script of node: node reads the modules of its folder and of each folder above it. */
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

/**
 * This function gives the length of the NT path of a Windows path: the path that the image-load callback of a driver gets.
 * The device part has the length of a volume number of two digits, so the result is at least the real length.
 */
export function ntPathLength(path: string): number {
  const windows = path.replaceAll("/", "\\").replace(/^\\\\\?\\/, "");
  if (/^[A-Za-z]:(?:\\|$)/.test(windows)) return NT_DEVICE_LENGTH + windows.length - 2;
  if (windows.startsWith("\\\\")) return "\\Device\\Mup".length + windows.length - 1;
  return NT_DEVICE_LENGTH + windows.length;
}

/** This function gives the longest Windows path of a folder that passes the limit with images of `relativeLength` after it. */
export function longestRootThatPasses(relativeLength: number, limit: number = NATIVE_PATH_LIMIT): number {
  return limit - (NT_DEVICE_LENGTH - 2) - 1 - relativeLength;
}

/** This function joins the words of a command line. A word with a space or a quote gets quotes. */
export function joinWords(words: readonly string[]): string {
  return words.map((word) => (word === "" || /[\s"']/.test(word) ? (word.includes('"') ? `'${word}'` : `"${word}"`) : word)).join(" ");
}

/** This function tells if the words of a part run node with the modules of a folder. */
function runsNode(words: readonly string[]): boolean {
  const first = words[0] ?? "";
  const program = programName(first);
  if (NODE_PROGRAMS.has(program) || /(?:^|[\\/])node_modules[\\/]/.test(first) || SCRIPT_FILE.test(first)) return true;
  if (program !== "git") return false;
  for (let at = 1; at < words.length; at++) {
    const word = words[at] ?? "";
    if (word === "-C" || word === "-c") at++;
    else if (!word.startsWith("-")) return GIT_HOOK_COMMANDS.has(word);
  }
  return false;
}

/**
 * This function gives the folders where a command line runs node. Each part that runs node gives its current folder,
 * after each `cd` or `Set-Location` before it. An option for a folder (for example `-C`) gives its folder. A path with
 * `node_modules` gives the folder above it, and an absolute script gives its folder. The function also reads the script
 * of a shell (`bash -c`) and the command of `headroom run` after `--`. `cwd` is the folder of the line. A relative
 * folder with no `cwd` does not count.
 */
export function foldersOfCommand(command: string, cwd: string | null, home: string = homedir()): string[] {
  const folders = new Set<string>();
  let here = cwd;
  const place = (path: string): string | null => {
    const expanded = expandHome(path, home);
    if (isAbsolute(expanded)) return resolve(expanded);
    return here === null ? null : resolve(here, expanded);
  };
  const add = (path: string | null): void => {
    if (path !== null) folders.add(path);
  };
  const visit = (line: string, depth: number): void => {
    for (const all of commandWords(line)) {
      let start = 0;
      while (start < all.length && (ASSIGNMENT.test(all[start] ?? "") || PREFIXES.has(programName(all[start] ?? "")))) start++;
      const words = all.slice(start);
      const program = programName(words[0] ?? "");
      if (program === "") continue;
      if (FOLDER_CHANGERS.has(program)) {
        const target = words.slice(1).find((word) => !word.startsWith("-") && !/^\/d$/i.test(word));
        if (target === undefined) here = home;
        else if (target !== "-") here = place(target);
        continue;
      }
      const option = SHELLS.get(program);
      if (option !== undefined) {
        const at = words.findIndex((word, index) => index > 0 && option.test(word));
        const script = at < 0 ? undefined : words[at + 1];
        if (script !== undefined && depth < 3) visit(script, depth + 1);
        continue;
      }
      if (program === "headroom") {
        const dash = words.indexOf("--");
        if (dash >= 0 && depth < 3) visit(joinWords(words.slice(dash + 1)), depth + 1);
        continue;
      }
      if (!runsNode(words)) continue;
      let folder = here;
      for (let at = 1; at < words.length; at++) {
        const word = words[at] ?? "";
        const joined = /^--(?:dir|prefix|cwd|root)=(.+)$/.exec(word)?.[1];
        const value = FOLDER_OPTIONS.has(word) ? words[++at] : joined;
        if (value !== undefined) {
          folder = place(value);
          continue;
        }
        const cut = word.replaceAll("\\", "/").search(/(?:^|\/)node_modules(?:\/|$)/);
        if (cut >= 0) add(place(word.slice(0, cut) || "."));
        else if (SCRIPT_FILE.test(word) && isAbsolute(expandHome(word, home))) add(dirname(place(word) ?? word));
      }
      const first = words[0] ?? "";
      const cut = first.replaceAll("\\", "/").search(/(?:^|\/)node_modules(?:\/|$)/);
      if (cut > 0) add(place(first.slice(0, cut)));
      add(folder);
    }
  };
  visit(command, 0);
  return [...folders];
}

/** The result of the walk of one `node_modules` folder. */
export interface ImageMeasure {
  /** The real path of the folder that holds `node_modules`. */
  readonly root: string;
  /** The longest path of a native image under `node_modules`, or `null` when the folder holds none. */
  readonly longest: string | null;
}

/** A folder whose longest native image has an NT path over the limit. */
export interface LongPath {
  /** The folder where the command runs node, or the folder of its lockfile. */
  readonly root: string;
  /** The path of the image: measured, or from the main checkout. `null` for an estimate from the prior. */
  readonly image: string | null;
  /** The length of the NT path of the image. */
  readonly ntLength: number;
  /** The length of the path of the image after the folder of its `node_modules`. */
  readonly relativeLength: number;
  /** The source of the length: a walk of the folder, a walk of the main checkout, or the prior. */
  readonly basis: "measured" | "main checkout" | "prior";
  /** The main checkout of a worktree, else the folder of the repository. The refusal names a short folder next to it. */
  readonly mainCheckout: string | null;
  readonly limit: number;
}

/** The options of {@link NativeImages}. The tests set them. */
export interface NativeImagesOptions {
  /** This function gives the native images under a `node_modules` folder. The default is a walk with `findFilesAsync`. */
  readonly find?: ((nodeModules: string) => Promise<readonly string[]>) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly limit?: number | undefined;
  readonly defaultRelative?: number | undefined;
}

/** One measure in the cache: the time of change of its folder, and the walk. */
interface Entry {
  readonly signature: string;
  readonly done: Promise<ImageMeasure | null>;
  result: ImageMeasure | null;
}

/** One length to compare with the limit: a measure that can finish later, or the prior. */
interface Candidate {
  readonly root: string;
  readonly basis: LongPath["basis"];
  readonly entry: Entry | null;
  readonly mainCheckout: string | null;
}

/** This function gives the walk of a `node_modules` folder: each native image, with no link followed. */
function walkImages(nodeModules: string): Promise<readonly string[]> {
  return findFilesAsync({ root: nodeModules, include: IMAGE_PATTERNS, skip: [] });
}

/** This function gives the real path of a folder, or the folder when the real path cannot be read. */
function realFolder(folder: string): string {
  try {
    return realpathSync.native(folder);
  } catch {
    return folder;
  }
}

/** This function tells if a path is a folder. */
function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** This function gives the main checkout of a worktree from its `.git` file, or `null` for a main checkout or a bad file. */
export function mainCheckoutOf(git: string): string | null {
  try {
    if (!statSync(git).isFile()) return null;
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, "utf8"))?.[1]?.trim();
    if (pointer === undefined) return null;
    const target = toPosix(resolve(dirname(git), pointer), "\\");
    return /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(target)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** This function gives the folder of the nearest lockfile of node at or above a folder, inside `top` when it is not `null`. */
function lockRootOf(folder: string, top: string | null): string | null {
  const found = LOCKFILES.map((name) => findUp(name, folder)).filter((path): path is string => path !== null && (top === null || isInside(top, path)));
  const nearest = found.sort((a, b) => b.length - a.length)[0];
  return nearest === undefined ? null : dirname(nearest);
}

/**
 * The cache of the native images of the folders (H203). The daemon keeps one, and the hook and the procedure
 * `resources native` read it. A client with no daemon makes its own.
 */
export class NativeImages {
  readonly limit: number;
  private readonly entries = new Map<string, Entry>();
  private readonly find: (nodeModules: string) => Promise<readonly string[]>;
  private readonly platform: NodeJS.Platform;
  private largestRelative: number;

  constructor(options: NativeImagesOptions = {}) {
    this.limit = options.limit ?? NATIVE_PATH_LIMIT;
    this.find = options.find ?? walkImages;
    this.platform = options.platform ?? process.platform;
    this.largestRelative = options.defaultRelative ?? DEFAULT_RELATIVE;
  }

  /** The prior for the length of the path of an image after its folder: the largest length measured, and at least the default. */
  get prior(): number {
    return this.largestRelative;
  }

  /** This function gives the measure of the folder `root` (a real path) that holds `node_modules`, from the cache when it is current. */
  private entry(root: string): Entry {
    const nodeModules = join(root, "node_modules");
    let signature = "none";
    try {
      const store = join(nodeModules, ".pnpm");
      signature = String(statSync(existsSync(store) ? store : nodeModules).mtimeMs);
    } catch {
      // The folder went away. The walk finds no image.
    }
    const known = this.entries.get(root);
    if (known !== undefined && known.signature === signature) return known;
    const done = this.find(nodeModules).then(
      (images): ImageMeasure => {
        const longest = images.reduce<string | null>((best, path) => (best === null || path.length > best.length ? path : best), null);
        if (longest !== null) this.largestRelative = Math.max(this.largestRelative, longest.length - root.length - 1);
        const measure = { root, longest };
        entry.result = measure;
        return measure;
      },
      () => {
        // A failed walk leaves no result, so the next check walks again.
        if (this.entries.get(root) === entry) this.entries.delete(root);
        return null;
      },
    );
    const entry: Entry = { signature, done, result: null };
    this.entries.set(root, entry);
    return entry;
  }

  /** This function gives the lengths to compare for one folder: its `node_modules` folders, and its lockfile with no install. */
  private candidates(folder: string): Candidate[] {
    const git = findUp(".git", folder);
    const top = git === null ? null : dirname(git);
    const main = git === null ? null : mainCheckoutOf(git);
    // The checkout that names the short folder of the refusal: the main checkout of a worktree, else the repository.
    const mainCheckout = main ?? (top === null ? null : toPosix(top, "\\"));
    const list: Candidate[] = [];
    const roots = new Set<string>();
    for (let at = resolve(folder); ; at = dirname(at)) {
      if (isFolder(join(at, "node_modules"))) {
        const root = realFolder(at);
        roots.add(root);
        list.push({ root, basis: "measured", entry: this.entry(root), mainCheckout });
      }
      if (dirname(at) === at) break;
    }
    const lockRoot = lockRootOf(folder, top);
    if (lockRoot === null || roots.has(realFolder(lockRoot))) return list;
    // A lockfile with no install: the images come with the install. The main checkout of a worktree gives their length.
    const mainRoot = main === null || top === null ? null : join(main, relative(top, lockRoot));
    const measured = mainRoot !== null && isFolder(join(mainRoot, "node_modules"));
    list.push({ root: lockRoot, basis: measured ? "main checkout" : "prior", entry: measured && mainRoot !== null ? this.entry(realFolder(mainRoot)) : null, mainCheckout });
    return list;
  }

  /**
   * This function gives the folder with the longest native image over the limit, or `null` when each image passes. A
   * walk that does not end within `budgetMs` counts with the prior.
   */
  async check(folders: readonly string[], budgetMs: number = Number.POSITIVE_INFINITY): Promise<LongPath | null> {
    if (this.platform !== "win32" || folders.length === 0) return null;
    const candidates = folders.flatMap((folder) => this.candidates(folder));
    const pending = candidates.flatMap((candidate) => (candidate.entry !== null && candidate.entry.result === null ? [candidate.entry.done] : []));
    if (pending.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      const walks = Promise.allSettled(pending);
      await (Number.isFinite(budgetMs) ? Promise.race([walks, new Promise<void>((done) => (timer = setTimeout(done, budgetMs)))]) : walks);
      clearTimeout(timer);
    }
    let worst: LongPath | null = null;
    for (const candidate of candidates) {
      const long = this.lengthOf(candidate);
      if (long !== null && long.ntLength > this.limit && (worst === null || long.ntLength > worst.ntLength)) worst = long;
    }
    return worst;
  }

  /** This function gives the length of one candidate: from its walk, or from the prior when the walk has no result. */
  private lengthOf(candidate: Candidate): LongPath | null {
    const result = candidate.entry?.result ?? null;
    const base = { root: candidate.root, mainCheckout: candidate.mainCheckout, limit: this.limit };
    if (result === null) {
      const relativeLength = this.largestRelative;
      return { ...base, image: null, ntLength: ntPathLength(candidate.root) + 1 + relativeLength, relativeLength, basis: "prior" };
    }
    if (result.longest === null) return null;
    const relativeLength = result.longest.length - result.root.length - 1;
    if (candidate.basis === "measured") return { ...base, image: result.longest, ntLength: ntPathLength(result.longest), relativeLength, basis: "measured" };
    return { ...base, image: result.longest, ntLength: ntPathLength(candidate.root) + 1 + relativeLength, relativeLength, basis: "main checkout" };
  }
}

/** This function gives the text of the refusal of a command for a long native path. It names a folder that passes. */
export function longPathRefusal(long: LongPath): string {
  const why =
    long.basis === "measured"
      ? `Its longest native image has an NT path of ${long.ntLength} characters: ${long.image ?? ""}.`
      : long.basis === "main checkout"
        ? `After an install, its longest native image gets an NT path of ${long.ntLength} characters (from the main checkout: ${long.image ?? ""}).`
        : `No walk measured its native images yet. With the usual ${long.relativeLength} characters after the folder, the longest gets an NT path of ${long.ntLength} characters.`;
  const most = longestRootThatPasses(long.relativeLength, long.limit);
  const sample = long.mainCheckout === null ? null : `${toPosix(dirname(long.mainCheckout), "\\")}/${basename(long.mainCheckout)}-wt/<name>`;
  const example = sample !== null && sample.length + 8 <= most ? `, for example ${sample}` : "";
  return (
    `headroom: this command runs node in ${long.root}. ${why} The limit is ${long.limit}. On Windows, a process that maps a native ` +
    `image with a path over 260 characters can stop the computer. Run the command in a folder with a path of at most ${most} characters${example}.`
  );
}

/** The input of the procedure `resources native`, and of the check of `headroom run`. */
export interface NativeInput {
  readonly command: string;
  readonly cwd: string | null;
  readonly budgetMs?: number | undefined;
}

/** This function gives the refusal of a command line for a long native path, or `null` when the command can go on. */
export async function nativeRefusal(images: NativeImages, input: NativeInput): Promise<string | null> {
  const long = await images.check(foldersOfCommand(input.command, input.cwd), input.budgetMs);
  return long === null ? null : longPathRefusal(long);
}

/**
 * This function gives the refusal of the command of `headroom run`. It asks the daemon, which keeps the cache. A daemon
 * of an older version, or no daemon, gives no answer: then the client walks the folders itself.
 */
export async function runRefusal(
  argv: readonly string[],
  cwd: string,
  ask: ((input: NativeInput) => Promise<{ readonly refusal: string | null }>) | null,
  local: () => NativeImages = () => new NativeImages(),
): Promise<string | null> {
  const input = { command: joinWords(argv), cwd };
  if (ask !== null) {
    const answer = await ask(input).catch(() => null);
    if (answer !== null && (typeof answer.refusal === "string" || answer.refusal === null)) return answer.refusal;
  }
  return nativeRefusal(local(), input);
}
