/**
 * The slots that `headroom run` adds by itself. A slot is a pool with no capacity, so it is a lock of 1 unless
 * `headroom pool <name> <capacity>` sets more.
 *
 * - `browser`: browser tests start many browser processes. Two such jobs at the same time can make process starts
 *   fail (0xC0000142), even with free memory. Thus one browser test job runs at a time.
 */

/** The slot of the browser tests. */
export const BROWSER_SLOT = "browser";

/** The commands that run browser tests: Playwright, Cypress, WebdriverIO, and each command that names e2e. */
export const BROWSER_TESTS: RegExp = /\bplaywright\s+test\b|\bcypress\s+run\b|\bwdio\b|\be2e\b/i;

/** This function gives the slots that a command takes by itself. */
export function autoSlots(command: string): string[] {
  return BROWSER_TESTS.test(command) ? [BROWSER_SLOT] : [];
}
