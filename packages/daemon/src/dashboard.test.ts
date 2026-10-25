import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HostFaceContext } from "@procedures/peer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dashboardFace } from "./dashboard.ts";

const KEY = "a".repeat(64);
const TOKEN = "the-daemon-token";

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

describe("the dashboard", () => {
  let server: Server;
  let port = 0;

  /** This function sends a GET request with a Host header of its choice. `fetch` cannot set the Host header. */
  const get = (path: string, host = `127.0.0.1:${port}`): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });

  beforeAll(async () => {
    const face = dashboardFace({ key: () => KEY })({ policy: { token: TOKEN } } as unknown as HostFaceContext);
    server = createServer((req, res) => {
      if (!face.handler?.(req, res)) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("gives the page with the token only for the key of the dashboard", async () => {
    const page = await get(`/?k=${KEY}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain(`content="${TOKEN}"`);
    expect((await get(`/index.html?k=${KEY}`, `localhost:${port}`)).status).toBe(200);
  });

  it("gives a page without the token to a request without the key or with a wrong key", async () => {
    for (const path of ["/", "/?k=", `/?k=${"b".repeat(64)}`, `/?k=${KEY.slice(1)}`]) {
      const locked = await get(path);
      expect(locked.status).toBe(403);
      expect(locked.body).not.toContain(TOKEN);
      expect(locked.body).toContain("headroom dashboard");
    }
  });

  it("refuses a host that is not loopback, also with the key", async () => {
    const rebound = await get(`/?k=${KEY}`, "attacker.example:4730");
    expect(rebound.status).toBe(403);
    expect(rebound.body).not.toContain(TOKEN);
  });

  it("sends no CORS header, so a page of another origin cannot read the answer", async () => {
    const page = await get(`/?k=${KEY}`);
    expect(page.headers["access-control-allow-origin"]).toBeUndefined();
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("gives no token when the key cannot be read", async () => {
    const face = dashboardFace({
      key: () => {
        throw new Error("no key file");
      },
    })({ policy: { token: TOKEN } } as unknown as HostFaceContext);
    let body = "";
    const res = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (text?: string) => {
        body = text ?? "";
      },
    };
    const handled = face.handler?.({ url: `/?k=${KEY}`, method: "GET", headers: { host: "127.0.0.1" } } as never, res as never);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(body).not.toContain(TOKEN);
  });
});
