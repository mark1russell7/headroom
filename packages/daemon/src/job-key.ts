/**
 * The typed key of a job (H78). The client of `headroom run` reads it from the command and from the files of the folder
 * of the command, and sends it with the request. The core matches only the fields of the key: it does not parse a
 * command. Thus the ladder of `--mem auto` finds the past runs of the same kind, repository, lockfile and package for a
 * job with a new name.
 *
 * The mapper lives in the CLI until H79 moves it to the procedure layer, where each client of the broker can use it.
 *
 * `jobKey` is pure. `readFacts` reads the facts of a folder with `node:fs` only: it starts no process, not git either.
 * The kinds of the browser tests come from `autoSlots` of `slots.ts`, so one classifier decides the browser slot and the
 * kind `browser`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { JobKey, JobKind, Suggestion } from "@headroom/core";
import { findUp, isInside, toPosix } from "@mark1russell7/files";
import { sha256Hex } from "@mark1russell7/rigor-generators";
import { ASSIGNMENT, autoSlots, PART_END, programName, VALUE_OPTIONS } from "./slots.ts";

/** The facts of the folder of a command, from its files. A fact that the folder does not have is `null`. */
export interface FolderFacts {
  /** The name of the git repository. A worktree gives the name of its main repository. */
  readonly repo: string | null;
  /** The first 16 hex characters of the SHA-256 of the lockfile. */
  readonly lock: string | null;
  /** The count of the entries in the packages section of the lockfile. */
  readonly packages: number | null;
  /** True when `node_modules` exists next to the lockfile, or at the repository root with no lockfile. */
  readonly warm: boolean | null;
  /** The folder of the nearest `package.json`, relative to the repository root, with `/`. The root is `.`. */
  readonly folder: string | null;
}

/** The facts of a folder with no repository and no lockfile. */
export const NO_FACTS: FolderFacts = { repo: null, lock: null, packages: null, warm: null, folder: null };

/**
 * The order of the kinds for a line with more than one command. The kind of the line is the first kind of a part in this
 * order. The order goes from the kind with the highest median peak to the kind with the lowest. The medians come from
 * the 7316 leases with a peak in the 7 days before 2026-11-16, with the kind from the job text. They are: browser
 * 2707 MB, build 530 MB, test 460 MB, typecheck 414 MB, install 380 MB, lint 236 MB. `other` comes last, because it is no kind: a line
 * with a part of a known kind takes that kind.
 */
const KIND_ORDER: readonly JobKind[] = ["browser", "build", "test", "typecheck", "install", "lint", "other"];

/** The commands of a package manager that install packages. */
const INSTALL_WORDS: ReadonlySet<string> = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "fetch", "dedupe", "rebuild", "import"]);

/** The package managers. Each one starts a script by its name, with or without `run`. */
const MANAGERS: ReadonlySet<string> = new Set(["pnpm", "npm", "yarn", "bun"]);

/** The programs that run a package by its name. */
const RUNNERS: ReadonlySet<string> = new Set(["npx", "pnpx", "bunx"]);

/** The programs that run a script file. */
const SCRIPT_HOSTS: ReadonlySet<string> = new Set(["node", "tsx", "deno"]);

/** The programs that start the program of their arguments, with their own options and numbers before it. */
const WRAPPERS: ReadonlySet<string> = new Set(["time", "timeout", "nice", "cross-env", "env", "c8", "nyc"]);

/** The options of Node.js that take the next word as their value. */
const NODE_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file", "--input-type"]);

/** The kind of each program by its name. */
const PROGRAM_KINDS: ReadonlyMap<string, JobKind> = new Map<string, JobKind>([
  ...["vitest", "jest", "mocha", "ava", "uvu", "tap"].map((name): [string, JobKind] => [name, "test"]),
  ...["tsc", "tsgo", "vue-tsc", "svelte-check"].map((name): [string, JobKind] => [name, "typecheck"]),
  ...["tsup", "tsdown", "esbuild", "rollup", "rolldown", "webpack", "unbuild", "parcel"].map((name): [string, JobKind] => [name, "build"]),
  ...["eslint", "prettier", "biome", "oxlint", "ste-lint", "markdownlint", "markdownlint-cli2", "stylelint", "dprint", "knip", "conventions", "boundaries", "api-report"].map(
    (name): [string, JobKind] => [name, "lint"],
  ),
]);

/** The programs that build only with the word `build`, for example `vite build`. Without it, they serve. */
const BUILD_WITH_WORD: ReadonlySet<string> = new Set(["vite", "next", "nuxt", "astro", "turbo", "nx"]);

