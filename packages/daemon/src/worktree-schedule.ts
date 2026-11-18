/**
 * The schedule of the worktree cleanup in the daemon (H175).
 *
 * - A dry run writes the plan to `~/.headroom/worktree-plan.json` and gives the note `worktree:plan`. The plan holds the key of
 *   its rules (H198). The key is a hash of the code of the rules and of the settings of the scan. The daemon starts a dry
 *   run only when no plan has its key. That occurs at the first start, and after a change of a rule or of a setting. A
 *   restart or a new version with the same rules starts none. A dry run that writes no plan with the key starts again at most one time each hour.
 * - The scan of each run that the daemon starts waits 500 ms between the starts of two git commands. A scan of 555 trees
 *   with no wait started 5,156 processes in 45 s on 2026-11-17.
 * - With the setting `worktreeAutoClean` off (the default), the daemon only writes a new plan. It writes one 24 hours after
 *   the time of the last plan in the file.
 * - With the setting on, the daemon starts `headroom worktree clean` one time each 24 hours. It also starts it when a drive
 *   of a root has less than 20 GB free, at most one time each hour.
 * - One run changes at most 20 trees. When a run stops before the end, the next check (5 minutes later) starts the next
 *   batch, until the cleanup has no more trees.
 * - The child process deletes the files, so the tick of the daemon does not wait.
 * - After each run, the daemon reads the record. More than 100 `keep` trees give the alert `worktree:keep`.
 */

import { spawn } from "node:child_process";
import {
  cleanDue,
  keepAlert,
  WORKTREE_CLEAN_EVERY_MS,
  WORKTREE_GIT_GAP_MS,
  WORKTREE_KEEP_ALERT_ID,
  WORKTREE_LOW_FREE_MB,
  type Alert,
  type CleanReason,
  type WorktreeSummary,
} from "@headroom/core";
import { mountOf } from "./parse.ts";
import type { WorktreePlan, WorktreeRecord } from "./worktree-cli.ts";

/** The time that an alert of the cleanup stays active: until a short time after the next daily run. */
const ALERT_MS = 25 * 3_600_000;

/** The least time between two dry runs while no plan has the key of the daemon: 1 hour. */
export const WORKTREE_PLAN_RETRY_MS = 3_600_000;

/** The id of the note of a new plan. */
export const WORKTREE_PLAN_NOTE_ID = "worktree:plan";

/**
 * One run of the cleanup. `plan`: a dry run that writes the plan. `clean`: the real cleanup. The reason `no-plan`: the file
 * has no plan. The reason `new-rules`: the plan has a different key, so a rule or a setting of the scan changed.
 */
export interface WorktreeRun {
  readonly mode: "plan" | "clean";
  readonly reason: CleanReason | "no-plan" | "new-rules";
}

/** The text of the reason of each run, for the log. */
const REASON_TEXT: Readonly<Record<WorktreeRun["reason"], string>> = {
  "no-plan": "no plan yet",
  "new-rules": "the rules or the settings of the scan changed",
  daily: "the daily run",
  "low-space": "a drive has less than 20 GB free",
  batch: "the next batch",
};

