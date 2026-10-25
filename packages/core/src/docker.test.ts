import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, detect } from "./alerts.ts";
import {
  compareApi,
  containerOwner,
  ContainerOwners,
  coresBetween,
  DOCKER_VM,
  dockerAlerts,
  dockerLine,
  DockerReader,
  dockerShares,
  dockerStatus,
  memoryBytes,
  normalPath,
  parseContainers,
  parseDf,
  parseStats,
  parseVersion,
  roleFolders,
  splitCores,
  splitOwners,
  splitTotal,
  splitUses,
  vmOf,
  type DockerAnswer,
  type DockerContainerStatus,
  type DockerDisk,
  type DockerGet,
} from "./docker.ts";
import { Engine } from "./engine.ts";
import { attribute, unattributedMb } from "./owners.ts";
import type { FleetRole } from "./peer.ts";
import type { OwnerUse } from "./resources.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";
import type { OwnerUsage, ProcessInfo, SystemMemory } from "./types.ts";

const MB = 1024 * 1024;
const HOME = "C:\\Users\\markt";
const ID_GRAPH = "0bad49c6cfc8a08f34e3f7f2c5a50c749d4bccf33bca2d497250c62dcb74401f";
const ID_MONGO = "376ccc870187aaaa";

/** A list of containers in the shape of `GET /containers/json`, from this computer on 2026-10-25. */
const LIST = [
  {
    Id: ID_GRAPH,
    Names: ["/graph-mongo-1"],
    Image: "mongo:7",
    State: "running",
    Labels: { "com.docker.compose.project": "graph", "com.docker.compose.project.working_dir": "D:\\git\\Graph" },
  },
  { Id: "8dc2a0791127", Names: ["/dynamodb-local"], Image: "amazon/dynamodb-local", State: "exited", Labels: {} },
  {
    Id: ID_MONGO,
    Names: ["/mongo-db"],
    Image: "mongo:6",
    State: "running",
    Labels: { "com.docker.compose.project": "mongo", "com.docker.compose.project.working_dir": "C:\\Users\\markt\\git\\docker\\mongo" },
  },
  { Names: ["/no-id"] },
];

/** The stats of one container in the shape of the engine (cgroup v2). */
function stats(usageMb: number, inactiveMb: number, totalNs: number, read: string): unknown {
  return {
    read,
    preread: "0001-01-01T00:00:00Z",
    memory_stats: { usage: usageMb * MB, stats: { inactive_file: inactiveMb * MB, active_file: 100 * MB }, limit: 7940 * MB },
    cpu_stats: { cpu_usage: { total_usage: totalNs }, online_cpus: 16 },
    precpu_stats: { cpu_usage: { total_usage: 0 } },
  };
}

/** A disk read with the summaries of API 1.52 and later. */
const DF_NEW = {
  LayersSize: 35_536_666_202,
  Images: [{ Id: "sha256:a", Containers: 1, Size: 900 * MB, SharedSize: 100 * MB }],
  Containers: [{ Id: ID_GRAPH, SizeRw: 8192 }],
  Volumes: [],
  BuildCache: [],
  ImageUsage: { ActiveCount: 3, Reclaimable: 28_101_728_246, TotalCount: 102, TotalSize: 35_536_666_202 },
  ContainerUsage: { ActiveCount: 1, Reclaimable: 1_884_160, TotalCount: 4, TotalSize: 1_892_352 },
  VolumeUsage: { ActiveCount: 6, Reclaimable: 1_551_679_342, TotalCount: 34, TotalSize: 2_560_918_350 },
  BuildCacheUsage: { Reclaimable: 7_039_633_129, TotalCount: 229, TotalSize: 18_352_624_120 },
};

/** A disk read of an older engine, with only the lists. */
const DF_OLD = {
  LayersSize: 3000 * MB,
  Images: [
    { Id: "sha256:a", Containers: 1, Size: 1000 * MB, SharedSize: 200 * MB },
    { Id: "sha256:b", Containers: 0, Size: 1500 * MB, SharedSize: 200 * MB },
    { Id: "sha256:c", Containers: 0, Size: 700 * MB, SharedSize: -1 },
  ],
  Containers: [{ Id: ID_GRAPH, SizeRw: 2 * MB }, { Id: ID_MONGO, SizeRw: 3 * MB }],
  Volumes: [
    { Name: "a", UsageData: { Size: 400 * MB, RefCount: 1 } },
    { Name: "b", UsageData: { Size: 100 * MB, RefCount: 0 } },
    { Name: "c", UsageData: { Size: -1, RefCount: -1 } },
  ],
  BuildCache: [
    { ID: "1", Size: 500 * MB, Shared: false, InUse: false },
    { ID: "2", Size: 300 * MB, Shared: false, InUse: true },
    { ID: "3", Size: 900 * MB, Shared: true, InUse: false },
  ],
};

