/**
 * Docker inside (H38): the memory, the CPU and the disk of each container, with the session of its compose project.
 *
 * - The reader asks the Docker engine over its pipe, with GET requests only. headroom starts no `docker` process.
 * - The memory of a container is its use less its inactive file cache, as `docker stats` gives it.
 * - The CPU of a container is the change of its processor time between two reads of the reader.
 * - The owner of a container is the session of its compose project, from the folder of the project or from its name.
 * - The memory and the cores of the owner `docker` go to the owners of the containers. The rest is `docker (VM)`.
 *
 * headroom does not prune, stop or start a container, an image, a volume or Docker.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { AlertRules } from "./alerts.ts";
import type { OwnerCores } from "./counters.ts";
import type { FleetRole } from "./peer.ts";
import type { OwnerUse } from "./resources.ts";
import { errorText } from "./services.ts";
import type { OwnerKind, OwnerUsage, ProcessInfo } from "./types.ts";
import { diskSize, gb } from "./units.ts";

const MB = 1024 * 1024;

/** The owner of the memory and the cores of Docker that no container explains: the VM, its kernel and the Docker programs of Windows. */
export const DOCKER_VM = "docker (VM)";

/** The owner of the Docker processes, from the default rules of `owners.ts`. */
const DOCKER = "docker";

/** The names of the VM processes of Hyper-V and WSL 2, in lower case with no `.exe`. The Docker engine is in this VM. */
export const VM_PROCESSES: ReadonlySet<string> = new Set(["vmmem", "vmmemwsl"]);

/** The time between two reads of the containers. */
export const DOCKER_EVERY_MS = 30_000;
/** The time between two reads of the disk use. The engine needs some seconds for the sizes of the images. */
export const DOCKER_DISK_EVERY_MS: number = 10 * 60_000;
/** The time limit of the list and the stats of one read. */
export const DOCKER_TIMEOUT_MS = 10_000;
/** The time limit of one read of the disk use. */
export const DOCKER_DISK_TIMEOUT_MS = 30_000;
/** The first API version with the parameter `one-shot` of the stats. */
const ONE_SHOT_API = "1.41";

/** The answer of one GET to the Docker engine. */
export interface DockerAnswer {
  readonly status: number;
  readonly body: string;
}

/** One GET of a path of the engine API. The function throws an error when the engine gives no answer. The signal aborts the request. */
export type DockerGet = (path: string, signal: AbortSignal) => Promise<DockerAnswer>;

/** One container of one read. */
export interface DockerContainer {
  /** The full ID of the container. */
  readonly id: string;
  /** The name, with no `/` at its start. */
  readonly name: string;
  readonly image: string;
  /** The state: `running`, `exited`, `created`, `paused`, `restarting` or `dead`. */
  readonly state: string;
  /** The compose project, from the label `com.docker.compose.project`, or `null`. */
  readonly project: string | null;
  /** The folder of the compose project, from the label `com.docker.compose.project.working_dir`, or `null`. */
  readonly workingDir: string | null;
  /** The memory in MB: the use less the inactive file cache. A container that is not `running` has `null`. */
  readonly memoryMb: number | null;
  /** The memory limit in MB. A container with no limit gets the memory of the VM. */
  readonly limitMb: number | null;
  /** The cores since the last read of the reader. The first read of a container gives `null`. */
  readonly cores: number | null;
  /** The size of the writable layer in MB, from the last read of the disk use, or `null`. */
  readonly sizeRwMb: number | null;
}

/** The disk use of Docker, from `GET /system/df`. Each size is in MB. */
export interface DockerDisk {
  /** The time of the read. */
  readonly at: number;
  /** The size of all the images. */
  readonly imagesMb: number;
  readonly images: number;
  /** The size of the images with no container. `docker image prune -a` frees it. */
  readonly unusedImagesMb: number;
  readonly unusedImages: number;
  /** The size of the build cache. */
  readonly buildCacheMb: number;
  /** The part of the build cache that no build uses. `docker builder prune` frees it. */
  readonly buildCacheUnusedMb: number;
  /** The size of the volumes. */
  readonly volumesMb: number;
  readonly volumes: number;
  /** The size of the volumes with no container. */
  readonly unusedVolumesMb: number;
  /** The size of the writable layers of the containers. */
  readonly containersMb: number;
  /** The time of the request in milliseconds. */
  readonly readMs: number;
}

/** One read of the Docker engine. */
export interface DockerRead {
  readonly at: number;
  /** The version of the engine, for example `29.9.2`. */
  readonly version: string;
  /** The API version that the reader uses, from `GET /version`. */
  readonly api: string;
  /** The containers, the running containers first. */
  readonly containers: readonly DockerContainer[];
  /** The last read of the disk use, or `null` before the first one. */
  readonly disk: DockerDisk | null;
  /** The time of the list and the stats requests in milliseconds. */
  readonly readMs: number;
}

/** The state of the Docker engine for the reader. `absent`: no pipe or socket. `down`: no good answer. */
export type DockerEngineState = "unknown" | "ok" | "absent" | "down";