/** The kind of a script by its name, for example `test:unit` or `typecheck`. The first match counts. */
const SCRIPT_KINDS: readonly (readonly [RegExp, JobKind])[] = [
  [/^(?:test|tests|spec|vitest|jest)(?:$|[:\-_.])/i, "test"],
  [/^(?:typecheck|type-check|types|tsc|check[:\-_]types?)(?:$|[:\-_.])/i, "typecheck"],
  [/^build(?:$|[:\-_.])/i, "build"],
  [/^(?:lint|format|fmt|prettier|eslint|ste)(?:$|[:\-_.])|^check[:\-_]/i, "lint"],
  [/^(?:install|bootstrap|deps)(?:$|[:\-_.])/i, "install"],
];

/**
 * The kind of each word of a job name, for example `alerts-sources-test` or `h78-typecheck`. Only a job text of one word
 * uses them. `headroom report leases` derives the kind of a lease of an older client from its job text. An older
 * client sent the name of `--job` as the job text.
 */
const NAME_WORDS: ReadonlyMap<string, JobKind> = new Map<string, JobKind>([
  ...["e2e", "playwright", "browser", "cypress"].map((word): [string, JobKind] => [word, "browser"]),
  ...["test", "tests", "vitest", "jest", "spec"].map((word): [string, JobKind] => [word, "test"]),
  ...["build"].map((word): [string, JobKind] => [word, "build"]),
  ...["install", "deps"].map((word): [string, JobKind] => [word, "install"]),
  ...["typecheck", "tsc", "types"].map((word): [string, JobKind] => [word, "typecheck"]),
  ...["lint", "ste", "prettier", "eslint", "format", "conventions", "boundaries"].map((word): [string, JobKind] => [word, "lint"]),
]);

/** A shell that runs the script of its `-c` option, for example `sh -c "pnpm build && pnpm test"`. */
const SHELL_SCRIPT = /^\s*(?:\S*[\\/])?(?:sh|bash|zsh|dash)(?:\.exe)?\s+-[a-z]*c\s+([\s\S]*)$/i;
/** The shell of Windows with a command: `cmd /c ...`. */
const CMD_SCRIPT = /^\s*(?:\S*[\\/])?cmd(?:\.exe)?\s+\/[ck]\s+([\s\S]*)$/i;
/** PowerShell with a command: `pwsh -Command ...`. */
const POWERSHELL_SCRIPT = /^\s*(?:\S*[\\/])?(?:pwsh|powershell)(?:\.exe)?\s+(?:-\S+\s+)*?-(?:c|command)\s+([\s\S]*)$/i;
/** A change of the folder at the start of a line: `cd packages/core && ...`. */
const LEADING_CD = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/;

