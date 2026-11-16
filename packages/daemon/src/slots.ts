/**
 * The slots that `headroom run` adds by itself. A slot is a pool with no capacity, so it is a lock of 1 unless
 * `headroom pool <name> <capacity>` sets more.
 *
 * - `browser`: browser tests start many browser processes. Two such jobs at the same time can make process starts
 *   fail (0xC0000142), even with free memory. Thus one browser test job runs at a time. A spawn-heavy job does not run
 *   beside a browser test either (H47).
 *
 * The rating reads the command words of each part of the line (H55). A false slot costs a wait, and a missing slot
 * risks failed process starts. Thus only three cases give no slot, each for a program that is known to start no browser:
 * - The word e2e as a filter word of a unit test runner (H55).
 * - Each word of a program that does not start a browser, for example `tsc -p e2e/tsconfig.json` (H52).
 * - A browser test runner that only lists its tests or gives its help, for example `playwright test --list` (H52).
 * An unknown program that names e2e keeps the slot.
 */

import { BROWSER_SLOT } from "@headroom/core";

/** The slot of the browser tests. The core keeps it, because the spawn rule of the broker uses it (H47). */
export { BROWSER_SLOT };

/** The commands that run browser tests: Playwright, Cypress, WebdriverIO, and each command that names e2e. */
export const BROWSER_TESTS: RegExp = /\bplaywright\s+test\b|\bcypress\s+run\b|\bwdio\b|\be2e\b/i;

/** The word e2e in a command line. */
const E2E_WORD = /\be2e\b/gi;

/** The shell divides a line into parts at these separators. */
const PART_END = /&&|\|\||;|\|/;

/** The programs that run browser tests by their command words: Playwright, Cypress and WebdriverIO. */
const BROWSER_RUNNERS: ReadonlySet<string> = new Set(["playwright", "cypress", "wdio"]);

/** An option of a browser test runner that only lists the tests or gives help or a version. Such a run starts no browser (H52). */
const LIST_ONLY = /(?:^|\s)(?:--list|--help|-h|--version|-V)(?=[\s=]|$)/;

/**
 * The programs that do not start a browser (H52). For them, the word e2e is only a path or a text. These are the
 * compilers and the type checkers, the linters and the formatters, git and the GitHub CLI, and the tools that read or move
 * files. The commands of a package manager that only change the installed packages are also in this set.
 */
const NO_BROWSER: ReadonlySet<string> = new Set([
  ...["tsc", "tsgo", "vue-tsc", "svelte-check", "eslint", "prettier", "biome", "oxlint", "dprint"],
  ...["git", "gh", "cat", "echo", "grep", "rg", "sed", "awk", "head", "tail", "ls", "find", "wc", "cp", "mv", "rm", "mkdir", "touch"],
  ...["install", "add", "remove", "update"],
]);

/** The unit test runners. They run in Node, so the word e2e is only a filter word or a folder for them. */
const UNIT_RUNNERS: ReadonlySet<string> = new Set(["vitest", "jest"]);

/** The programs that start another program, which their arguments name. */
const LAUNCHERS: ReadonlySet<string> = new Set(["pnpm", "pnpx", "npx", "npm", "yarn", "bun", "bunx", "node", "cross-env", "env"]);

/** The words of a launcher before the program. The word `run` is not here: it starts a script, and a script can start a browser. */
const LAUNCHER_WORDS: ReadonlySet<string> = new Set(["exec", "dlx", "x", "--"]);

/** The options of a launcher that take the next word as their value. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(["--filter", "-F", "-C", "--dir", "--workspace", "-w", "--package", "-p"]);

/** A variable before a command, for example `CI=1`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The option of Vitest that runs the tests in a browser. Other forms are `--browser=chromium` and `--browser.name`. */
const BROWSER_OPTION = /(?:^|\s)--browser(?:[\s=.]|$)/i;

/** An option that picks an e2e suite. Such a suite can start a browser from its own code, so the word e2e counts there. */
const E2E_SUITE = /(?:^|\s)(?:--projects?|--config|-c)[=\s]\S*e2e/i;

/** This function gives the name of a program from its path, without the folder and the extension. */
function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? "").replace(/\.(?:exe|cmd|bat|ps1|mjs|cjs|js)$/i, "").toLowerCase();
}

/** This function gives the program that a part of a line runs, after its variables and its launchers (`pnpm exec`, `npx`). */
function runnerOf(part: string): string {
  const words = part.trim().split(/\s+/);
  let launched = false;
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? "";
    if (ASSIGNMENT.test(word) || (launched && LAUNCHER_WORDS.has(word))) continue;
    if (launched && word.startsWith("-")) {
      if (VALUE_OPTIONS.has(word)) at++;
      continue;
    }
    const name = programName(word);
    if (!LAUNCHERS.has(name)) return name;
    launched = true;
  }
  return "";
}

/**
 * This function tells if one part of a line runs browser tests. A program that does not start a browser does not, whatever
 * its words are (H52). A browser test runner does not when it only lists its tests or gives its help (H52). For a unit
 * test runner, the word e2e does not count, unless the part has `--browser` or picks an e2e suite (H55).
 */
function runsBrowserTests(part: string): boolean {
  const runner = runnerOf(part);
  if (NO_BROWSER.has(runner) || (BROWSER_RUNNERS.has(runner) && LIST_ONLY.test(part))) return false;
  const filterWord = UNIT_RUNNERS.has(runner) && !BROWSER_OPTION.test(part) && !E2E_SUITE.test(part);
  return BROWSER_TESTS.test(filterWord ? part.replace(E2E_WORD, "") : part);
}

/** This function gives the slots that a command takes by itself. */
export function autoSlots(command: string): string[] {
  return command.split(PART_END).some(runsBrowserTests) ? [BROWSER_SLOT] : [];
}
