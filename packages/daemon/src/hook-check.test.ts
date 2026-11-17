import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PORT } from "./daemon.ts";
import { claudeConfigDir, hookCheck, hookProbe, installedPluginsPath, installProblem, readPluginInstalls } from "./hook-check.ts";
import { serviceChecks } from "./health.ts";

// The hooks.json of this repository (version 0.2.0 and later) and the command hook of the versions before 0.2.0.
const pluginHooks = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "plugins", "headroom", "hooks", "hooks.json"), "utf8")) as unknown;
const commandHooks = {
  hooks: { PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/route.ts"', timeout: 5 }] }] },
};
const httpHooks = (url: string): unknown => ({
  hooks: { PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "http", url, timeout: 1, headers: { "x-headroom-client": "hook" } }] }] },
});

describe("the problem of one install of the plugin (H194)", () => {
  it("has no problem when the hook of this repository asks the default port and the daemon listens there", () => {
    expect(installProblem({ file: "a/hooks.json", config: pluginHooks }, DEFAULT_PORT)).toBeNull();
  });

  it("tells the two ports when the daemon listens on another port", () => {
    expect(installProblem({ file: "a/hooks.json", config: pluginHooks }, 4740)).toBe(
      `The hook of the plugin headroom asks port ${DEFAULT_PORT}, and this daemon listens on port 4740: the guard is off.`,
    );
  });

  it("has no problem for the command hook before 0.2.0, which finds the daemon on each port", () => {
    expect(installProblem({ file: "a/hooks.json", config: commandHooks }, 4740)).toBeNull();
  });

  it("tells a hook on another host, a hook with no port, and a URL that is not a URL", () => {
    expect(installProblem({ file: "f", config: httpHooks("http://10.0.0.5:4730/hooks/pre-tool-use") }, 4730)).toContain("asks 10.0.0.5:4730, not this computer");
    expect(installProblem({ file: "f", config: httpHooks("http://localhost/hooks/pre-tool-use") }, 4730)).toContain("asks port 80");
    expect(installProblem({ file: "f", config: httpHooks("not a url") }, 4730)).toContain('"not a url", which is not a URL');
  });

  it("shows no read, never a pass, for a file that cannot be read or a config with no hook of the daemon", () => {
    expect(installProblem({ file: "f", error: "ENOENT" }, 4730)).toContain("cannot be read (ENOENT), so the check has no read");
    expect(installProblem({ file: "f", config: {} }, 4730)).toContain("has no hook for the daemon: the guard is off");
    expect(installProblem({ file: "f", config: httpHooks("http://127.0.0.1:4730/other") }, 4730)).toContain("has no hook for the daemon");
  });
});

describe("the state of the hook over all installs (H194)", () => {
  it("is absent with no install, ok when each install reaches the daemon, and down with each problem once", () => {
    expect(hookProbe([], 4730)).toEqual({ state: "absent", latencyMs: null, error: null });
    expect(hookProbe([{ file: "a", config: pluginHooks }, { file: "b", config: commandHooks }], DEFAULT_PORT).state).toBe("ok");
    const down = hookProbe([{ file: "a", config: pluginHooks }, { file: "b", config: pluginHooks }], 4740);
    expect(down.state).toBe("down");
    expect(down.error).toBe(`The hook of the plugin headroom asks port ${DEFAULT_PORT}, and this daemon listens on port 4740: the guard is off.`);
  });

  it("is down with no read when the list of the installed plugins cannot be read", () => {
    const probe = hookProbe({ error: "installed_plugins.json: Unexpected token" }, 4730);
    expect(probe.state).toBe("down");
    expect(probe.error).toContain("cannot be read (installed_plugins.json: Unexpected token), so the check has no read");
  });
});

describe("the read of the installs of the plugin (H194)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "headroom-hook-check-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const install = (name: string, config: unknown): string => {
    const root = join(dir, "cache", name);
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify(config));
    return root;
  };
  const list = (plugins: unknown): void => {
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(installedPluginsPath(dir), typeof plugins === "string" ? plugins : JSON.stringify({ version: 2, plugins }));
  };

  it("gives no install when Claude Code has no list of installed plugins", () => {
    expect(readPluginInstalls(dir)).toEqual([]);
  });

  it("reads the hooks of each install of the plugin, and only of this plugin", async () => {
    const http = install("http", pluginHooks);
    const old = install("old", commandHooks);
    list({
      "headroom@headroom": [{ scope: "user", installPath: http }],
      "headroom@other": [{ scope: "project", installPath: old }],
      "fleet@fleet": [{ scope: "user", installPath: join(dir, "nowhere") }],
    });
    const installs = readPluginInstalls(dir);
    expect(Array.isArray(installs) && installs.map((each) => each.file)).toEqual([join(http, "hooks", "hooks.json"), join(old, "hooks", "hooks.json")]);
    const check = hookCheck({ port: DEFAULT_PORT, configDir: dir });
    expect(check).toMatchObject({ name: "hook", type: "hook", critical: false, target: installedPluginsPath(dir) });
    expect(await check.run(new AbortController().signal)).toEqual({ state: "ok", latencyMs: null, error: null });
    expect((await hookCheck({ port: 4740, configDir: dir }).run(new AbortController().signal)).state).toBe("down");
  });

  it("gives the reason for a list that is not JSON, a list with no plugins, an install with no path and a missing hooks.json", () => {
    list("{not json");
    expect(readPluginInstalls(dir)).toHaveProperty("error");
    list("[]");
    expect(readPluginInstalls(dir)).toEqual({ error: `${installedPluginsPath(dir)}: it has no object "plugins"` });
    list({ "headroom@headroom": [{ scope: "user" }, { scope: "user", installPath: join(dir, "gone") }] });
    const installs = readPluginInstalls(dir);
    expect(Array.isArray(installs) && installs.map((each) => ("error" in each ? each.error.slice(0, 30) : "config"))).toEqual([
      "the install has no installPath",
      expect.stringContaining("ENOENT"),
    ]);
    expect(hookProbe(installs, DEFAULT_PORT).state).toBe("down");
  });

  it("finds the settings of Claude Code in CLAUDE_CONFIG_DIR, or in .claude of the home folder", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: dir })).toBe(dir);
    expect(claudeConfigDir({})).toMatch(/\.claude$/);
  });

  it("is the last check of a round of the monitor", () => {
    const names = serviceChecks({}, [], "/nowhere/docker.sock", [hookCheck({ port: DEFAULT_PORT, configDir: dir })]).map((check) => check.name);
    expect(names).toEqual(["docker", "hook"]);
  });
});
