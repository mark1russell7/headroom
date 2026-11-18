/**
 * The lines of `headroom status` and `headroom config` for the settings with no default (H57). These functions are in this
 * file because `cli.ts` starts its command at each import, so a test cannot import it.
 */

import { conditionsText, diskSize, NO_USAGE_FILE_WAIT, unmetText, type Lease, type LeaseUse } from "@headroom/core";

/** The command that sets the registry of the roles, as an instruction. */
export const SET_ROLES_FILE = "Set it with: headroom config roles-file <path>";

/**
 * This function gives one `Problem:` line for each job that waits for the setting `usageFile`. No change of the computer
 * starts such a job. Only the setting starts it.
 */
export function problemLines(leases: readonly Lease[]): string[] {
  return leases.flatMap((lease) => (lease.state === "waiting" && lease.reason === NO_USAGE_FILE_WAIT ? [`Problem: ${lease.job} ${lease.reason}`] : []));
}

/**
 * This function gives the row of one lease in `headroom status`. It shows the conditions of the lease (H31), and the reason of
 * a wait. A granted lease that runs without one of its conditions says so. A granted lease shows its memory use (H62).
 */
export function leaseRow(lease: Lease, amounts: string, gpu: string | null, use: string | null = null): string {
  const conditions = conditionsText(lease.conditions);
  const note = (lease.unmet?.until === null ? unmetText(lease.unmet) : null) ?? lease.reason;
  return `  ${lease.state.padEnd(8)} ${lease.holder.padEnd(14)} ${lease.job.slice(0, 40).padEnd(40)} ${amounts}${use === null ? "" : `  ${use}`}${conditions === null ? "" : `  [${conditions}]`}${gpu === null ? "" : `  ${gpu}`}${note ? `  (${note})` : ""}`;
}

/**
 * This function gives the memory use of a granted lease for its row (H62), for example "uses 1.2 GB, peak 3.0 GB, over:
 * 6.1 times its amount". It gives `null` with no use, for example from a daemon of an older version.
 */
export function leaseUseText(use: LeaseUse | undefined): string | null {
  if (use === undefined || (use.usedMb === null && use.peakMb === null)) return null;
  const count = use.containers?.length ?? 0;
  const counted = count === 0 ? "" : ` with ${count} ${count === 1 ? "container" : "containers"}`;
  const parts = [use.usedMb === null ? "no measure now" : `uses ${diskSize(use.usedMb)}${counted}`];
  if (use.peakMb !== null) parts.push(`peak ${diskSize(use.peakMb)}`);
  const text = parts.join(", ");
  return use.over ? `${text}, over: ${use.times ?? "many"} times its amount` : text;
}

/** This function gives the line of the setting `usageFile` for `headroom config`. */
export function usageFileLine(file: string | null): string {
  return file === null ? "usage-file: not set. A job with the condition usage<N waits. Set it with: headroom config usage-file <path>" : `usage-file: ${file}. The condition usage<N reads it.`;
}

/** This function gives the line of the setting `rolesFile` for `headroom config`. */
export function rolesFileLine(file: string | null): string {
  return file === null ? `roles-file: not set. The roles are unknown. ${SET_ROLES_FILE}` : `roles-file: ${file}. The owners of Docker projects and of peers come from it.`;
}
