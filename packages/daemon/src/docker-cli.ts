/**
 * The `headroom docker [--json]` command (H38): each container with its owner, its memory, its cores and its state. It
 * also gives the owners of the containers, the VM and the disk use of Docker.
 *
 * The daemon reads the Docker engine every 30 seconds, and the disk use every 10 minutes. headroom does not prune, stop or
 * start a container. The command tells this in its last line.
 */

import { parseArgs } from "node:util";
import { diskSize, DOCKER_VM, type DockerContainerStatus, type DockerStatus } from "@headroom/core";
import type { Connection } from "./client.ts";
import type { DaemonStatus } from "./procedures.ts";

export const DOCKER_USAGE = "headroom docker [--json]";

/** The outputs of the command. The tests replace them. */
export interface DockerOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const CONSOLE: DockerOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };

/** This function writes cores with two decimals: "0.25". */
const coresOf = (cores: number | null): string => (cores === null ? "-" : cores.toFixed(2));

/** This function writes a time of the day in UTC: "09:42". */
const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);

/** This function writes a time in milliseconds: "85 ms", or "4.6 s" from one second. */
const msText = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** This function writes the row of one container. */
function containerRow(container: DockerContainerStatus): string {
  const memory = container.memoryMb === null ? "-" : diskSize(container.memoryMb);
  const project = container.project ?? "-";
  return `${container.name.slice(0, 28).padEnd(28)} ${container.owner.slice(0, 28).padEnd(28)} ${container.state.slice(0, 10).padEnd(10)} ${memory.padStart(9)} ${coresOf(container.cores).padStart(6)}  ${project}`;
}

/** This function gives the lines of the command for the Docker resource of a status. */
export function dockerLinesOf(docker: DockerStatus | null | undefined): string[] {
  if (docker === null || docker === undefined) {
    return ["No Docker read. The Docker engine does not answer, or the daemon is of an older version. `headroom services` gives the health of the engine."];
  }
  const cores = docker.cores === null ? "" : `, ${coresOf(docker.cores)} cores`;
  const lines = [
    `Docker ${docker.version} (API ${docker.api}), read at ${clock(docker.at)} UTC: ${docker.running} of ${docker.containers.length} containers run, ${diskSize(docker.memoryMb)}${cores}.`,
  ];
  if (docker.containers.length > 0) {
    lines.push("", `${"NAME".padEnd(28)} ${"OWNER".padEnd(28)} ${"STATE".padEnd(10)} ${"MEMORY".padStart(9)} ${"CORES".padStart(6)}  PROJECT`);
    for (const container of docker.containers) lines.push(containerRow(container));
  }
  if (docker.owners.length > 0) {
    lines.push("", "Owners of the running containers:");
    for (const share of docker.owners) {
      const count = `${share.containers} ${share.containers === 1 ? "container" : "containers"}`;
      lines.push(`  ${share.owner.padEnd(28)} ${diskSize(share.memoryMb).padStart(9)} ${coresOf(share.cores).padStart(6)} cores  ${count}`);
    }
  }
  lines.push("");
  if (docker.vm !== null) {
    lines.push(`VM: ${docker.vm.name} ${diskSize(docker.vm.workingMb)} in RAM, ${diskSize(docker.vm.privateMb)} committed.`);
  }
  if (docker.rest !== null) {
    const restCores = docker.rest.cores === null ? "" : ` and ${coresOf(docker.rest.cores)} cores`;
    lines.push(`${DOCKER_VM} keeps ${diskSize(docker.rest.workingMb)} in RAM${restCores}: the VM, its cache and the Docker programs of Windows, less the containers.`);
  }
  const disk = docker.disk;
  if (disk === null) lines.push("Disk: no read yet. The daemon reads the disk use every 10 minutes.");
  else {
    lines.push(
      `Disk, read at ${clock(disk.at)} UTC: images ${diskSize(disk.imagesMb)} (${disk.images}), images with no container ${diskSize(disk.unusedImagesMb)} (${disk.unusedImages}).`,
      `  Build cache ${diskSize(disk.buildCacheMb)}, ${diskSize(disk.buildCacheUnusedMb)} of it not in use. Volumes ${diskSize(disk.volumesMb)} (${disk.volumes}), ${diskSize(disk.unusedVolumesMb)} with no container. Writable layers ${diskSize(disk.containersMb)}.`,
    );
  }
  lines.push(`Cost: the last read of the containers took ${msText(docker.readMs)}${disk === null ? "" : `, and the last disk read ${msText(disk.readMs)}`}.`);
  lines.push("", "headroom does not prune, stop or start a container. docker builder prune and docker image prune free the cache and the images.");
  return lines;
}

/** This function gives the output of `headroom docker [--json]`, and its exit code. */
export async function dockerCommand(argv: readonly string[], connection: Connection | null, output: DockerOutput = CONSOLE): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { json: { type: "boolean" } } });
  if (connection === null) {
    output.err("headroom does not run.");
    return 1;
  }
  const status = await connection.call<DaemonStatus>(["resources", "status"], {});
  if (values.json) output.out(JSON.stringify(status.docker ?? null, null, 2));
  else for (const line of dockerLinesOf(status.docker)) output.out(line);
  return 0;
}
