/**
 * The lines of `headroom status` and `headroom config` for the settings with no default (H57). These functions are in this
 * file because `cli.ts` starts its command at each import, so a test cannot import it.
 */

import { conditionsText, NO_USAGE_FILE_WAIT, unmetText, type Lease } from "@headroom/core";

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
 * a wait. A granted lease that runs without one of its conditions says so.
 */
export function leaseRow(lease: Lease, amounts: string, gpu: string | null): string {
  const conditions = conditionsText(lease.conditions);
  const note = (lease.unmet?.until === null ? unmetText(lease.unmet) : null) ?? lease.reason;
  return `  ${lease.state.padEnd(8)} ${lease.holder.padEnd(14)} ${lease.job.slice(0, 40).padEnd(40)} ${amounts}${conditions === null ? "" : `  [${conditions}]`}${gpu === null ? "" : `  ${gpu}`}${note ? `  (${note})` : ""}`;
}

/** This function gives the line of the setting `usageFile` for `headroom config`. */
export function usageFileLine(file: string | null): string {
  return file === null ? "usage-file: not set. A job with the condition usage<N waits. Set it with: headroom config usage-file <path>" : `usage-file: ${file}. The condition usage<N reads it.`;
}

/** This function gives the line of the setting `rolesFile` for `headroom config`. */
export function rolesFileLine(file: string | null): string {
  return file === null ? `roles-file: not set. The roles are unknown. ${SET_ROLES_FILE}` : `roles-file: ${file}. The owners of Docker projects and of peers come from it.`;
}