/** A container with its owner, in the status. */
export interface DockerContainerStatus extends DockerContainer {
  readonly owner: string;
  readonly ownerKind: OwnerKind;
  /** The source of the owner: the folder of a role, the project name of a role, or neither (`docker`). */
  readonly ownerFrom: "folder" | "project" | "docker";
}

/** The memory and the cores of the running containers of one owner. */
export interface DockerShare {
  readonly owner: string;
  readonly kind: OwnerKind;
  readonly containers: number;
  readonly memoryMb: number;
  /** The cores, or `null` when no container of the owner has two reads. */
  readonly cores: number | null;
}

/** The VM processes (`vmmem`, `vmmemWSL`): their memory and their cores. */
export interface DockerVm {
  readonly name: string;
  readonly privateMb: number;
  readonly workingMb: number;
  readonly processes: number;
}

/** The part of the owner `docker` that no container explains, after the split. */
export interface DockerRest {
  readonly privateMb: number;
  readonly workingMb: number;
  /** The cores, or `null` when the engine gives no cores of `docker`. */
  readonly cores: number | null;
}

/** The Docker resource of the status (H38). */
export interface DockerStatus {
  readonly at: number;
  readonly version: string;
  readonly api: string;
  /** The containers with their owners, the running containers first. */
  readonly containers: readonly DockerContainerStatus[];
  /** The count of running containers. */
  readonly running: number;
  /** The memory of the running containers in MB. */
  readonly memoryMb: number;
  /** The cores of the running containers, or `null` before the second read. */
  readonly cores: number | null;
  /** The memory and the cores of each owner, the most memory first. */
  readonly owners: readonly DockerShare[];
  /** The VM processes of Windows. Linux and a computer with no VM process give `null`. */
  readonly vm: DockerVm | null;
  /** The part of the owner `docker` that no container explains: the owner `docker (VM)`. */
  readonly rest: DockerRest | null;
  readonly disk: DockerDisk | null;
  /** The time of the list and the stats requests of the last read in milliseconds. */
  readonly readMs: number;
}

// ---- parse ----

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

/** The version of the engine, from `GET /version`. */
export interface DockerVersion {
  readonly version: string;
  readonly api: string;
  /** The operating system of the containers: `linux` or `windows`. Windows gives the processor time in units of 100 ns. */
  readonly os: string;
}

/** This function reads the answer of `GET /version`. An answer with no API version gives an error. */
export function parseVersion(json: unknown): DockerVersion {
  const data = isRecord(json) ? json : {};
  const api = text(data["ApiVersion"]);
  if (api === null || !isApiVersion(api)) throw new Error("The Docker engine gave no API version");
  return { version: text(data["Version"]) ?? "unknown", api, os: text(data["Os"]) ?? "linux" };
}

/** This function tells if a text is an API version: digits, a point and digits. */
function isApiVersion(value: string): boolean {
  const [major, minor, more] = value.split(".");
  return more === undefined && major !== undefined && minor !== undefined && /^\d{1,3}$/.test(major) && /^\d{1,3}$/.test(minor);
}

