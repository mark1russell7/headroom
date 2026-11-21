/**
 * The gate of links between checkouts (H223). A worktree whose `node_modules` is a link (a junction on Windows) to the
 * `node_modules` of its main checkout shares that folder. An install in the worktree then writes the links of the main
 * checkout, and they point into the worktree. A delete of the worktree breaks them, and the main checkout stops working.
 *
 * The gate has two lines, in the hook (`hook-face.ts`):
 *
 * 1. The first line refuses the install. An install of pnpm, npm, yarn or bun gets a refusal while a `node_modules`
 *    that it writes is a link into another checkout. The same check applies to its `.pnpm` store. The check reads only
 *    the `node_modules` of the folders from the install folder up to its checkout, and of the packages of its workspace.
 * 2. The second line refuses the delete. It refuses `git worktree remove` and a recursive delete of a folder while a
 *    link in another checkout of the repository points inside the folder. The recursive deletes are `rm -r`,
 *    `Remove-Item -Recurse` and its aliases, `rmdir /s` and `rimraf`. The refusal names the link. A recursive delete of a link into another
 *    checkout gets a refusal too, because `Remove-Item` of Windows PowerShell 5.1 follows a junction.
 *
 * `headroom worktree remove` and the cleanup of worktrees apply the second line too, with no time limit (`worktrees.ts`).
 *
 * The limits of the gate:
 *
 * - The read of the links of all the checkouts of a large repository takes more than a second when the file cache is
 *   cold. The hook waits at most {@link LINK_GATE_BUDGET_MS} for it. After that time, the gate refuses, and the read
 *   goes on in the daemon. A second try a few seconds later gets the links from a cache ({@link LinkCache}).
 * - The read finds `node_modules` at most two folders under each checkout and in each package of the workspace. It does
 *   not read the links in the `.pnpm` store.
 * - The gate reads only the command line. A script that starts an install or deletes a folder, and a path with a glob,
 *   are not checked. A delete of a folder that holds checkouts (for example the folder of all the worktrees of a
 *   repository) is not checked, because that folder is not in a checkout.
 */

import { homedir } from "node:os";
import { dirname } from "node:path";
import { installLinkRefusal, LinkCache, linkRefusal, linksInto, moduleFolders, nodeRunner, repoCheckouts, samePath, type ModuleLink, type WorktreeRunner } from "@headroom/core";
import { commandParts, placeFrom, type CommandPart } from "./native-paths.ts";
import { programName } from "./slots.ts";

/** The longest wait of the hook for the read of the links of the other checkouts of a repository. */
export const LINK_GATE_BUDGET_MS = 200;