/** A fake engine: each path gives a JSON answer, or a function gives one. */
function fakeEngine(routes: Record<string, unknown | (() => unknown)>): { get: DockerGet; paths: string[] } {
  const paths: string[] = [];
  const get: DockerGet = async (path) => {
    paths.push(path);
    const key = Object.keys(routes).find((route) => path === route || path.startsWith(`${route}?`));
    if (key === undefined) return { status: 404, body: '{"message":"no such path"}' } satisfies DockerAnswer;
    const route = routes[key];
    const value = typeof route === "function" ? (route as () => unknown)() : route;
    if (value instanceof Error) throw value;
    return { status: 200, body: JSON.stringify(value) };
  };
  return { get, paths };
}

const role = (id: string, repos: string[], status = "active"): FleetRole => ({ id, status, sessionId: null, sessionName: id, repos });
/** The normal forms of a path with no file system: `~/git` is a link to `D:\git`, as on this computer. */
const forms = (path: string): string[] => {
  const normal = normalPath(path, HOME);
  return normal.startsWith("c:/users/markt/git/") ? [normal, `d:/git/${normal.slice("c:/users/markt/git/".length)}`] : [normal];
};

describe("the parse of the answers of the engine", () => {
  it("reads the version, and compares API versions", () => {
    expect(parseVersion({ Version: "29.9.2", ApiVersion: "1.56", Os: "linux" })).toEqual({ version: "29.9.2", api: "1.56", os: "linux" });
    expect(() => parseVersion({ Version: "1" })).toThrow(/no API version/);
    expect(() => parseVersion({ ApiVersion: "../1" })).toThrow(/no API version/);
    expect(compareApi("1.56", "1.41")).toBeGreaterThan(0);
    expect(compareApi("1.40", "1.41")).toBeLessThan(0);
    expect(compareApi("1.41", "1.41")).toBe(0);
  });

  it("reads the list of containers with their compose labels, and skips an entry with no ID", () => {
    const listed = parseContainers(LIST);
    expect(listed).toHaveLength(3);
    expect(listed[0]).toEqual({ id: ID_GRAPH, name: "graph-mongo-1", image: "mongo:7", state: "running", project: "graph", workingDir: "D:\\git\\Graph" });
    expect(listed[1]).toMatchObject({ name: "dynamodb-local", state: "exited", project: null, workingDir: null });
    expect(parseContainers({ message: "not a list" })).toEqual([]);
  });

  it("gives the memory as docker stats does: the use less the inactive file cache", () => {
    // cgroup v2: inactive_file.
    expect(memoryBytes({ usage: 600 * MB, stats: { inactive_file: 30 * MB } })).toBe(570 * MB);
    // cgroup v1: total_inactive_file wins.
    expect(memoryBytes({ usage: 600 * MB, stats: { total_inactive_file: 100 * MB, inactive_file: 30 * MB } })).toBe(500 * MB);
    // A cache larger than the use does not count.
    expect(memoryBytes({ usage: 10 * MB, stats: { inactive_file: 30 * MB } })).toBe(10 * MB);
    expect(memoryBytes({ usage: 10 * MB })).toBe(10 * MB);
    expect(memoryBytes({})).toBeNull();
    const each = parseStats(stats(600, 30, 2_921_023_767_000, "2026-10-25T09:42:40.625366404Z"));
    expect(each).toEqual({ memoryMb: 570, limitMb: 7940, cpuNs: 2_921_023_767_000, at: Date.parse("2026-10-25T09:42:40.625Z") });
    // Windows containers count the processor time in units of 100 ns. No time of the engine gives null.
    expect(parseStats({ cpu_stats: { cpu_usage: { total_usage: 5 } }, read: "0001-01-01T00:00:00Z" }, "windows")).toMatchObject({ cpuNs: 500, at: null, memoryMb: null });
  });

  it("gives the cores from two reads of the processor time, and none after a new start", () => {
    expect(coresBetween(undefined, 1000, 5)).toBeNull();
    expect(coresBetween({ at: 0, ns: 0 }, 30_000, 15e9)).toBe(0.5);
    expect(coresBetween({ at: 0, ns: 20e9 }, 30_000, 15e9)).toBeNull();
    expect(coresBetween({ at: 30_000, ns: 0 }, 30_000, 15e9)).toBeNull();
  });

  it("reads the disk use from the summaries of a new engine", () => {
    const { disk, sizeRw } = parseDf(DF_NEW, 5, 4600.4);
    expect(disk).toMatchObject({ at: 5, images: 102, unusedImages: 99, volumes: 34, readMs: 4600 });
    const rounded = (mb: number): number => Math.round(mb);
    expect([disk.imagesMb, disk.unusedImagesMb, disk.buildCacheMb, disk.buildCacheUnusedMb, disk.volumesMb, disk.unusedVolumesMb, disk.containersMb].map(rounded)).toEqual([
      33_890, 26_800, 17_502, 6714, 2442, 1480, 2,
    ]);
    expect(sizeRw.get(ID_GRAPH)).toBeCloseTo(0.0078, 4);
  });

  it("adds up the lists of an older engine, as docker system df does", () => {
    const { disk, sizeRw } = parseDf(DF_OLD, 5, 10);
    // The image with a container uses 1000 less 200 MB of the 3000 MB of layers.
    expect(disk).toMatchObject({ imagesMb: 3000, images: 3, unusedImagesMb: 2200, unusedImages: 2 });
    // A shared record does not count. A record in use is not free.
    expect(disk).toMatchObject({ buildCacheMb: 800, buildCacheUnusedMb: 500 });
    expect(disk).toMatchObject({ volumesMb: 500, volumes: 3, unusedVolumesMb: 100, containersMb: 5 });
    expect(sizeRw.get(ID_MONGO)).toBe(3);
    expect(parseDf(null, 0, 0).disk).toMatchObject({ imagesMb: 0, images: 0, buildCacheMb: 0, volumesMb: 0 });
  });
});

