/**
 * The floor of a stated lease (H215). On 2026-11-19, a bundle build did not get its lease of 900 MB in 8 minutes. The
 * session asked again with 500 MB, and the job used 803 MB. A lease below the real use of its job defeats the hold of
 * the memory, because the daemon grants memory that is not there.
 *
 * The signature of a command names one command in one place. It is the kind, the repo, the package filter, the warm
 * state and the command text of its key (H78). The client removes the absolute paths, the temp folders and
 * the hex ids from the command text. Thus a new job name or a new scratchpad gives the same signature. The floor is the
 * peak of the last run of the signature times `PEAK_FLOOR_FACTOR`, rounded up to a whole MB. A lease with a stated
 * memory below the floor gets a refusal, unless the request gives a reason to start below the peak. A command with no
 * measured run has no floor.
 *
 * Each function of this file is pure. The engine gives the last run from the store, and the replay of `headroom
 * report leases` gives it from the leases of its window. Thus the backtest and the daemon use the same rule.
 */

import type { JobKey } from "./predict.ts";

/** The factor of the floor over the peak of the last run of a signature (H215). */
export const PEAK_FLOOR_FACTOR = 1.1;

/** The longest reason of a request below the floor, in characters. */
export const BELOW_PEAK_REASON_MAX = 500;

/** The last run of a signature with a measured peak (H215). */
export interface MeasuredRun {
  /** The ID of the lease of the run. */
  readonly id: string;
  /** The name of the job of the run. */
  readonly job: string;
  /** The holder of the run. */
  readonly holder: string;
  /** The peak memory of the run in MB. */
  readonly peakMb: number;
  /** The end of the run in ms since the epoch. */
  readonly endedAt: number;
}

/** The floor of a signature: the amount in MB and the run that measured it (H215). */
export interface PeakFloor {
  /** The floor in MB: the peak of the run times `PEAK_FLOOR_FACTOR`, rounded up. */
  readonly floorMb: number;
  /** The run that gave the floor. */
  readonly run: MeasuredRun;
}

/** The fields of a key that make the signature of a command (H215). */
export type CommandSignature = Pick<JobKey, "kind" | "repo" | "filter" | "warm" | "command">;

/** This function gives the signature of a command from its key (H215). */
export function signatureOf(key: JobKey): CommandSignature {
  return { kind: key.kind, repo: key.repo, filter: key.filter, warm: key.warm, command: key.command };
}

/** This function gives a text of a signature, for a map of the replay. Two keys of one command give one text. */
export function signatureText(key: JobKey): string {
  return JSON.stringify([key.kind, key.repo, key.filter, key.warm, key.command]);
}

/**
 * This function gives the floor of the last run of a signature, or `null` with no run or with no peak above 0. The
 * product of a float and 1.1 can be a little above a whole number, for example 1000 × 1.1. Thus the function removes
 * 1e-6 before it rounds up.
 */
export function peakFloor(run: MeasuredRun | null, factor: number = PEAK_FLOOR_FACTOR): PeakFloor | null {
  if (run === null || !(run.peakMb > 0) || !Number.isFinite(run.peakMb)) return null;
  return { floorMb: Math.ceil(run.peakMb * factor - 1e-6), run };
}

/**
 * This function gives the reason of a request to start below the floor: the trimmed text, at most
 * `BELOW_PEAK_REASON_MAX` characters. It gives `null` for no text or for only spaces.
 */
export function belowPeakReason(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, BELOW_PEAK_REASON_MAX);
}

/** The decision of the floor for a request (H215). */
export type FloorDecision =
  /** No stated memory, no floor, or a stated memory at the floor or above it. */
  | { readonly kind: "pass"; readonly floor: PeakFloor | null }
  /** A stated memory below the floor, with a reason to start. The store keeps the reason. */
  | { readonly kind: "below"; readonly floor: PeakFloor; readonly statedMb: number; readonly reason: string }
  /** A stated memory below the floor, with no reason. */
  | { readonly kind: "refuse"; readonly floor: PeakFloor; readonly statedMb: number };

/**
 * This function decides a request against the floor of its signature (H215). A request with no stated memory passes:
 * the rule applies to a stated amount only. `reason` is the text of `--below-peak`.
 */
export function decideFloor(statedMb: number | undefined, floor: PeakFloor | null, reason: string | null | undefined): FloorDecision {
  if (floor === null || statedMb === undefined || statedMb >= floor.floorMb) return { kind: "pass", floor };
  const why = belowPeakReason(reason);
  return why === null ? { kind: "refuse", floor, statedMb } : { kind: "below", floor, statedMb, reason: why };
}

/** This function gives the text of a time in UTC to the minute, for example `2026-11-19 02:41Z`. */
function minuteText(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/**
 * This function gives the text of a refusal (H215). It names the stated amount, the floor, the peak and the run that
 * measured the peak. It also names the two ways to start: `--mem auto`, or a reason with `--below-peak`.
 */
export function floorRefusalText(statedMb: number, floor: PeakFloor): string {
  const run = floor.run;
  const peak = Math.round(run.peakMb);
  return [
    `The lease of ${statedMb} MB is below the floor of ${floor.floorMb} MB for this command.`,
    `The last run of the same command used ${peak} MB at its peak (job ${run.job} of ${run.holder}, lease ${run.id.slice(0, 8)}, ended ${minuteText(run.endedAt)}).`,
    `The floor is that peak times ${PEAK_FLOOR_FACTOR}.`,
    `Start it with --mem auto, or with --mem ${floor.floorMb}m or more.`,
    `To start it below the floor, give the reason: --below-peak "<reason>".`,
  ].join(" ");
}

/** The error code of a refusal of the floor (H215). The client reads it to tell a refusal from other errors. */
export const PEAK_FLOOR_CODE = "PEAK_FLOOR";

/** The error of a refusal of the floor (H215). Its message is the text of `floorRefusalText`. */
export class PeakFloorError extends Error {
  readonly code: typeof PEAK_FLOOR_CODE = PEAK_FLOOR_CODE;
  readonly floor: PeakFloor;
  readonly statedMb: number;
  constructor(statedMb: number, floor: PeakFloor) {
    super(floorRefusalText(statedMb, floor));
    this.name = "PeakFloorError";
    this.floor = floor;
    this.statedMb = statedMb;
  }
}