/** A UUID. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** A hex id of 7 or more characters, with a digit and a letter, for example a commit or a lease id. */
const HEX_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi;
/** An absolute path: a drive letter, or a `/` at the start of a word with two parts or more. */
const ABSOLUTE_PATH = /(?:\b[A-Za-z]:[\\/]|(?<![\w.~-])\/(?=[^\s/]+\/))[^\s"'`,;|&<>]*/g;
/** A folder of temporary files in a path. */
const TEMP_FOLDER = /[\\/](?:temp|tmp)[\\/]/i;

/** This function takes one pair of quotes from the start and the end of a text. */
function unquote(text: string): string {
  const trimmed = text.trim();
  return /^(["']).*\1$/s.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/** This function gives the script of a shell line (`sh -c`, `cmd /c`, `pwsh -Command`), or the line itself. */
export function scriptOf(text: string): string {
  for (const pattern of [SHELL_SCRIPT, CMD_SCRIPT, POWERSHELL_SCRIPT]) {
    const found = pattern.exec(text);
    if (found?.[1] !== undefined) return unquote(found[1]);
  }
  return text;
}

/**
 * This function gives the name of a program from a word. A path in `node_modules` gives the name of its bin: the file in
 * `.bin` or in the `bin` folder of the package (`typescript/bin/tsc` is `tsc`). Else it gives the name of the package.
 */
function programOf(word: string): string {
  const path = word.replace(/\\/g, "/");
  const at = path.lastIndexOf("node_modules/");
  if (at < 0) return programName(word);
  const parts = path.slice(at + "node_modules/".length).split("/");
  if (parts[0] === ".bin") return programName(parts[1] ?? "");
  const scoped = parts[0]?.startsWith("@") === true;
  const rest = parts.slice(scoped ? 2 : 1);
  if (rest[0] === "bin" && rest.length === 2) return programName(rest[1] ?? "");
  return (parts[scoped ? 1 : 0] ?? "").toLowerCase();
}

/** This function skips the options at the start of a list of words. An option of `values` takes the next word too. */
function skipOptions(words: readonly string[], values: ReadonlySet<string> = VALUE_OPTIONS): readonly string[] {
  let at = 0;
  while (at < words.length && (words[at] ?? "").startsWith("-")) at += values.has(words[at] ?? "") ? 2 : 1;
  return words.slice(at);
}

/** The value options of a package manager. For pnpm, `-w` is `--workspace-root`, with no value. */
function managerValues(manager: string): ReadonlySet<string> {
  return manager === "pnpm" ? new Set([...VALUE_OPTIONS].filter((option) => option !== "-w")) : VALUE_OPTIONS;
}

/** This function gives the kind of a script by its name. */
function scriptKind(script: string): JobKind {
  return SCRIPT_KINDS.find(([pattern]) => pattern.test(script))?.[1] ?? "other";
}

/** This function gives the kind of the words of a package manager after its name, for example `run test` or `install`. */
function managerKind(manager: string, rest: readonly string[], depth: number): JobKind {
  const args = skipOptions(rest, managerValues(manager));
  const [sub, ...more] = args;
  if (sub === undefined) return manager === "yarn" ? "install" : "other";
  if (INSTALL_WORDS.has(sub)) return "install";
  if (sub === "test" || sub === "t" || sub === "tst") return "test";
  if (sub === "exec" || sub === "dlx" || sub === "x") return programKind(skipOptions(more), depth + 1);
  if (sub === "run" || sub === "run-script") {
    const [script] = skipOptions(more);
    return script === undefined ? "other" : scriptKind(script);
  }
  if (manager === "npm") return "other";
  // pnpm, yarn and bun start a script or a bin by its name, for example `pnpm typecheck` or `pnpm vitest run`.
  const script = scriptKind(sub);
  return script !== "other" ? script : programKind(args, depth + 1);
}

/** This function gives the kind of the words of Node.js after its name: `--test`, or the kind of its script file. */
function scriptHostKind(rest: readonly string[], depth: number): JobKind {
  let at = 0;
  while (at < rest.length && (rest[at] ?? "").startsWith("-")) {
    const option = rest[at] ?? "";
    if (option.startsWith("--test")) return "test";
    if (option === "-e" || option === "--eval" || option === "-p" || option === "--print") return "other";
    at += NODE_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  if (rest.slice(at).includes("--test")) return "test";
  return at < rest.length ? programKind(rest.slice(at), depth + 1) : "other";
}

/** This function gives the kind of a list of words that starts with a program. */
function programKind(words: readonly string[], depth = 0): JobKind {
  const [first, ...rest] = words;
  if (first === undefined || depth > 8) return "other";
  const name = programOf(first);
  if (MANAGERS.has(name)) return managerKind(name, rest, depth);
  if (RUNNERS.has(name)) return programKind(skipOptions(rest), depth + 1);
  if (SCRIPT_HOSTS.has(name)) return scriptHostKind(rest, depth);
  if (BUILD_WITH_WORD.has(name)) return rest.includes("build") ? "build" : "other";
  return PROGRAM_KINDS.get(name) ?? "other";
}

/** This function gives the kind of one part of a line, after its variables and its wrappers (`timeout 280`, `cross-env`). */
function partKind(part: string): JobKind {
  const words = part.trim().split(/\s+/).filter((word) => word.length > 0).map(unquote);
  let at = 0;
  while (at < words.length) {
    const word = words[at] ?? "";
    if (ASSIGNMENT.test(word)) {
      at++;
      continue;
    }
    if (!WRAPPERS.has(programName(word))) break;
    at++;
    while (at < words.length && /^(?:-\S*|\d+(?:\.\d+)?[smhd]?|[A-Za-z_][A-Za-z0-9_]*=\S*)$/.test(words[at] ?? "")) at++;
  }
  return programKind(words.slice(at));
}

/** This function gives the kind of a job name of one word from its words, for example `alerts-sources-test`. */
function nameKind(name: string): JobKind {
  const kinds = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => NAME_WORDS.get(word.replace(/\d+$/, "")))
    .filter((kind): kind is JobKind => kind !== undefined);
  return KIND_ORDER.find((kind) => kinds.includes(kind)) ?? "other";
}

/**
 * This function gives the kind of a command line (H78). A line of more parts (`a && b`) takes the first kind of its
 * parts in `KIND_ORDER`. A line that runs browser tests (`autoSlots`) is `browser`. A text of one word that is no known
 * program is a job name, so its words give the kind.
 */
export function kindOf(text: string): JobKind {
  const script = scriptOf(text);
  if (autoSlots(script).length > 0) return "browser";
  const kinds = script.split(PART_END).map(partKind);
  const kind = KIND_ORDER.find((each) => kinds.includes(each)) ?? "other";
  const trimmed = script.trim();
  return kind === "other" && trimmed.length > 0 && !/\s/.test(trimmed) ? nameKind(trimmed) : kind;
}

/**
 * This function gives the package filter of a line. The filter is the sorted values of `--filter` and `-F` of pnpm,
 * and of `--workspace` and `-w` of npm. A space joins them. It gives `null` for a line with no filter.
 */
export function filterOf(text: string): string | null {
  const values = new Set<string>();
  for (const part of scriptOf(text).split(PART_END)) {
    const words = part.trim().split(/\s+/).filter((word) => !ASSIGNMENT.test(word));
    const manager = programOf(words[0] ?? "");
    const options = manager === "pnpm" ? ["--filter", "-F"] : manager === "npm" ? ["--workspace", "-w"] : [];
    for (let at = 0; at < words.length; at++) {
      const word = words[at] ?? "";
      for (const option of options) {
        if (word === option && at + 1 < words.length) values.add(unquote(words[at + 1] ?? ""));
        else if (word.startsWith(`${option}=`)) values.add(unquote(word.slice(option.length + 1)));
      }
    }
  }
  const sorted = [...values].filter((value) => value.length > 0).sort();
  return sorted.length === 0 ? null : sorted.join(" ").slice(0, 1000);
}

/** This function gives the text of an absolute path in a normal command: the name of its file, in a temporary folder or not. */
function pathWord(path: string): string {
  const name = basename(path.replace(/[\\/]+$/, "").replace(/\\/g, "/"));
  return `${TEMP_FOLDER.test(path) ? "<tmp>" : "<abs>"}/${name}`;
}

/**
 * This function gives the command text of a key: the line without its absolute paths, temporary folders and hex ids.
 * Thus the runs of a command from two worktrees or two scratchpads have one text. It keeps the name of each file.
 */
export function normalizeCommand(text: string): string {
  return text
    .replace(ABSOLUTE_PATH, pathWord)
    .replace(UUID, "<id>")
    .replace(HEX_ID, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * This function gives the folder of a command. It is the folder of a leading `cd`, then the folder of `-C`, `--dir`
 * or `--prefix` in the first part. Else the current folder.
 */
export function jobFolder(argv: readonly string[], cwd: string): string {
  const script = scriptOf(argv.join(" "));
  const cd = LEADING_CD.exec(script);
  const folder = cd?.[1] === undefined ? cwd : resolve(cwd, unquote(cd[1]));
  const first = (cd === null ? script : script.slice(cd[0].length)).split(PART_END)[0] ?? "";
  const words = first.trim().split(/\s+/);
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? "";
    if ((word === "-C" || word === "--dir" || word === "--prefix") && at + 1 < words.length) return resolve(folder, unquote(words[at + 1] ?? ""));
    const joined = /^--(?:dir|prefix)=(.+)$/.exec(word);
    if (joined?.[1] !== undefined) return resolve(folder, unquote(joined[1]));
  }
  return folder;
}

/** This function gives the name of the repository of a `.git` folder or file. A worktree gives its main repository. */
function repoName(git: string): string | null {
  const top = dirname(git);
  if (statSync(git).isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, "utf8"))?.[1]?.trim();
    if (pointer !== undefined) {
      const target = toPosix(resolve(top, pointer), "\\");
      const main = /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(target)?.[1];
      if (main !== undefined) return basename(main) || null;
    }
  }
  return basename(top) || null;
}

/** This function gives the nearest lockfile of pnpm or npm above a folder, inside the repository when there is one. */
function nearestLock(folder: string, top: string | null): string | null {
  const found = [findUp("pnpm-lock.yaml", folder), findUp("package-lock.json", folder)].filter(
    (path): path is string => path !== null && (top === null || isInside(top, path)),
  );
  return found.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * This function counts the entries of the packages section of a lockfile.
 *
 * Shortcut (tenet 3): for pnpm, it counts the lines of the keys under `packages:` with two spaces, and does not parse
 * the YAML. Reason: the YAML parser of the home (`@procedures/json`) is a procedure package with a large install, and the
 * CLI needs only a count. End: H79 moves the mapper to the procedure layer, where `@procedures/json` parses the file.
 */
export function countPackages(path: string, text: string): number | null {
  if (path.endsWith(".json")) {
    const lock = JSON.parse(text) as { packages?: Record<string, unknown>; dependencies?: Record<string, unknown> };
    if (lock.packages !== undefined) return Object.keys(lock.packages).filter((name) => name !== "").length;
    return lock.dependencies === undefined ? null : Object.keys(lock.dependencies).length;
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (start < 0) return null;
  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (/^ {2}\S.*:\s*$/.test(line)) count++;
  }
  return count;
}

/** This function gives the folder of a path relative to a root, with `/`. The root is `.`. */
function relativeFolder(root: string, folder: string): string {
  const path = toPosix(relative(root, folder), "\\");
  return path === "" ? "." : path;
}

/** This function reads the facts of a folder from its files (H78). It reads only files: it starts no process. */
export function readFacts(folder: string): FolderFacts {
  const git = findUp(".git", folder);
  const top = git === null ? null : dirname(git);
  const lock = nearestLock(folder, top);
  const root = lock === null ? top : dirname(lock);
  const text = lock === null ? null : readFileSync(lock, "utf8");
  const manifest = findUp("package.json", folder);
  const base = top ?? root;
  return {
    repo: git === null ? null : repoName(git),
    lock: text === null ? null : sha256Hex(text).slice(0, 16),
    packages: lock === null || text === null ? null : countPackages(lock, text),
    warm: root === null ? null : existsSync(join(root, "node_modules")),
    folder: manifest !== null && base !== null && isInside(base, manifest) ? relativeFolder(base, dirname(manifest)) : null,
  };
}

/** This function gives the key of a command from the facts of its folder (H78). It is pure. */
export function jobKey(argv: readonly string[], facts: FolderFacts): JobKey {
  const text = argv.join(" ");
  return {
    kind: kindOf(text),
    repo: facts.repo === null ? null : facts.repo.slice(0, 200),
    lock: facts.lock,
    filter: filterOf(text) ?? facts.folder,
    warm: facts.warm,
    packages: facts.packages,
    command: normalizeCommand(text),
  };
}

/**
 * This function gives the key of the command of `headroom run`, or `null` when a file cannot be read. A key is a help
 * for the amount: it does not stop a run.
 */
export function keyOfRun(argv: readonly string[], cwd: string): JobKey | null {
  try {
    return jobKey(argv, readFacts(jobFolder(argv, cwd)));
  } catch {
    return null;
  }
}

/** The words of each rung in the line of `--mem auto`. */
const RUNG_WORDS = {
  job: "of this job",
  key: "of the same key (kind, repository, lockfile and package)",
  repo: "of the same kind, repository and package (the lockfile changed)",
  fit: "of a fit on the count of packages over the repositories",
  kind: "of the same kind",
} as const;

/**
 * This function gives the line of `--mem auto` (H78). It names the rung and the count of runs. At the rung `none`, the
 * line says "no read", because the amount is the default and no run measured it. A daemon before H78 gives no rung.
 */
export function memoryAutoLine(suggestion: Pick<Suggestion, "memoryMb" | "runs" | "peakMb" | "rung" | "floor"> | null, key: JobKey | null, defaultMb: number, mb: (value: number) => string): string {
  const runs = (count: number): string => `${count} ${count === 1 ? "run" : "runs"}`;
  if (suggestion === null || suggestion.memoryMb === null || suggestion.memoryMb === undefined) {
    const what = key === null ? "this job" : `this job, its key or its kind (${key.kind})`;
    return `headroom: --mem auto gives ${mb(defaultMb)}: no read, because no run of ${what} has a peak yet.`;
  }
  // H215: the floor of the command gives the amount when the ladder gives less.
  const floor = suggestion.floor;
  if (floor !== undefined && suggestion.memoryMb === floor.floorMb) {
    return `headroom: --mem auto gives ${mb(floor.floorMb)}: the floor of this command, the peak of its last run (${mb(floor.run.peakMb)}, job ${floor.run.job}) times 1.1.`;
  }
  const rung = suggestion.rung ?? "job";
  const words = rung === "none" ? RUNG_WORDS.job : rung === "kind" && key !== null ? `of the kind ${key.kind}` : RUNG_WORDS[rung];
  return `headroom: --mem auto gives ${mb(suggestion.memoryMb)}, at the rung ${rung}: the peaks of ${runs(suggestion.runs)} ${words} (the highest ${mb(suggestion.peakMb ?? 0)}).`;
}