describe("the reader of the engine", () => {
  const routes = (total: () => number): Record<string, unknown | (() => unknown)> => ({
    "/version": { Version: "29.9.2", ApiVersion: "1.56", Os: "linux" },
    "/v1.56/containers/json": LIST,
    [`/v1.56/containers/${ID_GRAPH}/stats`]: () => stats(600, 30, total(), new Date(clock).toISOString()),
    [`/v1.56/containers/${ID_MONGO}/stats`]: () => stats(300, 0, 0, new Date(clock).toISOString()),
    "/v1.56/system/df": DF_NEW,
  });
  let clock = 1_000_000;

  it("reads the containers with one-shot stats, the CPU from two reads, and the disk only every 10 minutes", async () => {
    clock = 1_000_000;
    let total = 1e12;
    const engine = fakeEngine(routes(() => total));
    const log: string[] = [];
    const reader = new DockerReader({ get: engine.get, now: () => clock, log: (line) => log.push(line) });
    const first = await reader.read();
    expect(first).toMatchObject({ version: "29.9.2", api: "1.56", at: 1_000_000 });
    expect(first?.containers.map((each) => [each.name, each.state, each.memoryMb, each.cores])).toEqual([
      ["graph-mongo-1", "running", 570, null],
      ["mongo-db", "running", 300, null],
      ["dynamodb-local", "exited", null, null],
    ]);
    expect(first?.disk?.images).toBe(102);
    expect(first?.containers[0]?.sizeRwMb).toBeCloseTo(0.0078, 4);
    expect(engine.paths).toContain(`/v1.56/containers/${ID_GRAPH}/stats?stream=false&one-shot=true`);
    expect(engine.paths.filter((path) => path.includes("system/df"))).toHaveLength(1);
    expect(log).toEqual(["The Docker engine answers: version 29.9.2, API 1.56. headroom reads its containers every 30 s."]);

    // 30 seconds later, the container used 15 s of processor time: 0.5 cores. The disk read is not due.
    clock += 30_000;
    total += 15e9;
    const second = await reader.read();
    expect(second?.containers[0]?.cores).toBeCloseTo(0.5, 6);
    expect(second?.containers[1]?.cores).toBe(0);
    expect(engine.paths.filter((path) => path.includes("system/df"))).toHaveLength(1);
    expect(engine.paths.filter((path) => path === "/version")).toHaveLength(1);
    expect(reader.last()).toBe(second);

    clock += 10 * 60_000;
    await reader.read();
    expect(engine.paths.filter((path) => path.includes("system/df"))).toHaveLength(2);
  });

  it("starts a read only when one is due and no read runs", async () => {
    clock = 1_000_000;
    let release = (): void => undefined;
    const paths: string[] = [];
    const slow: DockerGet = (path) => {
      paths.push(path);
      return new Promise((resolve) => {
        release = () => resolve({ status: 200, body: JSON.stringify({ ApiVersion: "1.56" }) });
      });
    };
    const reader = new DockerReader({ get: slow, now: () => clock });
    reader.poll();
    reader.poll();
    clock += 60_000;
    reader.poll();
    expect(paths).toEqual(["/version"]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The list fails with the version answer, so the reader has no read. The next poll waits for 30 seconds.
    clock += 1000;
    reader.poll();
    expect(paths.filter((path) => path === "/version")).toHaveLength(1);
  });

  it("has no read and one log line when the pipe does not exist, and a new log line when the engine answers", async () => {
    clock = 1_000_000;
    let up = false;
    const missing = Object.assign(new Error("connect ENOENT \\\\.\\pipe\\docker_engine"), { code: "ENOENT" });
    const engine = fakeEngine({ ...routes(() => 1e12), "/version": () => (up ? { Version: "29.9.2", ApiVersion: "1.56" } : missing) });
    const log: string[] = [];
    const reader = new DockerReader({ get: engine.get, now: () => clock, log: (line) => log.push(line) });
    expect(await reader.read()).toBeUndefined();
    expect(await reader.read()).toBeUndefined();
    expect(reader.state()).toBe("absent");
    expect(reader.last()).toBeUndefined();
    expect(log).toEqual(["The Docker engine is absent: its pipe does not exist. headroom reads no containers until it answers."]);
    up = true;
    expect((await reader.read())?.containers).toHaveLength(3);
    expect(reader.state()).toBe("ok");
    expect(log).toHaveLength(2);
  });

  it("gives down for an engine that fails, and keeps the other containers when one stats request fails", async () => {
    clock = 1_000_000;
    const engine = fakeEngine({ ...routes(() => 1e12), [`/v1.56/containers/${ID_MONGO}/stats`]: new Error("no such container") });
    const reader = new DockerReader({ get: engine.get, now: () => clock });
    const read = await reader.read();
    expect(read?.containers.find((each) => each.name === "mongo-db")).toMatchObject({ state: "running", memoryMb: null, cores: null });
    expect(read?.containers.find((each) => each.name === "graph-mongo-1")?.memoryMb).toBe(570);

    const log: string[] = [];
    const broken = new DockerReader({ get: async () => ({ status: 500, body: "{}" }), now: () => clock, log: (line) => log.push(line) });
    expect(await broken.read()).toBeUndefined();
    expect(broken.state()).toBe("down");
    expect(log[0]).toMatch(/^The Docker engine does not answer: The Docker engine gave HTTP 500 for \/version\./);
  });

  it("leaves out one-shot for an engine older than API 1.41", async () => {
    const engine = fakeEngine({ "/version": { ApiVersion: "1.40" }, "/v1.40/containers/json": LIST.slice(0, 1), [`/v1.40/containers/${ID_GRAPH}/stats`]: stats(10, 0, 0, "x") });
    await new DockerReader({ get: engine.get, now: () => 0 }).read();
    expect(engine.paths).toContain(`/v1.40/containers/${ID_GRAPH}/stats?stream=false`);
  });
});

describe("the owner of a container", () => {
  const roles = [
    role("graph", ["~/git/Graph", "~/git/client", "~/git/render"]),
    role("server-stack", ["~/git/systems", "~/git/client", "~/jarvis", "~/git/Graph", "~/git/MiniMongo"]),
    role("systems", ["~/git/systems", "~/jarvis"]),
    role("client", ["~/git/client"]),
    role("render", ["~/git/render"], "parked"),
    role("headroom", ["~/git/headroom"]),
    role("jarvis-client", ["~/jarvis", "~/git/client"], "retired"),
    role("jarvis", ["~/jarvis"]),
    role("vex", []),
  ];
  const folders = roleFolders(roles, forms);
  const ids = new Set(roles.filter((each) => each.status !== "retired").map((each) => each.id));
  const owner = (workingDir: string | null, project: string | null = "p", name = "c"): string => containerOwner({ name, project, workingDir }, folders, ids, forms).owner;

  it("gives the role of the folder of the compose project, through the link of ~/git", () => {
    expect(owner("D:\\git\\Graph")).toBe("session:graph");
    expect(owner("C:\\Users\\markt\\git\\Graph\\docker")).toBe("session:graph");
    expect(owner("/mnt/d/git/headroom/test")).toBe("session:headroom");
    expect(owner("C:\\Users\\markt\\git\\MiniMongo\\node_modules\\@mark1russell7\\docker-mongo")).toBe("session:server-stack");
  });

  it("decides between roles with the same folder: the role with the name of the folder, then the main repository, then an active role", () => {
    // Two main repositories: systems has the name of the folder.
    expect(owner("D:\\git\\systems\\compose")).toBe("session:systems");
    // ~/git/client is the main repository of client only.
    expect(owner("D:\\git\\client")).toBe("session:client");
    // render is parked, but it has the name of the folder. The retired role does not count.
    expect(owner("D:\\git\\render")).toBe("session:render");
    expect(owner("C:\\Users\\markt\\jarvis")).toBe("session:jarvis");
  });

  it("gives a worktree next to a repository to its role, and a deeper folder wins", () => {
    expect(owner("D:\\git\\headroom-wt3")).toBe("session:headroom");
    expect(owner("D:\\git\\Graph-wt\\compose")).toBe("session:graph");
  });

  it("uses the project name when it is a role, else docker:<project> or docker:<name>", () => {
    expect(containerOwner({ name: "x", project: "vex", workingDir: "E:\\elsewhere" }, folders, ids, forms)).toEqual({ owner: "session:vex", ownerKind: "session", ownerFrom: "project" });
    expect(owner("C:\\Users\\markt\\git\\docker\\mongo", "mongo")).toBe("docker:mongo");
    expect(owner(null, null, "dynamodb-local")).toBe("docker:dynamodb-local");
    // A retired role is not a project role.
    expect(owner(null, "jarvis-client")).toBe("docker:jarvis-client");
    expect(owner("D:\\git\\Graph", null)).toBe("session:graph");
  });

  it("reads the folders from the role files and keeps them until the roles change", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-docker-"));
    try {
      const repo = join(dir, "Graph");
      mkdirSync(join(repo, "compose"), { recursive: true });
      const owners = new ContainerOwners(dir);
      const container = { id: "a", name: "neo4j", image: "neo4j", state: "running", project: "x", workingDir: join(repo, "compose"), memoryMb: 1, limitMb: null, cores: null, sizeRwMb: null };
      const book = [role("graph", ["~/Graph"])];
      expect(owners.attribute([container], book)[0]).toMatchObject({ owner: "session:graph", ownerKind: "session", ownerFrom: "folder" });
      expect(owners.attribute([container], [role("graph", [])])[0]?.owner).toBe("docker:x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives a path in its normal form", () => {
    expect(normalPath("~\\git\\Graph\\", HOME)).toBe("c:/users/markt/git/graph");
    expect(normalPath("/mnt/d/", HOME)).toBe("d:/");
    expect(normalPath("/mnt/data/x", HOME)).toBe("/mnt/data/x");
    expect(normalPath("D:\\", HOME)).toBe("d:/");
  });
});

/** A container with an owner, for the split. */
const container = (name: string, owner: string, memoryMb: number | null, cores: number | null, state = "running"): DockerContainerStatus => ({
  id: name,
  name,
  image: "img",
  state,
  project: null,
  workingDir: null,
  memoryMb,
  limitMb: null,
  cores,
  sizeRwMb: null,
  owner,
  ownerKind: owner.startsWith("session:") ? "session" : "docker",
  ownerFrom: owner.startsWith("session:") ? "folder" : "docker",
});

describe("the split of the Docker VM", () => {
  const containers = [
    container("neo4j", "session:graph", 1200, 0.5),
    container("mongo", "session:graph", 300, 0.1),
    container("db", "docker:mongo", 500, null),
    container("old", "docker:old", 900, 2, "exited"),
  ];
  const shares = dockerShares(containers);
  const owners: OwnerUsage[] = [
    { owner: "browser", kind: "browser", privateMb: 3000, workingMb: 2800, processes: 40 },
    { owner: "docker", kind: "docker", privateMb: 3082, workingMb: 2007, processes: 19 },
    { owner: "session:graph", kind: "session", privateMb: 900, workingMb: 1000, processes: 9 },
  ];

  it("gives the memory and the cores of the running containers of each owner", () => {
    expect(shares).toEqual([
      { owner: "session:graph", kind: "session", containers: 2, memoryMb: 1500, cores: 0.6 },
      { owner: "docker:mongo", kind: "docker", containers: 1, memoryMb: 500, cores: null },
    ]);
  });

  it("gives the containers their part of the owner docker, and the rest to docker (VM)", () => {
    const split = splitOwners(owners, shares);
    expect(split.find((each) => each.owner === "session:graph")).toEqual({ owner: "session:graph", kind: "session", privateMb: 2400, workingMb: 2500, processes: 9 });
    expect(split.find((each) => each.owner === "docker:mongo")).toEqual({ owner: "docker:mongo", kind: "docker", privateMb: 500, workingMb: 500, processes: 0 });
    expect(split.find((each) => each.owner === DOCKER_VM)).toEqual({ owner: DOCKER_VM, kind: "docker", privateMb: 1082, workingMb: 7, processes: 19 });
    expect(split.some((each) => each.owner === "docker")).toBe(false);
    // The split keeps the totals, and the list stays sorted by the private memory.
    expect(split.reduce((sum, each) => sum + each.privateMb, 0)).toBe(6982);
    expect(split.map((each) => each.owner)).toEqual(["browser", "session:graph", DOCKER_VM, "docker:mongo"]);
  });

  it("scales the parts down when the containers have more than the VM", () => {
    expect(splitTotal(1000, [1500, 500])).toEqual({ parts: [750, 250], rest: 0 });
    expect(splitTotal(1000, [300, 200])).toEqual({ parts: [300, 200], rest: 500 });
    const split = splitOwners([{ owner: "docker", kind: "docker", privateMb: 1000, workingMb: 400, processes: 3 }], shares);
    expect(split.find((each) => each.owner === "session:graph")).toMatchObject({ privateMb: 750, workingMb: 300 });
    expect(split.find((each) => each.owner === DOCKER_VM)).toMatchObject({ privateMb: 0, workingMb: 0 });
  });

  it("keeps a list with no owner docker, and renames docker when no container runs", () => {
    const others = owners.filter((each) => each.owner !== "docker");
    expect(splitOwners(others, shares)).toEqual(others);
    expect(splitOwners(owners, []).map((each) => each.owner)).toEqual(["browser", DOCKER_VM, "session:graph"]);
  });

  it("splits the cores of docker among the containers with two reads", () => {
    const cores = splitCores(
      [
        { owner: "system", kind: "system", cores: 1 },
        { owner: "docker", kind: "docker", cores: 0.8 },
      ],
      shares,
    );
    expect(cores).toEqual([
      { owner: "system", kind: "system", cores: 1 },
      { owner: "session:graph", kind: "session", cores: 0.6 },
      { owner: DOCKER_VM, kind: "docker", cores: expect.closeTo(0.2, 6) as unknown as number },
    ]);
    expect(splitCores(undefined, shares)).toBeUndefined();
  });

  it("splits the owner docker of the attribute part of the memory, and keeps the lease rows", () => {
    const uses: OwnerUse[] = [
      { resource: "memory", owner: "docker", kind: "docker", amount: 3000, processes: 19 },
      { resource: "memory", owner: "lease:abc", kind: "lease", amount: 200, processes: 2 },
    ];
    expect(splitUses(uses, shares)).toEqual([
      { resource: "memory", owner: "session:graph", kind: "session", amount: 1500, processes: 0 },
      { resource: "memory", owner: DOCKER_VM, kind: "docker", amount: 1000, processes: 19 },
      { resource: "memory", owner: "docker:mongo", kind: "docker", amount: 500, processes: 0 },
      { resource: "memory", owner: "lease:abc", kind: "lease", amount: 200, processes: 2 },
    ]);
  });

  it("counts the memory of the VM one time: the containers take their part of it and add none (H49)", () => {
    // The system read gives the memory of vmmemWSL. The containers run in that memory, so the split moves a part of it.
    const processes: ProcessInfo[] = [
      { pid: 7804, ppid: 4, name: "vmmemWSL", privateMb: 2238, workingMb: 1417 },
      { pid: 5228, ppid: 1, name: "com.docker.backend.exe", privateMb: 180, workingMb: 157 },
      { pid: 6000, ppid: 1, name: "chrome.exe", privateMb: 900, workingMb: 600 },
    ];
    const memory = { totalMb: 28_000, availableMb: 6000, commitMb: 30_000, commitLimitMb: 60_000, kernelPagedMb: 1000, kernelNonpagedMb: 4000 };
    const { owners: before } = attribute(processes, [], memory);
    const sum = (list: readonly OwnerUsage[], key: "privateMb" | "workingMb"): number => list.reduce((total, each) => total + each[key], 0);
    for (const running of [shares, dockerShares([container("big", "session:graph", 5000, 1)])]) {
      const after = splitOwners(before, running);
      expect(sum(after, "privateMb")).toBeCloseTo(sum(before, "privateMb"), 6);
      expect(sum(after, "workingMb")).toBeCloseTo(sum(before, "workingMb"), 6);
      expect(unattributedMb(memory, after)).toBe(unattributedMb(memory, before));
    }
    // The VM and the Docker programs hold 2418 MB private and 1574 MB in RAM. The containers have 2000 MB.
    const split = splitOwners(before, shares);
    expect(split.find((each) => each.owner === DOCKER_VM)).toMatchObject({ privateMb: 418, workingMb: 0 });
    expect(split.find((each) => each.owner === "session:graph")?.workingMb).toBeCloseTo(1574 * 0.75, 6);
    expect(sum(split.filter((each) => each.owner !== "browser" && each.owner !== "kernel"), "workingMb")).toBeCloseTo(1574, 6);
  });

  it("gives the VM processes", () => {
    const processes: ProcessInfo[] = [
      { pid: 7804, ppid: 4, name: "vmmemWSL", privateMb: 2190, workingMb: 1260 },
      { pid: 5228, ppid: 1, name: "com.docker.backend.exe", privateMb: 180, workingMb: 157 },
    ];
    expect(vmOf(processes)).toEqual({ name: "vmmemWSL", privateMb: 2190, workingMb: 1260, processes: 1 });
    expect(vmOf(processes.slice(1))).toBeNull();
  });
});

describe("the Docker alerts and the line of the status", () => {
  const disk = (buildCacheMb: number, unusedImagesMb: number): DockerDisk => ({
    at: 0, imagesMb: 33_000, images: 102, unusedImagesMb, unusedImages: 99, buildCacheMb, buildCacheUnusedMb: 6600,
    volumesMb: 2400, volumes: 34, unusedVolumesMb: 1400, containersMb: 2, readMs: 4600,
  });

  it("warns above 20 GB of build cache or 10 GB of images with no container, with the prune hint", () => {
    expect(dockerAlerts(disk(17_500, 9000), DEFAULT_ALERT_RULES)).toEqual([]);
    expect(dockerAlerts(null, DEFAULT_ALERT_RULES)).toEqual([]);
    const alerts = dockerAlerts(disk(21_000, 26_800), DEFAULT_ALERT_RULES);
    expect(alerts.map((alert) => [alert.id, alert.kind, alert.severity, alert.mb])).toEqual([
      ["docker:build-cache", "docker", "warning", 21_000],
      ["docker:images", "docker", "warning", 26_800],
    ]);
    expect(alerts[0]?.message).toBe(
      "The Docker build cache is 20.5 GB, above the limit of 20 GB. 6.4 GB of it is not in use. docker builder prune or docker image prune frees it (headroom does not run them).",
    );
    expect(alerts[1]?.message).toBe(
      "The Docker images with no container use 26.2 GB (99 of 102 images), above the limit of 10 GB. docker builder prune or docker image prune frees it (headroom does not run them).",
    );
  });

  it("gives the alerts through detect(), with the limits of the rules", () => {
    const memory: SystemMemory = { totalMb: 28_000, availableMb: 9000, commitMb: 20_000, commitLimitMb: 80_000, kernelPagedMb: 500, kernelNonpagedMb: 400 };
    const docker = { disk: disk(17_500, 26_800) } as Parameters<typeof detect>[0]["docker"];
    const input = { memory, processes: [], ownerOf: new Map<number, string>(), kindOf: new Map(), leases: [], docker };
    expect(detect(input).map((alert) => alert.id)).toEqual(["docker:images"]);
    expect(detect(input, { ...DEFAULT_ALERT_RULES, dockerUnusedImagesMb: 30_000, dockerBuildCacheMb: 10_000 }).map((alert) => alert.id)).toEqual(["docker:build-cache"]);
  });

  it("gives one line for headroom status", () => {
    const containers = [container("neo4j", "session:graph", 1228.8, 0.5), container("db", "docker:mongo", 921.6, 0.02)];
    const read = { at: 0, version: "29.9.2", api: "1.56", containers, disk: disk(14_336, 2048), readMs: 60 };
    const status = dockerStatus({ read, containers, shares: dockerShares(containers), processes: [], owners: [], cores: undefined });
    expect(dockerLine(status)).toBe("Docker: 2 containers, 2.1 GB, 0.5 cores. Most: session:graph neo4j 1.2 GB. Build cache 14 GB. Unused images 2 GB.");
    expect(dockerLine(null)).toBeNull();
  });
});

describe("the engine with a Docker read", () => {
  const memory: SystemMemory = { totalMb: 28_000, availableMb: 9000, commitMb: 20_000, commitLimitMb: 80_000, kernelPagedMb: 500, kernelNonpagedMb: 400 };

  it("gives the containers to the session of their folder, splits the VM, and alerts on the disk use", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-engine-docker-"));
    try {
      const graph = join(dir, "Graph");
      mkdirSync(join(dir, "roles"), { recursive: true });
      mkdirSync(graph, { recursive: true });
      writeFileSync(join(dir, "roles.json"), "{}");
      writeFileSync(join(dir, "roles", "graph.json"), JSON.stringify({ id: "graph", status: "active", repos: [graph], session: { name: "graph" } }));
      const processes: ProcessInfo[] = [
        { pid: 4, ppid: 0, name: "System", privateMb: 0, workingMb: 0 },
        { pid: 7804, ppid: 4, name: "vmmemWSL", privateMb: 2200, workingMb: 1300 },
        { pid: 5228, ppid: 1, name: "com.docker.backend.exe", privateMb: 200, workingMb: 100 },
      ];
      const sampler: Sampler = { memory: () => memory, processes: () => processes, close: () => undefined };
      const containers = [
        { id: "a", name: "graph-mongo-1", image: "mongo:7", state: "running", project: "graph-tests", workingDir: graph, memoryMb: 566, limitMb: null, cores: 0.4, sizeRwMb: 0 },
        { id: "b", name: "dynamodb-local", image: "x", state: "exited", project: null, workingDir: null, memoryMb: null, limitMb: null, cores: null, sizeRwMb: 0 },
      ];
      let read = { at: 1, version: "29.9.2", api: "1.56", containers, disk: { ...parseDf(DF_NEW, 1, 4600).disk }, readMs: 60 } as ReturnType<DockerReader["last"]>;
      let now = 1_000_000;
      const engine = new Engine({ sampler, store: new Store(":memory:"), sessionsDir: "/nowhere", processors: 16, now: () => now, rolesFile: join(dir, "roles.json"), docker: () => read });
      engine.tick();
      const status = engine.status();
      expect(status.docker).toMatchObject({ running: 1, memoryMb: 566, cores: 0.4, vm: { name: "vmmemWSL", privateMb: 2200, workingMb: 1300 } });
      expect(status.docker?.containers.map((each) => [each.name, each.owner])).toEqual([
        ["graph-mongo-1", "session:graph"],
        ["dynamodb-local", "docker:dynamodb-local"],
      ]);
      expect(status.owners.find((owner) => owner.owner === "session:graph")).toMatchObject({ privateMb: 566, workingMb: 566, kind: "session" });
      expect(status.owners.find((owner) => owner.owner === DOCKER_VM)).toMatchObject({ privateMb: 2400 - 566, workingMb: 1400 - 566 });
      expect(status.docker?.rest).toMatchObject({ privateMb: 2400 - 566, workingMb: 1400 - 566 });
      // The memory resource gives the same owners.
      const owners = status.resources.find((each) => each.id === "memory")?.owners ?? [];
      expect(owners.find((each) => each.owner === "session:graph")?.value).toBeCloseTo(566, 0);
      // The images with no container are above 10 GB, and the build cache is below 20 GB.
      expect(status.alerts.map((alert) => alert.id)).toEqual(["docker:images"]);
      // With no read at the next read of the processes, Docker is absent, and the owner docker stays.
      read = undefined;
      now += 10_000;
      engine.tick();
      expect(engine.status().docker).toBeNull();
      expect(engine.status().owners.find((owner) => owner.owner === "docker")).toMatchObject({ privateMb: 2400, workingMb: 1400 });
      expect(engine.status().alerts).toEqual([]);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
