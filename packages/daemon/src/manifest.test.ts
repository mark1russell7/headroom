import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostPolicy, MANIFEST_FORMAT, type ProcedureManifest } from "@procedures/client";
import { createProcedureHost, peerHostOptions } from "@procedures/peer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTo, type Connection } from "./client.ts";
import { DEFAULT_PORT, daemonRegistry } from "./daemon.ts";
import { diskProcedures } from "./procedures.ts";

describe("the manifest of the daemon", () => {
  // The host as serve() makes it: the registry of the daemon behind the policy with a token.
  const token = "manifest-test-token";
  let server: Server;
  let port = 0;
  /** The connection of the daemon client, as a procedures server makes it from the discovery file. */
  const connect = (secret: string): Connection => connectTo({ pid: process.pid, endpoint: `http://127.0.0.1:${port}/api`, token: secret, startedAt: new Date(0).toISOString() });

  beforeAll(async () => {
    const registry = daemonRegistry(diskProcedures(() => null));
    const options = peerHostOptions(
      { id: "headroom-test", transports: [{ type: "http", port: DEFAULT_PORT, host: "127.0.0.1", basePath: "/api" }], registry, policy: hostPolicy({ token }) },
      "headroom",
    );
    // With no listener, the host serves its faces on its handler.
    const host = createProcedureHost({ ...options, listen: undefined });
    server = createServer((req, res) => {
      if (!host.handler(req, res)) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves procedure.manifest with each procedure of the daemon, its schemas and its effects", async () => {
    const manifest = await connect(token).call<ProcedureManifest>(["procedure", "manifest"], {});
    expect(manifest.format).toBe(MANIFEST_FORMAT);
    const keys = manifest.procedures.map((entry) => entry.path.join("."));
    expect(keys).toContain("disk.report");
    expect(keys).toContain("procedure.manifest");
    const report = manifest.procedures.find((entry) => entry.path.join(".") === "disk.report")!;
    expect(report.hasHandler).toBe(true);
    expect(report.input).toBeDefined();
    expect(report.effects).toBeDefined();
    const own = manifest.procedures.find((entry) => entry.path.join(".") === "procedure.manifest")!;
    expect(own.effects).toMatchObject({ reads: ["registry"] });
  });

  it("gives only the procedures of one namespace", async () => {
    const manifest = await connect(token).call<ProcedureManifest>(["procedure", "manifest"], { namespace: "disk" });
    expect(manifest.procedures.map((entry) => entry.path.join("."))).toEqual(["disk.report"]);
  });

  it("refuses a call with a wrong token", async () => {
    await expect(connect("wrong-token").call(["procedure", "manifest"], {})).rejects.toThrow(/Unauthorized/);
  });
});