/** The options of the schedule. The tests replace each one. */
export interface WorktreeScheduleOptions {
  /** The roots of the cleanup. */
  readonly roots: () => readonly string[];
  /** The free space of each fixed drive, in MB. */
  readonly disks: () => readonly { readonly mount: string; readonly freeMb: number }[];
  /** This function gives the setting `worktreeAutoClean`: true lets the daemon remove trees. */
  readonly autoClean: () => boolean;
  /** This function gives the key of the rules and the settings of the scan (`worktreeRulesKey`). A plan with a different key does not let a removal start. */
  readonly key: () => string;
  /** This function starts a run, and gives its exit code. */
  readonly launch: (run: WorktreeRun) => Promise<number | null>;
  /** This function reads the record of the last real cleanup. */
  readonly record: () => WorktreeRecord | null;
  /** This function reads the plan of the last dry run. */
  readonly plan: () => WorktreePlan | null;
  readonly note: (alert: Omit<Alert, "since">, forMs: number) => void;
  readonly endNote: (id: string) => void;
  readonly log: (line: string) => void;
  readonly now?: (() => number) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

/** This function gives the time of a text, or `null`. */
function timeOf(text: string | undefined): number | null {
  const at = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

/** This function gives the note of a new plan. */
export function planNote(plan: WorktreePlan, autoClean: boolean): Omit<Alert, "since"> {
  const counts = `remove ${plan.plan.remove} worktrees, delete node_modules in ${plan.plan.nodeModules} kept trees and prune ${plan.plan.prune} main checkouts`;
  const next = autoClean
    ? "The removals start at the next check, at most 20 trees in each batch."
    : "No removal starts before the setting is on: headroom config worktree-auto-clean on.";
  return {
    id: WORKTREE_PLAN_NOTE_ID,
    kind: "worktree",
    subject: "git worktrees",
    pid: null,
    mb: 0,
    message: `The worktree cleanup of version ${plan.version} has a new plan: ${counts}. It keeps ${plan.counts.orphan} orphans. The plan is in ~/.headroom/worktree-plan.json. ${next}`,
  };
}

/** The schedule of the worktree cleanup. `tick()` starts a run when one is due. */
export class WorktreeSchedule {
  readonly #options: WorktreeScheduleOptions;
  #running = false;
  /** The start of the last real cleanup. */
  #lastAt: number | null;
  /** True when the last real cleanup stopped before the end. */
  #more: boolean;
  /** The start of the last dry run of this daemon. A new daemon has none. The time of the last plan is the later of this time and the time in the file. */
  #planAt: number | null = null;

  constructor(options: WorktreeScheduleOptions) {
    this.#options = options;
    const last = options.record();
    this.#lastAt = timeOf(last?.clean.at);
    this.#more = (last?.clean.remaining ?? 0) > 0;
    const plan = options.plan();
    const newest = last !== null && (plan === null || (timeOf(last.at) ?? 0) >= (timeOf(plan.at) ?? 0)) ? last : plan;
    if (newest !== null) this.#alert(newest);
  }

  /** This function tells if a run is in progress. */
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

  /** This function gives the run that is due, or `null`. */
  due(now: number): WorktreeRun | null {
    const plan = this.#options.plan();
    if (plan === null || plan.key !== this.#options.key()) {
      // A dry run that wrote no plan with the key does not start again at each check.
      if (this.#planAt !== null && now - this.#planAt < WORKTREE_PLAN_RETRY_MS) return null;
      return { mode: "plan", reason: plan === null ? "no-plan" : "new-rules" };
    }
    const lastPlan = Math.max(this.#planAt ?? 0, timeOf(plan.at) ?? 0);
    if (!this.#options.autoClean()) return now - lastPlan >= WORKTREE_CLEAN_EVERY_MS ? { mode: "plan", reason: "daily" } : null;
    const reason = cleanDue(now, this.#lastAt, this.lowSpace(), this.#more);
    return reason === null ? null : { mode: "clean", reason };
  }

  /** This function starts a run when one is due and none runs. It gives the run, or `null`. */
  tick(): WorktreeRun | null {
    if (this.#running || this.#options.roots().length === 0) return null;
    const now = (this.#options.now ?? Date.now)();
    const run = this.due(now);
    if (run === null) return null;
    this.#running = true;
    if (run.mode === "plan") this.#planAt = now;
    else this.#lastAt = now;
    this.#options.log(`The worktree ${run.mode === "plan" ? "plan (a dry run)" : "cleanup"} starts (${REASON_TEXT[run.reason]}).`);
    void this.#options.launch(run).then(
      (code) => this.#done(run, now, code),
      (error: unknown) => this.#done(run, now, null, error instanceof Error ? error.message : String(error)),
    );
    return run;
  }

  #done(run: WorktreeRun, startedAt: number, code: number | null, error?: string): void {
    this.#running = false;
    if (error !== undefined) {
      this.#options.log(`The worktree ${run.mode === "plan" ? "plan" : "cleanup"} did not start: ${error}`);
      if (run.mode === "clean") this.#more = false;
      return;
    }
    if (run.mode === "plan") {
      const plan = this.#options.plan();
      // A run that stopped early leaves the plan of an earlier run in the file. Its numbers are not the numbers of this run.
      if (plan === null || (timeOf(plan.at) ?? 0) < startedAt - 60_000) {
        const last = plan === null ? "The file has no plan." : `The plan in the file is from ${plan.at}.`;
        // With the key in the file, the next plan is the daily one. With no plan of the key, the next try comes after the retry time.
        const next = plan !== null && plan.key === this.#options.key() ? "" : " The next try is in 1 hour.";
        this.#options.log(`The worktree plan ended with code ${code ?? "unknown"}, but it wrote no new plan. ${last}${next}`);
        return;
      }
      const key = this.#options.key();
      if (plan.key !== key) {
        this.#options.log(`The worktree plan ended with code ${code ?? "unknown"}, but its key ${plan.key ?? "(none)"} is not the key ${key} of the daemon. The next try is in 1 hour.`);
        return;
      }
      this.#options.log(`The worktree plan ended with code ${code ?? "unknown"}: remove ${plan.plan.remove}, node_modules ${plan.plan.nodeModules}, prune ${plan.plan.prune}. Orphans: ${plan.counts.orphan}.`);
      this.#options.note(planNote(plan, this.#options.autoClean()), ALERT_MS);
      this.#alert(plan);
      return;
    }
    const record = this.#options.record();
    // A run with no record or with an old record does not start the next batch at once.
    this.#more = record !== null && (timeOf(record.clean.at) ?? 0) >= (this.#lastAt ?? 0) - 60_000 && (record.clean.remaining ?? 0) > 0;
    if (record === null) return;
    const clean = record.clean;
    const left = (clean.remaining ?? 0) > 0 ? ` ${clean.remaining} trees are for the next batch (${clean.stopped === "memory" ? "too little memory" : "the batch was full"}).` : "";
    this.#options.log(
      `The worktree cleanup ended with code ${code ?? "unknown"}: removed ${clean.removed} trees, deleted node_modules in ${clean.nodeModules}, pruned ${clean.pruned}, ${clean.failed} failed.${left} Keep: ${record.counts.keep}. Orphans: ${record.counts.orphan}.`,
    );
    this.#options.endNote(WORKTREE_PLAN_NOTE_ID);
    this.#alert(record);
  }

  #alert(summary: Pick<WorktreeSummary, "counts" | "repos">): void {
    const alert = keepAlert(summary);
    if (alert === null) this.#options.endNote(WORKTREE_KEEP_ALERT_ID);
    else this.#options.note(alert, ALERT_MS);
  }
}

/**
 * This function gives the launch of a run: `headroom worktree clean`, with `--dry-run` for a plan, in a child process with
 * no window. The scan waits `gitGapMs` between the starts of two git commands.
 */
export function launchClean(node: string, cli: string, gitGapMs: number = WORKTREE_GIT_GAP_MS): WorktreeScheduleOptions["launch"] {
  return (run) =>
    new Promise((done, fail) => {
      const args = launchArgs(cli, run, gitGapMs);
      const child = spawn(node, args, { stdio: "ignore", windowsHide: true });
      child.on("error", fail);
      child.on("exit", (code) => done(code));
    });
}

/** This function gives the arguments of the child process of a run. */
export function launchArgs(cli: string, run: WorktreeRun, gitGapMs: number = WORKTREE_GIT_GAP_MS): string[] {
  return [cli, "worktree", "clean", "--git-gap", `${gitGapMs}ms`, ...(run.mode === "plan" ? ["--dry-run"] : [])];
}
