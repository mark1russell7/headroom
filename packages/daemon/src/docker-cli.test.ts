import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerReader, dockerShares, dockerStatus, localClock, type DockerContainerStatus, type DockerStatus } from "@headroom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connection } from "./client.ts";
import { dockerCommand, dockerLinesOf } from "./docker-cli.ts";
import { dockerGet } from "./health.ts";

const container = (name: string, owner: string, state: string, memoryMb: number | null, cores: number | null, project: string | null): DockerContainerStatus => ({
  id: name,
  name,
  image: "img",
  state,
  project,
  workingDir: null,
  memoryMb,
  limitMb: null,
  cores,
  sizeRwMb: null,
  owner,
  ownerKind: owner.startsWith("session:") ? "session" : "docker",
  ownerFrom: owner.startsWith("session:") ? "folder" : "docker",
});

const CONTAINERS = [container("graph-mongo-1", "session:graph", "running", 566, 0.55, "graph"), container("dynamodb-local", "docker:dynamodb-local", "exited", null, null, null)];

const DOCKER: DockerStatus = dockerStatus({
  read: {
    at: Date.parse("2026-10-25T09:57:00Z"),
    version: "29.9.2",
    api: "1.56",
    containers: CONTAINERS,
    disk: {
      at: Date.parse("2026-10-25T09:57:00Z"), imagesMb: 33_890, images: 102, unusedImagesMb: 26_800, unusedImages: 99, buildCacheMb: 17_502,
      buildCacheUnusedMb: 6714, volumesMb: 2442, volumes: 34, unusedVolumesMb: 1480, containersMb: 2, readMs: 4600,
    },
    readMs: 65,
  },
  containers: CONTAINERS,
  shares: dockerShares(CONTAINERS),
  processes: [{ pid: 7804, ppid: 4, name: "vmmemWSL", privateMb: 2200, workingMb: 1300 }],
  owners: [{ owner: "docker (VM)", kind: "docker", privateMb: 1634, workingMb: 1434, processes: 19 }],
  cores: [{ owner: "docker (VM)", kind: "docker", cores: 0.3 }],
});

describe("headroom docker (H38)", () => {
  it("writes each container with its owner, the owners, the VM, the disk use and the cost", () => {
    const lines = dockerLinesOf(DOCKER);
    // H49: the times are in the local clock, as in the other commands.
    const at = localClock(Date.parse("2026-10-25T09:57:00Z"));
    expect(lines[0]).toBe(`Docker 29.9.2 (API 1.56), read at ${at}: 1 of 2 containers run, 566 MB, 0.55 cores.`);
    expect(lines.some((line) => line.startsWith("graph-mongo-1") && line.includes("session:graph") && line.includes("566 MB") && line.endsWith("graph"))).toBe(true);
    expect(lines.some((line) => line.startsWith("dynamodb-local") && line.includes("docker:dynamodb-local") && line.includes("exited"))).toBe(true);
    expect(lines).toContain("  session:graph                   566 MB   0.55 cores  1 container");
    expect(lines).toContain("VM: vmmemWSL 1.3 GB in RAM, 2.1 GB committed.");
    expect(lines).toContain("docker (VM) keeps 1.4 GB in RAM and 0.30 cores: the VM, its cache and the Docker programs of Windows, less the containers.");
    expect(lines).toContain(`Disk, read at ${at}: images 33.1 GB (102), images with no container 26.2 GB (99).`);
    expect(lines.join("\n")).not.toContain("UTC");
    expect(lines).toContain("Cost: the last read of the containers took 65 ms, and the last disk read 4.6 s.");
    expect(lines.at(-1)).toContain("headroom does not prune, stop or start a container.");
  });

  it("tells when the daemon gives no Docker read, and gives the JSON of the status", async () => {
    expect(dockerLinesOf(null)[0]).toMatch(/^No Docker read\./);
    expect(dockerLinesOf({ ...DOCKER, disk: null, vm: null, rest: null, containers: [], owners: [] })).toContain("Disk: no read yet. The daemon reads the disk use every 10 minutes.");
    const out: string[] = [];
    const connection = { call: async () => ({ docker: DOCKER, leases: [] }) } as unknown as Connection;
    expect(await dockerCommand(["--json"], connection, { out: (text) => out.push(text), err: () => undefined })).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual(JSON.parse(JSON.stringify(DOCKER)));
    expect(await dockerCommand([], null, { out: () => undefined, err: () => undefined })).toBe(1);
  });
});

describe("the transport of the Docker reader on a pipe (H38)", () => {
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\headroom-test-${randomBytes(6).toString("hex")}` : join(tmpdir(), `headroom-test-${randomBytes(6).toString("hex")}.sock`);
  const seen: string[] = [];
  let server: Server;
  let total = 1e12;
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      if (url === "/version") res.end(JSON.stringify({ Version: "29.9.2", ApiVersion: "1.56", Os: "linux" }));
      else if (url.startsWith("/v1.56/containers/json")) {
        res.end(JSON.stringify([{ Id: "abc", Names: ["/neo4j"], Image: "neo4j", State: "running", Labels: { "com.docker.compose.project": "graph" } }]));
      } else if (url.startsWith("/v1.56/containers/abc/stats")) {
        total += 6e9;
        res.end(JSON.stringify({ read: new Date().toISOString(), memory_stats: { usage: 1300 * 1048576, stats: { inactive_file: 100 * 1048576 } }, cpu_stats: { cpu_usage: { total_usage: total } } }));
      } else if (url.startsWith("/v1.56/system/df")) res.end(JSON.stringify({ BuildCacheUsage: { TotalSize: 22 * 1024 * 1048576, Reclaimable: 0 } }));
      else if (url === "/big") res.end("x".repeat(2048));
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("reads the fake engine with GET requests only, and gives the CPU from two reads", async () => {
    const reader = new DockerReader({ get: dockerGet(pipe), everyMs: 0 });
    const first = await reader.read();
    expect(first?.containers[0]).toMatchObject({ name: "neo4j", project: "graph", memoryMb: 1200, cores: null });
    expect(first?.disk?.buildCacheMb).toBe(22 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await reader.read();
    expect(second?.containers[0]?.cores).toBeGreaterThan(0);
    expect(seen.every((line) => line.startsWith("GET "))).toBe(true);
    expect(seen).toContain("GET /v1.56/containers/abc/stats?stream=false&one-shot=true");
  });

  it("refuses an answer above the limit, and gives ENOENT for a pipe that does not exist", async () => {
    const signal = new AbortController().signal;
    await expect(dockerGet(pipe, 1024)("/big", signal)).rejects.toThrow(/larger than/);
    expect(await dockerGet(pipe)("/nothing", signal)).toMatchObject({ status: 404 });
    const missing = process.platform === "win32" ? "\\\\.\\pipe\\headroom-test-missing" : join(tmpdir(), "headroom-test-missing.sock");
    const log: string[] = [];
    const reader = new DockerReader({ get: dockerGet(missing), log: (line) => log.push(line) });
    expect(await reader.read()).toBeUndefined();
    expect(reader.state()).toBe("absent");
    expect(log).toHaveLength(1);
  });
});
