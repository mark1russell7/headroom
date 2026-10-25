import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { announceDaemon, dashboardKey, dashboardKeyPath, discoveryPath, plannedStopPath, readDiscovery, writePlannedStop } from "./paths.ts";

describe("the files of headroom", () => {
  let home = "";
  const before = process.env["HEADROOM_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "headroom-paths-"));
    process.env["HEADROOM_HOME"] = home;
  });

  afterEach(() => {
    if (before === undefined) delete process.env["HEADROOM_HOME"];
    else process.env["HEADROOM_HOME"] = before;
    rmSync(home, { recursive: true, force: true });
  });

  it("makes one random key of the dashboard and keeps it", () => {
    const key = dashboardKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(dashboardKeyPath(), "utf8").trim()).toBe(key);
    expect(dashboardKey()).toBe(key);
  });

  it("replaces a key file that holds no valid key", () => {
    writeFileSync(dashboardKeyPath(), "\n");
    const key = dashboardKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(dashboardKey()).toBe(key);
  });

  it("keeps the mark of a planned stop until the new daemon writes its discovery file", () => {
    writePlannedStop(41);
    const discovery = { pid: 42, endpoint: "http://127.0.0.1:4730/api", token: "t", startedAt: new Date().toISOString() };
    announceDaemon(discovery, 41);
    expect(readDiscovery()).toEqual(discovery);
    expect(existsSync(plannedStopPath())).toBe(false);
  });

  it("keeps the mark of a later planned stop", () => {
    writePlannedStop(50);
    announceDaemon({ pid: 42, endpoint: "http://127.0.0.1:4730/api", token: "t", startedAt: new Date().toISOString() }, 41);
    expect(existsSync(discoveryPath())).toBe(true);
    expect(existsSync(plannedStopPath())).toBe(true);
  });
});