/** The commands of each package manager that write `node_modules`. An empty name is the program with no command. */
const INSTALL_VERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["pnpm", new Set(["install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "link", "ln", "unlink", "dedupe", "prune", "import", "rebuild", "rb", "install-test", "it"])],
  [
    "npm",
    new Set([
      "install",
      "i",
      "in",
      "ins",
      "inst",
      "insta",
      "instal",
      "isnt",
      "isnta",
      "isntal",
      "isntall",
      "ci",
      "clean-install",
      "ic",
      "install-clean",
      "isntall-clean",
      "add",
      "uninstall",
      "remove",
      "rm",
      "r",
      "un",
      "unlink",
      "update",
      "up",
      "upgrade",
      "udpate",
      "link",
      "ln",
      "dedupe",
      "ddp",
      "prune",
      "rebuild",
      "rb",
      "install-test",
      "it",
      "install-ci-test",
      "cit",
    ]),
  ],
  ["yarn", new Set(["", "install", "add", "remove", "upgrade", "up", "link", "unlink", "dedupe"])],
  ["bun", new Set(["install", "i", "add", "a", "remove", "rm", "update", "link", "unlink"])],
]);
/** The options of a package manager that give the folder of the install. */
const FOLDER_VALUES: ReadonlySet<string> = new Set(["-C", "--dir", "--prefix", "--cwd"]);
/** The other options of the package managers that take a value. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(["--filter", "-F", "--filter-prod", "--loglevel", "--reporter", "--config", "--registry", "--store-dir", "--virtual-store-dir"]);
/** The options of npm that take a value, in addition to {@link VALUE_OPTIONS}. For pnpm, `-w` takes no value. */
const NPM_VALUE_OPTIONS: ReadonlySet<string> = new Set([...VALUE_OPTIONS, "-w", "--workspace"]);
/** The programs that start another program: `npx pnpm install` and `corepack pnpm install` are installs. */
const WRAPPERS: ReadonlySet<string> = new Set(["npx", "corepack", "bunx", "pnpx"]);
/** The options of the wrappers that take a value. */
const WRAPPER_VALUES: ReadonlySet<string> = new Set(["-p", "--package", "-c", "--call"]);
/** The names of `Remove-Item` in PowerShell. In bash, `rm` and `rmdir` are other programs, with other options. */
const REMOVE_ITEM: ReadonlySet<string> = new Set(["remove-item", "ri", "del", "erase", "rd", "rmdir", "rm"]);
/** The options of `Remove-Item` that take a value that is not a path. */
const REMOVE_ITEM_VALUES: ReadonlySet<string> = new Set(["-include", "-exclude", "-filter", "-credential", "-stream"]);
/** The options of `Remove-Item` that take a path. */
const REMOVE_ITEM_PATHS: ReadonlySet<string> = new Set(["-path", "-literalpath", "-lp", "-pspath"]);

/** How a part deletes its folders: `git worktree remove`, a recursive delete of a shell, or `rmdir /s` of cmd. */
export type DeleteKind = "worktree" | "shell" | "cmd";

/** The folders that one part of a command line deletes. */
export interface DeletePart {
  readonly kind: DeleteKind;
  readonly paths: readonly string[];
}

/** This function gives the words of a part with no wrapper: `npx pnpm@9 install` gives `pnpm install`. */
function unwrap(words: readonly string[]): readonly string[] {
  let rest = words;
  for (let depth = 0; depth < 2 && WRAPPERS.has(programName(rest[0] ?? "")); depth++) {
    let at = 1;
    while (at < rest.length && (rest[at] ?? "").startsWith("-")) at += WRAPPER_VALUES.has(rest[at] ?? "") ? 2 : 1;
    rest = rest.slice(at).map((word, index) => (index === 0 ? word.replace(/(.)@.*$/, "$1") : word));
  }
  return rest;
}

/**
 * This function gives the folder of an install of a part, or `undefined` when the part is not an install. A global
 * install (`-g`) is not an install in a folder. A relative folder with no current folder gives `null`.
 */
export function installFolder(part: CommandPart): string | null | undefined {
  const words = unwrap(part.words);
  const program = programName(words[0] ?? "");
  const verbs = INSTALL_VERBS.get(program);
  if (verbs === undefined) return undefined;
  const values = program === "npm" ? NPM_VALUE_OPTIONS : VALUE_OPTIONS;
  let folder = part.here;
  let verb: string | undefined;
  for (let at = 1; at < words.length; at++) {
    const word = words[at] ?? "";
    if (word === "-g" || word === "--global" || word === "--location=global") return undefined;
    const joined = /^--(?:dir|prefix|cwd)=(.+)$/.exec(word)?.[1];
    if (joined !== undefined) folder = part.place(joined);
    else if (FOLDER_VALUES.has(word)) {
      const value = words[++at];
      if (value !== undefined) folder = part.place(value);
    } else if (values.has(word)) at++;
    else if (!word.startsWith("-") && verb === undefined) verb = word;
  }
  return verbs.has(verb ?? "") ? folder : undefined;
}

/** This function tells if a word asks for a recursive delete: `-r`, `-rf`, `--recursive`, or a prefix of `-Recurse`. */
function recursive(word: string): boolean {
  if (/^-[fRrvdiI]*[rR][fRrvdiI]*$/.test(word) || word === "--recursive") return true;
  const lower = word.toLowerCase();
  return lower.length >= 3 && "-recurse".startsWith(lower);
}

/** This function gives the paths of the words of a delete. A path with a glob does not count. */
function placed(part: CommandPart, paths: readonly string[]): string[] {
  return paths.filter((path) => !/[*?[]/.test(path)).flatMap((path) => part.place(path) ?? []);
}

/** This function gives the folders that a part deletes, or `undefined` when the part deletes no folder. */
export function deleteTargets(part: CommandPart, home: string = homedir()): DeletePart | undefined {
  const words = unwrap(part.words);
  const program = programName(words[0] ?? "");
  if (program === "git") {
    let base = part;
    let at = 1;
    for (; at < words.length; at++) {
      const word = words[at] ?? "";
      if (word === "-C") {
        const folder = base.place(words[++at] ?? ".");
        base = { ...base, here: folder, place: placeFrom(folder, home) };
      } else if (word === "-c") at++;
      else if (!word.startsWith("-")) break;
    }
    if (words[at] !== "worktree" || words[at + 1] !== "remove") return undefined;
    const path = words.slice(at + 2).find((word) => !word.startsWith("-"));
    return path === undefined ? undefined : { kind: "worktree", paths: placed(base, [path]) };
  }
  if (program === "rimraf") return { kind: "shell", paths: placed(part, words.slice(1).filter((word) => !word.startsWith("-"))) };
  const cmdSwitch = (word: string): boolean => /^\/[a-z?]$/i.test(word);
  if ((program === "rmdir" || program === "rd") && words.some((word) => /^\/s$/i.test(word))) {
    return { kind: "cmd", paths: placed(part, words.slice(1).filter((word) => !cmdSwitch(word))) };
  }
  if (!REMOVE_ITEM.has(program) || !words.slice(1).some(recursive)) return undefined;
  const paths: string[] = [];
  for (let at = 1; at < words.length; at++) {
    const word = words[at] ?? "";
    const lower = word.toLowerCase();
    if (REMOVE_ITEM_PATHS.has(lower)) paths.push(...(words[++at] ?? "").split(",").filter((path) => path !== ""));
    else if (REMOVE_ITEM_VALUES.has(lower)) at++;
    else if (!word.startsWith("-")) paths.push(...word.split(",").filter((path) => path !== ""));
  }
  return { kind: "shell", paths: placed(part, paths) };
}

/**
 * This function tells if the links of other checkouts can point into a folder of the checkout `top`. Such a folder is the
 * checkout, a `node_modules` folder or a folder in one, or a folder that holds a `node_modules`. A package of the
 * workspace is such a folder. An install writes links only to those places. Thus a delete of `dist` or `coverage` reads no links.
 */
export function holdsLinkTargets(target: string, top: string, runner: WorktreeRunner, platform: NodeJS.Platform = process.platform): boolean {
  if (samePath(target, top, platform) || /(?:^|[\\/])node_modules(?:[\\/]|$)/.test(target)) return true;
  return moduleFolders(target, runner).length > 0;
}

/** The options of the gate. Each has a default for the daemon. */
export interface LinkGateOptions {
  readonly runner?: WorktreeRunner | undefined;
  readonly cache?: LinkCache | undefined;
  readonly budgetMs?: number | undefined;
  readonly home?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly now?: (() => number) | undefined;
  /** This function lets other work of the daemon go on between the reads of two checkouts. */
  readonly pause?: (() => Promise<void>) | undefined;
}

/** The gate of links between checkouts (H223). One gate keeps its cache of links for the life of the daemon. */
export class LinkGate {
  readonly #runner: WorktreeRunner;
  readonly #cache: LinkCache;
  readonly #budgetMs: number;
  readonly #home: string;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;
  readonly #pause: () => Promise<void>;
  readonly #reading = new Set<string>();

  constructor(options: LinkGateOptions = {}) {
    this.#runner = options.runner ?? nodeRunner();
    this.#now = options.now ?? Date.now;
    this.#cache = options.cache ?? new LinkCache(this.#runner, this.#now);
    this.#budgetMs = options.budgetMs ?? LINK_GATE_BUDGET_MS;
    this.#home = options.home ?? homedir();
    this.#platform = options.platform ?? process.platform;
    this.#pause = options.pause ?? (() => new Promise((resolve) => setImmediate(resolve)));
  }

  /** This function gives the refusal of a command line in its folder, or `null`. */
  async refusal(command: string, cwd: string | null): Promise<string | null> {
    const started = this.#now();
    for (const part of commandParts(command, cwd, this.#home)) {
      const folder = installFolder(part);
      if (folder !== undefined) {
        const refused = folder === null ? null : installLinkRefusal(folder, this.#runner, this.#platform);
        if (refused !== null) return `headroom: ${refused}`;
        continue;
      }
      const deleted = deleteTargets(part, this.#home);
      for (const target of deleted?.paths ?? []) {
        const refused = await this.#deleteRefusal(target, deleted?.kind ?? "shell", started);
        if (refused !== null) return `headroom: ${refused}`;
      }
    }
    return null;
  }

  /** This function gives the refusal of the delete of one folder, or `null`. */
  async #deleteRefusal(target: string, kind: DeleteKind, started: number): Promise<string | null> {
    const runner = this.#runner;
    const platform = this.#platform;
    const what = runner.stat(target)?.kind;
    if (what === undefined || what === "file") return null;
    if (what === "link") {
      // git does not remove a link as a worktree. For rmdir /s of cmd, the safe form with no /s is also the advice.
      if (kind === "worktree") return null;
      const to = runner.readLink(target);
      const own = repoCheckouts(dirname(target), runner)?.top ?? null;
      const fix = ` Remove only the link: cmd /c rmdir "${target}", with no /s.`;
      if (to === null) return `headroom cannot read the link ${target}, so it cannot tell what a recursive delete of it deletes.${fix}`;
      const other = repoCheckouts(to, runner)?.top ?? null;
      if (other === null || (own !== null && samePath(other, own, platform))) return null;
      return `${target} is a link to ${to}, in the checkout ${other}. A recursive delete can follow the link (Remove-Item of Windows PowerShell 5.1 does) and delete the files of ${other}.${fix}`;
    }
    const repo = repoCheckouts(target, runner);
    if (repo === null || !holdsLinkTargets(target, repo.top, runner, platform)) return null;
    const others = repo.checkouts.filter((checkout) => !samePath(checkout, repo.top, platform));
    const links: ModuleLink[] = [];
    for (const [index, checkout] of others.entries()) {
      const cached = this.#cache.cached(checkout);
      if (cached !== null) {
        links.push(...cached);
        continue;
      }
      if (this.#now() - started > this.#budgetMs) {
        this.#readLater(others.slice(index));
        const left = others.length - index;
        return (
          `headroom did not read the links of ${left} of the ${others.length} other checkouts of the repository of ${repo.top} in time, so it cannot tell ` +
          `if a link points into ${target}. The read goes on in the daemon: run the command again in a few seconds, or use headroom worktree remove.`
        );
      }
      links.push(...this.#cache.links(checkout));
      await this.#pause();
    }
    const inbound = linksInto(target, links, repo.top, platform);
    return inbound.length === 0 ? null : linkRefusal(target, inbound);
  }

  /** This function reads the links of checkouts into the cache, one checkout at each turn of the daemon. */
  #readLater(checkouts: readonly string[]): void {
    const fresh = checkouts.filter((checkout) => !this.#reading.has(checkout));
    for (const checkout of fresh) this.#reading.add(checkout);
    void (async () => {
      for (const checkout of fresh) {
        try {
          await this.#pause();
          this.#cache.links(checkout);
        } catch {
          // A read that fails gives no cache entry. The next hook call reads the checkout again.
        } finally {
          this.#reading.delete(checkout);
        }
      }
    })();
  }

  /** This function tells if a read of the links of a checkout goes on in the daemon. */
  reading(checkout: string): boolean {
    return this.#reading.has(checkout);
  }
}
