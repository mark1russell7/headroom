/**
 * The state of a job (H26): the answer to `headroom job <name|id>` and `resources.job`.
 *
 * A job of `headroom run` can run after the shell that started it stops. This query tells a session if the job
 * is queued, running or exited, with its exit code and its log.
 */

import type { Lease } from "./broker.ts";
import type { Store } from "./store.ts";

/** The state of a job: `queued` (the lease waits), `running` (granted) or `exited` (released, cancelled or expired). */
export type JobPhase = "queued" | "running" | "exited";

/** The state of one job, from its lease. Each time is an ISO string or `null`. */
export interface JobState {
  /** The id of the lease. */
  readonly id: string;
  /** The name of the job. */
  readonly job: string;
  /** The holder of the lease. */
  readonly holder: string;
  readonly state: JobPhase;
  /** The exit code of the job. It is `null` while the job runs, and for a lease that ended without a job exit. */
  readonly exitCode: number | null;
  /** The signal that stopped the job, or `null`. */
  readonly signal: string | null;
  /** Why the lease ended, or why it waits. */
  readonly reason: string | null;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** The time from the request to the grant, or to the end of a lease that was not granted. A queued job waits still. */
  readonly waitedMs: number;
  /** The time from the grant to the end, or to this time for a running job. It is `null` for a job that did not start. */
  readonly ranMs: number | null;
  /** The peak memory of the job in MB, or `null`. */
  readonly peakMb: number | null;
  /** The processes that the job started so far, from its job object (H29), or `null` for a job with no job object. */
  readonly processes: number | null;
  /** The absolute path of the log file of the job (`headroom run --log`), or `null`. */
  readonly log: string | null;
}

/** A query for jobs. */
export interface JobQuery {
  /** The id of a lease, a prefix of 8 or more characters of the id, or the name of a job. */
  readonly query: string;
  /** Only the leases of this holder. */
  readonly holder?: string | undefined;
  /** True: each match of the last 24 hours, the newest first. False: only the latest match. */
  readonly all?: boolean | undefined;
}

/** The shortest prefix of a lease id that the query accepts. */
export const MIN_ID_PREFIX = 8;

/** The window of `all`: each match of the last 24 hours. */
export const ALL_JOBS_MS: number = 24 * 3_600_000;

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

/** This function gives the state of the job of a lease at a time. */
export function jobState(lease: Lease, now: number): JobState {
  const state: JobPhase = lease.state === "waiting" ? "queued" : lease.state === "granted" ? "running" : "exited";
  const end = lease.endedAt ?? now;
  const peak = lease.peakMb ?? lease.usage?.peakMb ?? null;
  return {
    id: lease.id,
    job: lease.job,
    holder: lease.holder,
    state,
    exitCode: lease.exitCode ?? null,
    signal: lease.signal ?? null,
    reason: lease.reason,
    queuedAt: new Date(lease.requestedAt).toISOString(),
    startedAt: iso(lease.grantedAt),
    endedAt: iso(lease.endedAt),
    waitedMs: Math.max(0, (lease.grantedAt ?? end) - lease.requestedAt),
    ranMs: lease.grantedAt === null ? null : Math.max(0, end - lease.grantedAt),
    peakMb: peak === null ? null : Math.round(peak),
    processes: lease.processes ?? null,
    log: lease.log ?? null,
  };
}

/**
 * This function finds the jobs of a query, the newest first. It tries the lease id first: the full id, or a unique
 * prefix of 8 or more characters. Then it tries the name of the job. Without `all`, it gives at most one job.
 */
export function findJobs(store: Pick<Store, "leasesByPrefix" | "leasesOfJob">, query: JobQuery, now: number): JobState[] {
  const ofHolder = (lease: Lease): boolean => query.holder === undefined || lease.holder === query.holder;
  if (query.query.length >= MIN_ID_PREFIX) {
    const byId = store.leasesByPrefix(query.query, 10).filter(ofHolder);
    const [only] = byId;
    if (only !== undefined && byId.length === 1) return [jobState(only, now)];
  }
  const all = query.all === true;
  const leases = store.leasesOfJob(query.query, { holder: query.holder, since: all ? now - ALL_JOBS_MS : undefined, limit: all ? 200 : 1 });
  return leases.map((lease) => jobState(lease, now));
}
