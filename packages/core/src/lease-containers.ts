/**
 * The containers of each granted lease (H62). The memory of a container is in the VM of Docker, not in the tree of the job
 * that started it. This module gives each running container to one lease at most.
 *
 * 1. The label `headroom.lease` of the container names a granted lease: the container is its. `headroom run` gives each
 *    job the variable `HEADROOM_LEASE`, so a compose file can set the label, for example
 *    `headroom.lease: ${HEADROOM_LEASE:-}`. A label that names no granted lease gives the container to no lease.
 * 2. Else three facts must hold for a lease. The folder of the compose project is at or under the folder of the lease. The
 *    job tree of the lease holds a container client. The container started after the grant of the lease.
 * 3. When exactly one lease matches, the container is its. With two or more, the container goes to no lease.
 *
 * The folder rule does not use a lease folder that is a root or a wide folder, for example the home folder. A job that
 * starts there names no project.
 *
 * A job tree with a container client and no container has no measure, so its lease keeps its full amount (H187).
 */

import type { Lease } from "./broker.ts";
import type { DockerContainer } from "./docker.ts";
import { jobTree } from "./owners.ts";
import type { ProcessInfo } from "./types.ts";

/** The time before its grant at which the start of a container still counts for a lease. The reads differ by some seconds. */
const START_SLACK_MS = 30_000;

/** The normal form of a root folder: `/` or a drive, for example `d:/`. */
const ROOT = /^(?:[a-z]:)?\/$/;

/** The fields of a container that give its lease. */
export type LeasedContainer = Pick<DockerContainer, "id" | "name" | "state" | "workingDir" | "memoryMb" | "leaseLabel" | "upMinMs">;

/** The rule that gave a container to its lease: its label, or the folder of its compose project. */
export type LeaseContainerFrom = "label" | "folder";

/** The containers of one lease. */
export interface LeaseContainerUse {
  /** The memory of its running containers in MB. A container with no memory read adds 0. */
  readonly mb: number;
  /** The names of its containers. */
  readonly names: readonly string[];
}

/** The containers of the granted leases at one read. */
export interface LeaseContainers {
  /** The lease of each running container that has one, by the ID of the container. */
  readonly leaseOf: ReadonlyMap<string, { readonly lease: string; readonly from: LeaseContainerFrom }>;
  /** The containers of each lease, by the ID of the lease. */
  readonly byLease: ReadonlyMap<string, LeaseContainerUse>;
}

/** A lease of the folder rule: a granted lease with a folder and a container client in its job tree. */
interface FolderLease {
  readonly lease: Lease;
  readonly folders: readonly string[];
}

/**
 * This function gives the lease of each running container. `at` is the time of the read of the containers. `forms` gives
 * the normal forms of a path, for example `pathFormsCache()` of `docker.ts`. `wide` holds the normal forms of the
 * folders that are too wide for the folder rule, for example the home folder.
 */
export function leaseContainers(
  containers: readonly LeasedContainer[],
  leases: readonly Lease[],
  processes: readonly ProcessInfo[],
  at: number,
  forms: (path: string) => readonly string[],
  wide: readonly string[] = [],
): LeaseContainers {
  const granted = new Map(leases.filter((lease) => lease.state === "granted").map((lease) => [lease.id, lease]));
  const folderLeases: FolderLease[] = [];
  for (const lease of granted.values()) {
    if (lease.folder === undefined || lease.pid === null) continue;
    const folders = forms(lease.folder).filter((folder) => !wide.includes(folder) && !ROOT.test(folder));
    if (folders.length > 0 && jobTree(lease.pid, processes)?.client === true) folderLeases.push({ lease, folders });
  }
  const leaseOf = new Map<string, { readonly lease: string; readonly from: LeaseContainerFrom }>();
  const byLease = new Map<string, LeaseContainerUse>();
  for (const container of containers) {
    if (container.state !== "running") continue;
    const found = leaseOfContainer(container, granted, folderLeases, at, forms);
    if (found === null) continue;
    leaseOf.set(container.id, found);
    const use = byLease.get(found.lease);
    byLease.set(found.lease, { mb: (use?.mb ?? 0) + (container.memoryMb ?? 0), names: [...(use?.names ?? []), container.name] });
  }
  return { leaseOf, byLease };
}

/** This function gives the lease of one running container by the rules of the module, or `null`. */
function leaseOfContainer(
  container: LeasedContainer,
  granted: ReadonlyMap<string, Lease>,
  folderLeases: readonly FolderLease[],
  at: number,
  forms: (path: string) => readonly string[],
): { readonly lease: string; readonly from: LeaseContainerFrom } | null {
  const label = container.leaseLabel ?? null;
  if (label !== null) return granted.has(label) ? { lease: label, from: "label" } : null;
  if (container.workingDir === null || container.upMinMs === null || container.upMinMs === undefined) return null;
  // The latest time at which the container can have started.
  const startedBy = at - container.upMinMs;
  const dirs = forms(container.workingDir);
  const matches = folderLeases.filter(
    ({ lease, folders }) =>
      lease.grantedAt !== null &&
      startedBy >= lease.grantedAt - START_SLACK_MS &&
      folders.some((folder) => dirs.some((dir) => dir === folder || dir.startsWith(`${folder}/`))),
  );
  const only = matches.length === 1 ? matches[0] : undefined;
  return only === undefined ? null : { lease: only.lease.id, from: "folder" };
}

/**
 * This function gives the memory of the job of a lease in MB: its process tree and its containers. It gives `null` when
 * the read does not measure the job. Then the process is not in the read, or its tree holds a container client and the
 * lease has no container. A lease with no process counts only its containers.
 */
export function leaseMemoryMb(lease: Pick<Lease, "id" | "pid">, processes: readonly ProcessInfo[], containers: LeaseContainers | undefined): number | null {
  const own = containers?.byLease.get(lease.id);
  if (lease.pid === null) return own?.mb ?? null;
  const tree = jobTree(lease.pid, processes);
  if (tree === null || (tree.client && own === undefined)) return null;
  return tree.mb + (own?.mb ?? 0);
}