/** This function compares two API versions. It gives a negative number when `a` is older than `b`. */
export function compareApi(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

/** The fields of a container from `GET /containers/json`, before its stats. */
export type ListedContainer = Pick<DockerContainer, "id" | "name" | "image" | "state" | "project" | "workingDir">;

/** This function reads the answer of `GET /containers/json`. An entry with no ID is skipped. */
export function parseContainers(json: unknown): ListedContainer[] {
  const containers: ListedContainer[] = [];
  for (const item of listOf(json)) {
    if (!isRecord(item)) continue;
    const id = text(item["Id"]);
    if (id === null) continue;
    const names = listOf(item["Names"]);
    const first = text(names[0]) ?? id.slice(0, 12);
    const labels = isRecord(item["Labels"]) ? item["Labels"] : {};
    containers.push({
      id,
      name: first.startsWith("/") ? first.slice(1) : first,
      image: text(item["Image"]) ?? "",
      state: text(item["State"]) ?? "unknown",
      project: text(labels["com.docker.compose.project"]),
      workingDir: text(labels["com.docker.compose.project.working_dir"]),
    });
  }
  return containers;
}

/** The fields of one answer of the stats of a container. */
export interface ContainerStats {
  readonly memoryMb: number | null;
  readonly limitMb: number | null;
  /** The total processor time of the container, in nanoseconds, or `null`. */
  readonly cpuNs: number | null;
  /** The time of the read of the engine in milliseconds since the epoch, or `null`. */
  readonly at: number | null;
}

/**
 * This function gives the memory of a container in bytes, as `docker stats` gives it. The function subtracts
 * `total_inactive_file` (cgroup v1) or `inactive_file` (cgroup v2) when the value is less than the use.
 */
export function memoryBytes(memory: unknown): number | null {
  if (!isRecord(memory)) return null;
  const usage = count(memory["usage"]);
  if (usage === null) return null;
  const stats = isRecord(memory["stats"]) ? memory["stats"] : {};
  const v1 = count(stats["total_inactive_file"]);
  if (v1 !== null && v1 < usage) return usage - v1;
  const v2 = count(stats["inactive_file"]);
  if (v2 !== null && v2 < usage) return usage - v2;
  return usage;
}

/** This function reads one answer of `GET /containers/{id}/stats`. Windows containers give the processor time in units of 100 ns. */
export function parseStats(json: unknown, os = "linux"): ContainerStats {
  const data = isRecord(json) ? json : {};
  const memory = memoryBytes(data["memory_stats"]);
  const limit = isRecord(data["memory_stats"]) ? count(data["memory_stats"]["limit"]) : null;
  const cpu = isRecord(data["cpu_stats"]) && isRecord(data["cpu_stats"]["cpu_usage"]) ? count(data["cpu_stats"]["cpu_usage"]["total_usage"]) : null;
  const read = text(data["read"]);
  const at = read === null ? NaN : Date.parse(read);
  return {
    memoryMb: memory === null ? null : memory / MB,
    limitMb: limit === null || limit <= 0 ? null : limit / MB,
    cpuNs: cpu === null ? null : os === "windows" ? cpu * 100 : cpu,
    // The engine gives "0001-01-01T00:00:00Z" when it has no time.
    at: Number.isFinite(at) && at > 0 ? at : null,
  };
}

/**
 * This function gives the cores of a container from two reads of its processor time. A lower total is a new start of the
 * container, so it gives `null`.
 */
export function coresBetween(previous: { readonly at: number; readonly ns: number } | undefined, at: number, ns: number): number | null {
  if (previous === undefined || ns < previous.ns || at <= previous.at) return null;
  return (ns - previous.ns) / ((at - previous.at) * 1e6);
}

const sizeOf = (value: unknown): number => {
  const bytes = count(value);
  return bytes === null || bytes < 0 ? 0 : bytes;
};

/**
 * This function reads the answer of `GET /system/df` in MB. API 1.52 and later give a summary of each type, with its total
 * and the part that a prune frees. An older engine gives only the lists, so the function adds them up as `docker system df` does.
 */
export function parseDf(json: unknown, at: number, readMs: number): { readonly disk: DockerDisk; readonly sizeRw: ReadonlyMap<string, number> } {
  const data = isRecord(json) ? json : {};
  const summary = (key: string): Record<string, unknown> | null => (isRecord(data[key]) ? data[key] : null);
  const images = listOf(data["Images"]).filter(isRecord);
  const containers = listOf(data["Containers"]).filter(isRecord);
  const volumes = listOf(data["Volumes"]).filter(isRecord);
  const cache = listOf(data["BuildCache"]).filter(isRecord);

  const imageUsage = summary("ImageUsage");
  const layers = count(data["LayersSize"]) ?? images.reduce((sum, image) => sum + sizeOf(image["Size"]), 0);
  // The CLI subtracts the size of each image with a container, less its shared layers.
  let usedBytes = 0;
  for (const image of images) {
    const size = count(image["Size"]);
    const shared = count(image["SharedSize"]);
    if ((count(image["Containers"]) ?? 0) > 0 && size !== null && shared !== null && size >= 0 && shared >= 0) usedBytes += size - shared;
  }
  const imagesBytes = count(imageUsage?.["TotalSize"]) ?? layers;
  const unusedImagesBytes = count(imageUsage?.["Reclaimable"]) ?? Math.max(0, layers - usedBytes);
  const imageCount = count(imageUsage?.["TotalCount"]) ?? images.length;
  const activeImages = count(imageUsage?.["ActiveCount"]) ?? images.filter((image) => (count(image["Containers"]) ?? 0) > 0).length;

  const cacheUsage = summary("BuildCacheUsage");
  const own = cache.filter((record) => record["Shared"] !== true);
  const cacheBytes = count(cacheUsage?.["TotalSize"]) ?? own.reduce((sum, record) => sum + sizeOf(record["Size"]), 0);
  const cacheUnused = count(cacheUsage?.["Reclaimable"]) ?? own.filter((record) => record["InUse"] !== true).reduce((sum, record) => sum + sizeOf(record["Size"]), 0);

  const volumeUsage = summary("VolumeUsage");
  const usage = (volume: Record<string, unknown>): Record<string, unknown> => (isRecord(volume["UsageData"]) ? volume["UsageData"] : {});
  const volumesBytes = count(volumeUsage?.["TotalSize"]) ?? volumes.reduce((sum, volume) => sum + sizeOf(usage(volume)["Size"]), 0);
  const unusedVolumes =
    count(volumeUsage?.["Reclaimable"]) ?? volumes.filter((volume) => count(usage(volume)["RefCount"]) === 0).reduce((sum, volume) => sum + sizeOf(usage(volume)["Size"]), 0);

  const sizeRw = new Map<string, number>();
  for (const container of containers) {
    const id = text(container["Id"]);
    if (id !== null) sizeRw.set(id, sizeOf(container["SizeRw"]) / MB);
  }
  const containerUsage = summary("ContainerUsage");
  const containersBytes = count(containerUsage?.["TotalSize"]) ?? containers.reduce((sum, container) => sum + sizeOf(container["SizeRw"]), 0);

  return {
    disk: {
      at,
      imagesMb: imagesBytes / MB,
      images: imageCount,
      unusedImagesMb: unusedImagesBytes / MB,
      unusedImages: Math.max(0, imageCount - activeImages),
      buildCacheMb: cacheBytes / MB,
      buildCacheUnusedMb: cacheUnused / MB,
      volumesMb: volumesBytes / MB,
      volumes: count(volumeUsage?.["TotalCount"]) ?? volumes.length,
      unusedVolumesMb: unusedVolumes / MB,
      containersMb: containersBytes / MB,
      readMs: Math.round(readMs),
    },
    sizeRw,
  };
}

// ---- the reader ----

/** The options of a Docker reader. */
export interface DockerReaderOptions {
  /** The transport: one GET of a path of the engine API. */
  readonly get: DockerGet;
  readonly now?: (() => number) | undefined;
  /** The time between two reads of the containers. The default is 30 seconds. */
  readonly everyMs?: number | undefined;
  /** The time between two reads of the disk use. The default is 10 minutes. */
  readonly diskEveryMs?: number | undefined;
  /** The time limit of the list and the stats. The default is 10 seconds. */
  readonly timeoutMs?: number | undefined;
  /** The time limit of the disk read. The default is 30 seconds. */
  readonly diskTimeoutMs?: number | undefined;
  /** The log of the daemon. The reader writes one line for each change of the state of the engine. */
  readonly log?: ((line: string) => void) | undefined;
}

/** This function gives the code of an error, for example `ENOENT`, or `null`. */
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code ?? null;

/**
 * The reader of the Docker engine. The tick of the daemon starts `poll()`. A read starts every 30 seconds, and only when no
 * read runs. The reader keeps the last good read. When the engine does not answer, the reader has no read.
 */
export class DockerReader {
  readonly #get: DockerGet;
  readonly #now: () => number;
  readonly #everyMs: number;
  readonly #diskEveryMs: number;
  readonly #timeoutMs: number;
  readonly #diskTimeoutMs: number;
  readonly #log: (line: string) => void;
  #version: DockerVersion | null = null;
  #last: DockerRead | undefined;
  #cpu = new Map<string, { readonly at: number; readonly ns: number }>();
  #disk: DockerDisk | null = null;
  #sizeRw: ReadonlyMap<string, number> = new Map();
  #diskAt = -Infinity;
  #startedAt = -Infinity;
  #pending: Promise<DockerRead | undefined> | null = null;
  #state: DockerEngineState = "unknown";

  constructor(options: DockerReaderOptions) {
    this.#get = options.get;
    this.#now = options.now ?? Date.now;
    this.#everyMs = options.everyMs ?? DOCKER_EVERY_MS;
    this.#diskEveryMs = options.diskEveryMs ?? DOCKER_DISK_EVERY_MS;
    this.#timeoutMs = options.timeoutMs ?? DOCKER_TIMEOUT_MS;
    this.#diskTimeoutMs = options.diskTimeoutMs ?? DOCKER_DISK_TIMEOUT_MS;
    this.#log = options.log ?? (() => undefined);
  }

  /** This function gives the last good read, or `undefined` when the engine does not answer. */
  last(): DockerRead | undefined {
    return this.#last;
  }

  /** This function gives the state of the engine at the last read. */
  state(): DockerEngineState {
    return this.#state;
  }

  /** This function starts a read when one is due and no read runs. The tick of the daemon uses it. It does not wait for the read. */
  poll(): void {
    if (this.#pending !== null || this.#now() - this.#startedAt < this.#everyMs) return;
    this.read().catch(() => undefined);
  }

  /** This function makes one read. When a read runs, it gives that read. A failed read gives `undefined`. */
  read(): Promise<DockerRead | undefined> {
    this.#pending ??= this.#readOnce().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #readOnce(): Promise<DockerRead | undefined> {
    const now = this.#now();
    this.#startedAt = now;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`No answer in ${this.#timeoutMs / 1000} s`)), this.#timeoutMs);
    timer.unref?.();
    try {
      const read = await this.#readContainers(now, controller.signal);
      this.#last = read;
      this.#setState("ok", `The Docker engine answers: version ${read.version}, API ${read.api}. headroom reads its containers every ${this.#everyMs / 1000} s.`);
      return read;
    } catch (error) {
      this.#last = undefined;
      this.#version = null;
      this.#cpu = new Map();
      // The first good read after a failure also reads the disk use.
      this.#diskAt = -Infinity;
      if (codeOf(error) === "ENOENT") this.#setState("absent", "The Docker engine is absent: its pipe does not exist. headroom reads no containers until it answers.");
      else this.#setState("down", `The Docker engine does not answer: ${errorText(error)}. headroom reads no containers until it answers.`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  #setState(state: DockerEngineState, line: string): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#log(line);
  }

  async #json(path: string, signal: AbortSignal): Promise<unknown> {
    const answer = await this.#get(path, signal);
    if (answer.status !== 200) throw new Error(`The Docker engine gave HTTP ${answer.status} for ${path.split("?")[0] ?? path}`);
    return JSON.parse(answer.body) as unknown;
  }

  async #readContainers(now: number, signal: AbortSignal): Promise<DockerRead> {
    const version = (this.#version ??= parseVersion(await this.#json("/version", signal)));
    const base = `/v${version.api}`;
    // The disk read is slow on the engine side, so it runs next to the list and the stats, with its own time limit.
    const disk = now - this.#diskAt >= this.#diskEveryMs ? this.#readDisk(base, now) : null;
    if (disk !== null) this.#diskAt = now;
    const started = performance.now();
    const listed = parseContainers(await this.#json(`${base}/containers/json?all=true`, signal));
    const oneShot = compareApi(version.api, ONE_SHOT_API) >= 0 ? "&one-shot=true" : "";
    const running = listed.filter((container) => container.state === "running");
    // A container that stops between the list and its stats gives no stats. The other containers keep theirs.
    const stats = await Promise.all(
      running.map((container) =>
        this.#json(`${base}/containers/${encodeURIComponent(container.id)}/stats?stream=false${oneShot}`, signal).then(
          (json) => parseStats(json, version.os),
          (error: unknown) => {
            if (signal.aborted) throw error;
            return null;
          },
        ),
      ),
    );
    const readMs = performance.now() - started;
    const cpu = new Map<string, { at: number; ns: number }>();
    const byId = new Map<string, ContainerStats | null>(running.map((container, index) => [container.id, stats[index] ?? null]));
    if (disk !== null) {
      const result = await disk;
      if (result !== null) {
        this.#disk = result.disk;
        this.#sizeRw = result.sizeRw;
      }
    }
    const containers = listed.map((container): DockerContainer => {
      const each = byId.get(container.id) ?? null;
      let cores: number | null = null;
      if (each !== null && each.cpuNs !== null) {
        const at = each.at ?? now;
        cores = coresBetween(this.#cpu.get(container.id), at, each.cpuNs);
        cpu.set(container.id, { at, ns: each.cpuNs });
      }
      return { ...container, memoryMb: each?.memoryMb ?? null, limitMb: each?.limitMb ?? null, cores, sizeRwMb: this.#sizeRw.get(container.id) ?? null };
    });
    this.#cpu = cpu;
    containers.sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || (b.memoryMb ?? 0) - (a.memoryMb ?? 0) || a.name.localeCompare(b.name));
    return { at: now, version: version.version, api: version.api, containers, disk: this.#disk, readMs: Math.round(readMs) };
  }

  /** This function reads the disk use. A failed read gives `null`, and the reader keeps the disk use of the read before. */
  async #readDisk(base: string, at: number): Promise<{ readonly disk: DockerDisk; readonly sizeRw: ReadonlyMap<string, number> } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`No answer in ${this.#diskTimeoutMs / 1000} s`)), this.#diskTimeoutMs);
    timer.unref?.();
    try {
      const started = performance.now();
      const json = await this.#json(`${base}/system/df`, controller.signal);
      return parseDf(json, at, performance.now() - started);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---- the owners ----

/** One folder of a fleet role, in its normal forms. */
export interface RoleFolder {
  readonly role: string;
  /** The normal forms of the folder: its path and its real path. */
  readonly paths: readonly string[];
  /** The last part of the folder, in lower case. */
  readonly base: string;
  /** The place of the folder in the list of the role. The first folder is the main repository of the role. */
  readonly index: number;
  readonly active: boolean;
  /** The place of the role in the registry. */
  readonly order: number;
}

/**
 * This function gives a path in a normal form for a comparison: `/` as the separator, lower case, and no `/` at the end.
 * `~` is the home folder, and a WSL path `/mnt/d/git` is `d:/git`.
 */
export function normalPath(path: string, home: string = homedir()): string {
  let value = path.trim().replaceAll("\\", "/");
  if (value === "~" || value.startsWith("~/")) value = home.replaceAll("\\", "/") + value.slice(1);
  const drive = value[5];
  if (value.startsWith("/mnt/") && drive !== undefined && /^[a-z]$/i.test(drive) && (value.length === 6 || value[6] === "/")) {
    value = `${drive}:${value.slice(6) || "/"}`;
  }
  while (value.length > 1 && value.endsWith("/") && !value.endsWith(":/")) value = value.slice(0, -1);
  return value.toLowerCase();
}

/**
 * This function gives the normal forms of a path: the path, and its real path when it exists. On this computer, `~/git` is
 * a link to `D:\git`, so a compose project in `D:\git\Graph` matches the folder `~/git/Graph` of a role.
 */
export function pathForms(path: string, home: string = homedir()): string[] {
  const forms = [normalPath(path, home)];
  const expanded = path.trim() === "~" || path.trim().startsWith("~/") || path.trim().startsWith("~\\") ? home + path.trim().slice(1) : path.trim();
  try {
    const real = normalPath(realpathSync.native(expanded), home);
    if (!forms.includes(real)) forms.push(real);
  } catch {
    // The folder does not exist on this computer, for example a path in the VM.
  }
  return forms;
}

/** This function gives the folders of the roles that are not retired, from the field `repos` of each role. */
export function roleFolders(roles: readonly FleetRole[], forms: (path: string) => readonly string[] = (path) => pathForms(path)): RoleFolder[] {
  const folders: RoleFolder[] = [];
  roles.forEach((role, order) => {
    if (role.status === "retired") return;
    (role.repos ?? []).forEach((repo, index) => {
      const paths = forms(repo);
      const main = paths[0];
      if (main === undefined || main === "" || main === "/") return;
      folders.push({ role: role.id, paths, base: main.slice(main.lastIndexOf("/") + 1), index, active: role.status === "active", order });
    });
  });
  return folders;
}

/** One match of a folder of a compose project with a folder of a role. */
interface FolderMatch {
  readonly folder: RoleFolder;
  /** The project is in the folder. Without it, the project is in a folder `<folder>-<name>` next to it, for example a worktree. */
  readonly direct: boolean;
  readonly length: number;
}

/**
 * This function tells if a match is better than another. A direct match wins, then the longer folder. Then the role with the
 * name of the folder wins, then the main repository of a role. Then an active role wins, then the first role of the registry.
 */
function better(a: FolderMatch, b: FolderMatch): boolean {
  if (a.direct !== b.direct) return a.direct;
  if (a.length !== b.length) return a.length > b.length;
  const named = (match: FolderMatch): boolean => match.folder.base === match.folder.role;
  if (named(a) !== named(b)) return named(a);
  if (a.folder.index !== b.folder.index) return a.folder.index < b.folder.index;
  if (a.folder.active !== b.folder.active) return a.folder.active;
  return a.folder.order < b.folder.order;
}

/**
 * This function gives the role of the folder of a compose project, or `undefined`. The folder must be in a folder of the role.
 * A folder `<repo>-<name>` next to a repository, for example a worktree, counts for that repository when no other folder holds it.
 */
export function roleOfFolder(dirs: readonly string[], folders: readonly RoleFolder[]): string | undefined {
  let best: FolderMatch | undefined;
  for (const folder of folders) {
    for (const path of folder.paths) {
      for (const dir of dirs) {
        const direct = dir === path || dir.startsWith(`${path}/`);
        if (!direct && !dir.startsWith(`${path}-`)) continue;
        const match: FolderMatch = { folder, direct, length: path.length };
        if (best === undefined || better(match, best)) best = match;
      }
    }
  }
  return best?.folder.role;
}

/**
 * This function gives the owner of a container.
 *
 * 1. The folder of its compose project is in a folder of a role: `session:<role>`.
 * 2. Else its project name is the ID of a role: `session:<project>`.
 * 3. Else `docker:<project>`, or `docker:<name>` for a container with no project.
 */
export function containerOwner(
  container: Pick<DockerContainer, "name" | "project" | "workingDir">,
  folders: readonly RoleFolder[],
  roleIds: ReadonlySet<string>,
  forms: (path: string) => readonly string[] = (path) => pathForms(path),
): Pick<DockerContainerStatus, "owner" | "ownerKind" | "ownerFrom"> {
  const role = container.workingDir === null ? undefined : roleOfFolder(forms(container.workingDir), folders);
  if (role !== undefined) return { owner: `session:${role}`, ownerKind: "session", ownerFrom: "folder" };
  if (container.project !== null && roleIds.has(container.project)) return { owner: `session:${container.project}`, ownerKind: "session", ownerFrom: "project" };
  return { owner: `docker:${container.project ?? container.name}`, ownerKind: "docker", ownerFrom: "docker" };
}

/**
 * The owners of the containers of each read, from the fleet roles. The folders of the roles stay until the roles change. The
 * real path of each folder of a project stays for the life of the daemon.
 */
export class ContainerOwners {
  readonly #home: string;
  #roles: readonly FleetRole[] | null = null;
  #folders: readonly RoleFolder[] = [];
  #ids: ReadonlySet<string> = new Set();
  readonly #forms = new Map<string, readonly string[]>();

  constructor(home: string = homedir()) {
    this.#home = home;
  }

  /** This function gives each container with its owner. */
  attribute(containers: readonly DockerContainer[], roles: readonly FleetRole[]): DockerContainerStatus[] {
    if (roles !== this.#roles) {
      this.#roles = roles;
      this.#folders = roleFolders(roles, (path) => pathForms(path, this.#home));
      this.#ids = new Set(roles.filter((role) => role.status !== "retired").map((role) => role.id));
    }
    const forms = (path: string): readonly string[] => {
      let found = this.#forms.get(path);
      if (found === undefined) {
        // A daemon of many days sees few project folders. The limit keeps the map small all the same.
        if (this.#forms.size >= 500) this.#forms.clear();
        found = pathForms(path, this.#home);
        this.#forms.set(path, found);
      }
      return found;
    };
    return containers.map((container) => ({ ...container, ...containerOwner(container, this.#folders, this.#ids, forms) }));
  }
}

// ---- the split of the VM ----

/** This function gives the memory and the cores of the running containers of each owner, the most memory first. */
export function dockerShares(containers: readonly DockerContainerStatus[]): DockerShare[] {
  const shares = new Map<string, { kind: OwnerKind; containers: number; memoryMb: number; cores: number | null }>();
  for (const container of containers) {
    if (container.state !== "running") continue;
    const share = shares.get(container.owner) ?? { kind: container.ownerKind, containers: 0, memoryMb: 0, cores: null };
    share.containers += 1;
    share.memoryMb += container.memoryMb ?? 0;
    if (container.cores !== null) share.cores = (share.cores ?? 0) + container.cores;
    shares.set(container.owner, share);
  }
  return [...shares].map(([owner, share]) => ({ owner, ...share })).sort((a, b) => b.memoryMb - a.memoryMb || a.owner.localeCompare(b.owner));
}

/**
 * This function splits a total among the shares by their amounts. When the shares add up to more than the total, each share
 * gets the same part of its amount. It gives the part of each share and the rest.
 */
export function splitTotal(total: number, amounts: readonly number[]): { readonly parts: number[]; readonly rest: number } {
  const sum = amounts.reduce((a, b) => a + Math.max(0, b), 0);
  const scale = sum > total && sum > 0 ? Math.max(0, total) / sum : 1;
  const parts = amounts.map((amount) => Math.max(0, amount) * scale);
  return { parts, rest: Math.max(0, total - parts.reduce((a, b) => a + b, 0)) };
}

/**
 * This function splits the owner `docker` of the memory among the owners of the containers. The rest is the owner
 * `docker (VM)`. An owner that is already in the list gets the part of its containers. Without a `docker` owner, the list stays.
 */
export function splitOwners(owners: readonly OwnerUsage[], shares: readonly DockerShare[]): OwnerUsage[] {
  const docker = owners.find((owner) => owner.owner === DOCKER);
  if (docker === undefined || shares.length === 0) return docker === undefined ? [...owners] : owners.map((owner) => (owner === docker ? { ...owner, owner: DOCKER_VM } : owner));
  const memory = shares.map((share) => share.memoryMb);
  const privatePart = splitTotal(docker.privateMb, memory);
  const workingPart = splitTotal(docker.workingMb, memory);
  const rows = new Map(owners.filter((owner) => owner !== docker).map((owner) => [owner.owner, { ...owner }]));
  shares.forEach((share, index) => {
    const row = rows.get(share.owner) ?? { owner: share.owner, kind: share.kind, privateMb: 0, workingMb: 0, processes: 0 };
    rows.set(share.owner, { ...row, privateMb: row.privateMb + (privatePart.parts[index] ?? 0), workingMb: row.workingMb + (workingPart.parts[index] ?? 0) });
  });
  rows.set(DOCKER_VM, { owner: DOCKER_VM, kind: docker.kind, privateMb: privatePart.rest, workingMb: workingPart.rest, processes: docker.processes });
  return [...rows.values()].sort((a, b) => b.privateMb - a.privateMb);
}

/** This function splits the cores of the owner `docker` among the owners of the containers, as `splitOwners()` splits the memory. */
export function splitCores(cores: readonly OwnerCores[] | undefined, shares: readonly DockerShare[]): OwnerCores[] | undefined {
  if (cores === undefined) return undefined;
  const docker = cores.find((each) => each.owner === DOCKER);
  if (docker === undefined) return [...cores];
  const measured = shares.filter((share) => share.cores !== null);
  const part = splitTotal(docker.cores, measured.map((share) => share.cores ?? 0));
  const rows = new Map(cores.filter((each) => each !== docker).map((each) => [each.owner, { ...each }]));
  measured.forEach((share, index) => {
    const row = rows.get(share.owner) ?? { owner: share.owner, kind: share.kind, cores: 0 };
    rows.set(share.owner, { ...row, cores: row.cores + (part.parts[index] ?? 0) });
  });
  rows.set(DOCKER_VM, { owner: DOCKER_VM, kind: docker.kind, cores: part.rest });
  return [...rows.values()].sort((a, b) => b.cores - a.cores);
}

/** This function splits the owner `docker` of the rows of an attribute part of the memory. A lease row stays as it is. */
export function splitUses(uses: readonly OwnerUse[], shares: readonly DockerShare[]): OwnerUse[] {
  const docker = uses.find((use) => use.owner === DOCKER);
  if (docker === undefined) return [...uses];
  const part = splitTotal(docker.amount, shares.map((share) => share.memoryMb));
  const rows = new Map(uses.filter((use) => use !== docker).map((use) => [use.owner, { ...use }]));
  shares.forEach((share, index) => {
    const row = rows.get(share.owner) ?? { resource: docker.resource, owner: share.owner, kind: share.kind, amount: 0, processes: 0 };
    rows.set(share.owner, { ...row, amount: row.amount + (part.parts[index] ?? 0) });
  });
  rows.set(DOCKER_VM, { ...docker, owner: DOCKER_VM, amount: part.rest });
  return [...rows.values()].sort((a, b) => b.amount - a.amount);
}

/** This function gives the VM processes of a read of the processes, or `null` when none runs. */
export function vmOf(processes: readonly ProcessInfo[]): DockerVm | null {
  const found = processes.filter((info) => VM_PROCESSES.has(info.name.toLowerCase().replace(/\.exe$/, "")));
  const first = found[0];
  if (first === undefined) return null;
  return {
    name: first.name,
    privateMb: found.reduce((sum, info) => sum + info.privateMb, 0),
    workingMb: found.reduce((sum, info) => sum + info.workingMb, 0),
    processes: found.length,
  };
}

/** The facts of the status of Docker at one read of the processes. */
export interface DockerFacts {
  readonly read: DockerRead;
  readonly containers: readonly DockerContainerStatus[];
  readonly shares: readonly DockerShare[];
  readonly processes: readonly ProcessInfo[];
  /** The owners of the memory after the split. */
  readonly owners: readonly OwnerUsage[];
  /** The cores of each owner after the split. */
  readonly cores: readonly OwnerCores[] | undefined;
}

/** This function gives the Docker resource of the status. */
export function dockerStatus(facts: DockerFacts): DockerStatus {
  const running = facts.containers.filter((container) => container.state === "running");
  const measured = running.filter((container) => container.cores !== null);
  const rest = facts.owners.find((owner) => owner.owner === DOCKER_VM);
  const restCores = facts.cores?.find((each) => each.owner === DOCKER_VM);
  return {
    at: facts.read.at,
    version: facts.read.version,
    api: facts.read.api,
    containers: facts.containers,
    running: running.length,
    memoryMb: running.reduce((sum, container) => sum + (container.memoryMb ?? 0), 0),
    cores: measured.length === 0 ? null : measured.reduce((sum, container) => sum + (container.cores ?? 0), 0),
    owners: facts.shares,
    vm: vmOf(facts.processes),
    rest: rest === undefined ? null : { privateMb: rest.privateMb, workingMb: rest.workingMb, cores: restCores?.cores ?? null },
    disk: facts.read.disk,
    readMs: facts.read.readMs,
  };
}

// ---- the alerts and the text ----

/** The hint of the Docker alerts. headroom does not start a prune. */
export const DOCKER_PRUNE_HINT = "docker builder prune or docker image prune frees it (headroom does not run them).";

/** One Docker alert, without its start time. */
export interface DockerAlert {
  readonly id: string;
  readonly kind: "docker";
  readonly subject: string;
  readonly pid: null;
  readonly mb: number;
  readonly message: string;
  readonly severity: "warning";
}

/** This function gives the Docker alerts: a warning when the build cache or the images with no container are above their limits. */
export function dockerAlerts(disk: DockerDisk | null | undefined, rules: Pick<AlertRules, "dockerBuildCacheMb" | "dockerUnusedImagesMb">): DockerAlert[] {
  if (disk === null || disk === undefined) return [];
  const alerts: DockerAlert[] = [];
  if (disk.buildCacheMb > rules.dockerBuildCacheMb) {
    const unused = disk.buildCacheUnusedMb >= 1024 ? ` ${diskSize(disk.buildCacheUnusedMb)} of it is not in use.` : "";
    alerts.push({
      id: "docker:build-cache",
      kind: "docker",
      subject: "Docker build cache",
      pid: null,
      mb: Math.round(disk.buildCacheMb),
      message: `The Docker build cache is ${diskSize(disk.buildCacheMb)}, above the limit of ${diskSize(rules.dockerBuildCacheMb)}.${unused} ${DOCKER_PRUNE_HINT}`,
      severity: "warning",
    });
  }
  if (disk.unusedImagesMb > rules.dockerUnusedImagesMb) {
    alerts.push({
      id: "docker:images",
      kind: "docker",
      subject: "Docker images",
      pid: null,
      mb: Math.round(disk.unusedImagesMb),
      message: `The Docker images with no container use ${diskSize(disk.unusedImagesMb)} (${disk.unusedImages} of ${disk.images} images), above the limit of ${diskSize(rules.dockerUnusedImagesMb)}. ${DOCKER_PRUNE_HINT}`,
      severity: "warning",
    });
  }
  return alerts;
}

/** This function gives cores as text: "0.25 cores", or "0.02 cores". */
const coresText = (cores: number): string => `${cores < 0.1 ? cores.toFixed(2) : cores.toFixed(1)} cores`;

/**
 * This function gives the Docker line of `headroom status`, or `null` with no read. For example: "Docker: 6 containers,
 * 2.1 GB. Most: session:graph neo4j 1.2 GB. Build cache 14 GB."
 */
export function dockerLine(docker: DockerStatus | null | undefined): string | null {
  if (docker === null || docker === undefined) return null;
  const parts = [`Docker: ${docker.running} ${docker.running === 1 ? "container" : "containers"}, ${gb(docker.memoryMb)}${docker.cores === null ? "" : `, ${coresText(docker.cores)}`}.`];
  const top = docker.containers.find((container) => container.state === "running");
  if (top !== undefined && top.memoryMb !== null) parts.push(`Most: ${top.owner} ${top.name} ${gb(top.memoryMb)}.`);
  if (docker.disk !== null) parts.push(`Build cache ${diskSize(docker.disk.buildCacheMb)}. Unused images ${diskSize(docker.disk.unusedImagesMb)}.`);
  return parts.join(" ");
}
