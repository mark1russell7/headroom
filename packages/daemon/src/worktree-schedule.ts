/**
 * The schedule of the worktree cleanup in the daemon (H175).
 *
 * - The daemon starts `headroom worktree clean` in a child process one time each 24 hours.
 * - It also starts it when a drive of a root has less than 20 GB free, at most one time each hour.
 * - The child process deletes the files, so the tick of the daemon does not wait.
 * - After the cleanup, the daemon reads the record. More than 100 `keep` trees give the alert `worktree:keep`.
 */

import { spawn } from "node:child_process";
import { cleanDue, keepAlert, WORKTREE_KEEP_ALERT_ID, WORKTREE_LOW_FREE_MB, type Alert } from "@headroom/core";
import { mountOf } from "./parse.ts";
import type { WorktreeRecord } from "./worktree-cli.ts";

/** The time that an alert of the cleanup stays active: until a short time after the next daily cleanup. */
const ALERT_MS = 25 * 3_600_000;

/** The options of the schedule. The tests replace each one. */
export interface WorktreeScheduleOptions {
  /** The roots of the cleanup. */
  readonly roots: () => readonly string[];
  /** The free space of each fixed drive, in MB. */
  readonly disks: () => readonly { readonly mount: string; readonly freeMb: number }[];
  /** This function starts the cleanup, and gives its exit code. */
  readonly launch: (reason: "daily" | "low-space") => Promise<number | null>;
  /** This function reads the record of the last cleanup. */
  readonly record: () => WorktreeRecord | null;
  readonly note: (alert: Omit<Alert, "since">, forMs: number) => void;
  readonly endNote: (id: string) => void;
  readonly log: (line: string) => void;
  readonly now?: (() => number) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

/** The schedule of the worktree cleanup. `tick()` starts a cleanup when one is due. */
export class WorktreeSchedule {
  readonly #options: WorktreeScheduleOptions;
  #running = false;
  #lastAt: number | null;

  constructor(options: WorktreeScheduleOptions) {
    this.#options = options;
    const last = options.record();
    const at = last === null ? Number.NaN : Date.parse(last.clean.at);
    this.#lastAt = Number.isFinite(at) ? at : null;
    if (last !== null) this.#alert(last);
  }

  /** This function tells if a cleanup is in progress. */
  running(): boolean {
    return this.#running;
  }

  /** This function tells if a drive of a root has less than 20 GB free. */
  lowSpace(): boolean {
    const disks = this.#options.disks();
    const mounts = disks.map((disk) => disk.mount);
    const platform = this.#options.platform ?? process.platform;
    return this.#options.roots().some((root) => {
      const mount = mountOf(root, mounts, platform);
      const disk = disks.find((each) => each.mount.toUpperCase() === mount?.toUpperCase());
      return disk !== undefined && disk.freeMb < WORKTREE_LOW_FREE_MB;
    });
  }

  /** This function starts a cleanup when one is due and none runs. It gives the reason of the start, or `null`. */
  tick(): "daily" | "low-space" | null {
    if (this.#running || this.#options.roots().length === 0) return null;
    const now = (this.#options.now ?? Date.now)();
    const due = cleanDue(now, this.#lastAt, this.lowSpace());
    if (due === null) return null;
    this.#running = true;
    this.#lastAt = now;
    this.#options.log(`The worktree cleanup starts (${due === "daily" ? "the daily run" : "a drive has less than 20 GB free"}).`);
    void this.#options.launch(due).then(
      (code) => this.#done(code),
      (error: unknown) => this.#done(null, error instanceof Error ? error.message : String(error)),
    );
    return due;
  }

  #done(code: number | null, error?: string): void {
    this.#running = false;
    const record = this.#options.record();
    if (error !== undefined) this.#options.log(`The worktree cleanup did not start: ${error}`);
    else if (record !== null) {
      const clean = record.clean;
      this.#options.log(
        `The worktree cleanup ended with code ${code ?? "unknown"}: removed ${clean.removed} trees, deleted node_modules in ${clean.nodeModules}, pruned ${clean.pruned}, ${clean.failed} failed. Keep: ${record.counts.keep}. Orphans: ${record.counts.orphan}.`,
      );
    }
    if (record !== null) this.#alert(record);
  }

  #alert(record: WorktreeRecord): void {
    const alert = keepAlert(record);
    if (alert === null) this.#options.endNote(WORKTREE_KEEP_ALERT_ID);
    else this.#options.note(alert, ALERT_MS);
  }
}

/** This function gives the launch of the cleanup: `headroom worktree clean` in a child process with no window. */
export function launchClean(node: string, cli: string): WorktreeScheduleOptions["launch"] {
  return () =>
    new Promise((done, fail) => {
      const child = spawn(node, [cli, "worktree", "clean"], { stdio: "ignore", windowsHide: true });
      child.on("error", fail);
      child.on("exit", (code) => done(code));
    });
}
