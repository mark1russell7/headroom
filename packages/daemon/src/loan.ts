/**
 * The loan of `headroom run --loan <time>` (H219). A short job can borrow the unused hold of a long lease for a time
 * limit. The client renews the lease every 2 seconds while the lease has its loan. When the daemon ends the loan, the
 * client stops the job. These functions are in this file because `cli.ts` starts its command at each import, so a test
 * cannot import it.
 */

import { diskSize, LOAN_MAX_DEFAULT_MS, type Lease, type Loan } from "@headroom/core";
import { isNetworkError, isRestartError } from "./client.ts";
import { parseTime } from "./parse.ts";

/** The longest time limit of `--loan`, in ms: one day, the same as the longest heartbeat limit (H219). */
export const LOAN_OPTION_MAX_MS = 86_400_000;

/** The time between two renewals of a lease on a loan, in ms (H219). It is the time between two ticks of the daemon. */
export const LOAN_RENEW_MS = 2000;

/** The exit code of a run whose loan ended before its job (H219). The job did not finish, so the caller can run it again. */
export const LOAN_ENDED_CODE = 75;

/** The options of the run that `--loan` needs or refuses (H219). */
export interface LoanRun {
  /** The value of `--mem`: a number, `auto`, or `undefined` with no option. */
  readonly mem: string | undefined;
  /** True with `--keep`. */
  readonly keep: boolean;
}

/**
 * This function reads `--loan <time>` (H219). It gives the time limit in ms, `null` with no option, or an error text. The
 * option needs `--mem`, because the loan is of memory. It refuses `--keep`, because the client stops each process of the
 * job at the end of the loan.
 */
export function loanOption(text: string | undefined, run: LoanRun): number | null | { readonly error: string } {
  if (text === undefined) return null;
  if (run.mem === undefined) return { error: "--loan needs --mem with an amount or auto, because the loan is of memory. Example: --loan 60s --mem auto" };
  if (run.keep) return { error: "--loan does not go with --keep, because the client stops each process of the job at the end of its loan." };
  let ms: number;
  try {
    ms = parseTime(text);
  } catch (error) {
    return { error: `--loan needs a time limit. ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!(ms > 0)) return { error: `--loan needs a time above 0, for example --loan 60s, not ${text}.` };
  if (ms > LOAN_OPTION_MAX_MS) return { error: `--loan takes at most 24h, not ${text}.` };
  return ms;
}

/**
 * This function gives the note of `headroom run` for a time limit above the longest loan of the daemon (H219), or `null`.
 * Such a job gets no loan, so it waits for free room, as with no `--loan`.
 */
export function loanLimitNote(loanMs: number, maxMs: number = LOAN_MAX_DEFAULT_MS): string | null {
  if (loanMs <= maxMs) return null;
  return `headroom: --loan ${seconds(loanMs)} is longer than the longest loan of the daemon (${seconds(maxMs)}). The job gets no loan, and waits for free room.`;
}

/** This function writes a time in whole seconds, for example "10 s". */
function seconds(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))} s`;
}

/** This function writes the amounts of a loan, for example "400 MB", or "400 MB of memory:gpu0" for another measured room. */
function amountsText(loan: Loan): string {
  return Object.entries(loan.amounts)
    .map(([id, mb]) => (id === "memory" ? diskSize(mb) : `${diskSize(mb)} of ${id}`))
    .join(" and ");
}

/**
 * This function gives the text of the loan of a granted lease (H219), for example "on a loan of 400 MB, which ends in 8 s".
 * It gives `null` for a lease with no loan, and for a lease that is not granted.
 */
export function loanText(lease: Lease, now: number): string | null {
  if (lease.state !== "granted" || lease.loan === undefined) return null;
  return `on a loan of ${amountsText(lease.loan)}, which ends in ${seconds(lease.loan.until - now)}`;
}

/**
 * This function stops the processes of a job at the end of its loan (H219). It stops each process except `self`, the
 * client. A process that already ended gives an error, and the function continues with the next one. It gives the count
 * of processes that it stopped.
 */
export function stopJobProcesses(pids: readonly number[], self: number, kill: (pid: number) => void): number {
  let count = 0;
  for (const pid of pids) {
    if (pid === self) continue;
    try {
      kill(pid);
      count += 1;
    } catch {
      // The process ended before the stop.
    }
  }
  return count;
}

/** The options of `watchLoan()` (H219). */
export interface LoanWatchOptions {
  /** This function renews the lease at the daemon, and gives its answer. */
  readonly renew: () => Promise<Lease>;
  /** This function gets the reason when the loan ends before the job. The client then stops the job. */
  readonly onEnd: (reason: string) => void;
  /** This function gets the call when the loan returns, and the lease stays granted with no loan. */
  readonly onReturn?: (() => void) | undefined;
  readonly now?: (() => number) | undefined;
  /** The time between two renewals, in ms (default: 2000). */
  readonly everyMs?: number | undefined;
}

/**
 * This function watches the loan of a granted lease (H219). Every 2 seconds, it renews the lease. When the answer is not a
 * granted lease, the loan ended, so the function calls `onEnd`. When no daemon answers, the function waits until the time
 * limit of the loan, and then calls `onEnd`. When the lease has no loan in the answer, the loan returned, so the watch
 * stops. The function gives the function that stops the watch. A lease with no loan gets no watch.
 */
export function watchLoan(lease: Lease, options: LoanWatchOptions): () => void {
  const loan = lease.loan;
  if (loan === undefined) return () => undefined;
  const now = options.now ?? Date.now;
  let busy = false;
  let over = false;
  const stop = (): void => {
    over = true;
    clearInterval(timer);
  };
  const end = (reason: string): void => {
    if (over) return;
    stop();
    options.onEnd(reason);
  };
  const check = async (): Promise<void> => {
    try {
      const answer = await options.renew();
      if (over) return;
      if (answer.state !== "granted") return end(answer.reason ?? `the lease is ${answer.state}`);
      if (answer.loan !== undefined) return;
      stop();
      options.onReturn?.();
    } catch (error) {
      // A daemon that restarts keeps the loan with its end. Thus the job can run on until the time limit of the loan.
      if (isNetworkError(error) || isRestartError(error)) {
        if (now() >= loan.until) end(`no daemon answers after the time limit of the loan (${seconds(lease.loanMs ?? 0)})`);
        return;
      }
      end(`the daemon does not know the lease: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const timer = setInterval(() => {
    if (busy || over) return;
    busy = true;
    void check().finally(() => {
      busy = false;
    });
  }, options.everyMs ?? LOAN_RENEW_MS);
  // The watch does not keep the client alive: the job does.
  timer.unref();
  return stop;
}
