/**
 * The use of each granted lease against its stated memory (H62).
 *
 * - The stated memory of a lease is its amount of the id `memory`, for example `--mem 500`.
 * - The measured use is the memory of its job at the last read. The peak is the largest measured use since the grant. A
 *   restart of the daemon starts each peak again.
 * - A lease is over when its peak is `overFactor` times its stated memory or more, and at least `overMinMb` above it. The
 *   second limit keeps a small job off the list, for example a job that states 32 MB and uses 200 MB.
 * - The free memory for new leases counts the use of each lease, also above its amount (H187). Thus an over lease does not
 *   make the broker grant memory that is not there. The finding tells the holder that its amount is wrong.
 */

import type { Lease } from "./broker.ts";
import { diskSize } from "./units.ts";

/** The id of the memory in the amounts of a lease. */
const MEMORY = "memory";

/** The limits of the over finding: two fields of the alert rules. */
export interface OverRules {
  /** A lease with a peak of this many times its stated memory or more is over. The default is 2. */
  readonly overFactor: number;
  /** The peak of an over lease is at least this many MB above its stated memory. The default is 1024. */
  readonly overMinMb: number;
}

/** The use of one granted lease with a memory amount. */
export interface LeaseUse {
  readonly id: string;
  readonly holder: string;
  readonly job: string;
  /** The memory amount of the lease, in MB. */
  readonly statedMb: number;
  /** The memory of the job at the last read, in MB, or `null` when the read does not measure the job. */
  readonly usedMb: number | null;
  /** The largest measured use since the grant, in MB, or `null` before the first measure. */
  readonly peakMb: number | null;
  /** The peak divided by the stated memory, with 1 decimal, or `null` with no peak or no stated memory. */
  readonly times: number | null;
  /** True when the peak is `overFactor` times the stated memory or more, and at least `overMinMb` above it. */
  readonly over: boolean;
  /** The names of the containers that count for the lease (H62). A lease with no container has none. */
  readonly containers?: readonly string[];
}

/** This function tells if a peak is far above the stated memory. A stated memory of 0 is over at a peak of `overMinMb`. */
export function isOver(statedMb: number, peakMb: number | null, rules: OverRules): boolean {
  if (peakMb === null || !Number.isFinite(peakMb)) return false;
  return peakMb >= rules.overFactor * statedMb && peakMb - statedMb >= rules.overMinMb;
}

/**
 * This function gives the use of a lease, or `null` for a lease that is not granted or has no memory amount. The peak is
 * at least the use at this time. `containers` are the names of the containers that count for the lease.
 */
export function leaseUse(lease: Lease, usedMb: number | null, peakMb: number | null, rules: OverRules, containers: readonly string[] = []): LeaseUse | null {
  const statedMb = lease.amounts[MEMORY];
  if (lease.state !== "granted" || statedMb === undefined) return null;
  const peak = peakMb === null && usedMb === null ? null : Math.max(peakMb ?? 0, usedMb ?? 0);
  const times = peak === null || statedMb <= 0 ? null : Math.round((peak / statedMb) * 10) / 10;
  return {
    id: lease.id,
    holder: lease.holder,
    job: lease.job,
    statedMb,
    usedMb: usedMb === null ? null : Math.round(usedMb),
    peakMb: peak === null ? null : Math.round(peak),
    times,
    over: isOver(statedMb, peak, rules),
    ...(containers.length === 0 ? {} : { containers }),
  };
}

/** The count of leases that the text of the over alert names. The rest is a count. */
const NAMED = 3;

/**
 * This function gives the text of the over alert: the leases above their stated memory, the largest excess first. The
 * size of the alert is the sum of the excess.
 */
export function overText(uses: readonly LeaseUse[]): { readonly subject: string; readonly mb: number; readonly message: string } {
  const over = uses.filter((use) => use.over).sort((a, b) => excess(b) - excess(a));
  const named = over.slice(0, NAMED).map((use) => {
    const times = use.times === null ? "" : `, ${use.times} times its amount`;
    const count = use.containers?.length ?? 0;
    const containers = count === 0 ? "" : ` Its use holds ${count === 1 ? "the container" : "the containers"} ${use.containers?.join(", ") ?? ""}.`;
    return ` The lease ${use.job} of ${use.holder} states ${diskSize(use.statedMb)} and used up to ${diskSize(use.peakMb ?? 0)}${times}.${containers}`;
  });
  const more = over.length > NAMED ? ` ${over.length - NAMED} more leases are over.` : "";
  const first = over.length === 1 ? "A lease uses far more memory than it states." : `${over.length} leases use far more memory than they state.`;
  return {
    subject: over.length === 1 ? (over[0]?.job ?? "lease") : "leases",
    mb: Math.round(over.reduce((sum, use) => sum + excess(use), 0)),
    message: `${first}${named.join("")}${more} The free memory for new leases counts this use. Give the job a larger --mem, or --mem auto.`,
  };
}

/** This function gives the MB of a lease above its stated memory. */
function excess(use: LeaseUse): number {
  return Math.max(0, (use.peakMb ?? 0) - use.statedMb);
}
