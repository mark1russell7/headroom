/**
 * The slots that `headroom run` adds by itself. A slot is a pool with no capacity, so it is a lock of 1 unless
 * `headroom pool <name> <capacity>` sets more.
 *
 * - `browser`: browser tests start many browser processes. Two such jobs at the same time can make process starts
 *   fail (0xC0000142), even with free memory. Thus one browser test job runs at a time. A spawn-heavy job does not run
 *   beside a browser test either (H47).
 */

import { BROWSER_SLOT } from "@headroom/core";

/** The slot of the browser tests. The core keeps it, because the spawn rule of the broker uses it (H47). */
export { BROWSER_SLOT };

/** The commands that run browser tests: Playwright, Cypress, WebdriverIO, and each command that names e2e. */
export const BROWSER_TESTS: RegExp = /\bplaywright\s+test\b|\bcypress\s+run\b|\bwdio\b|\be2e\b/i;

/** This function gives the slots that a command takes by itself. */
export function autoSlots(command: string): string[] {
  return BROWSER_TESTS.test(command) ? [BROWSER_SLOT] : [];
}
