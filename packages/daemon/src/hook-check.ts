/**
 * The check of the hook of the plugin (H194). The URL of an HTTP hook of Claude Code takes no environment variable, so the
 * hook of the plugin asks the default port of the daemon. A daemon on another port gets no request of the hook. Then no
 * heavy command waits for a lease, and nothing else tells it.
 *
 * The check reads the hooks of each install of the plugin, from the list of the installed plugins of Claude Code:
 *
 * - `ok`: each HTTP hook of the route asks this daemon, or the install has the command hook of a version before 0.2.0. That
 *   hook finds the daemon by its discovery file, on each port.
 * - `down`, with the reason: a hook asks another port or another host, an install has no hook of headroom, or a file cannot
 *   be read. A check that cannot read a case shows no read, and not a pass.
 * - `absent`: Claude Code has no install of the plugin.
 *
 * The check is not critical: its alert is a warning.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorText, type ServiceCheck, type ServiceProbe } from "@headroom/core";
import { HOOK_PATH } from "./hook-face.ts";

/** The name of the plugin in the list of the installed plugins: the part of the key before `@`. */
export const PLUGIN_NAME = "headroom";

/** The hooks of one install of the plugin: the parsed hooks.json, or the reason that it cannot be read. */
export type PluginHooks =
  | { readonly file: string; readonly config: unknown }
  | { readonly file: string; readonly error: string };

/** The installs of the plugin, or the reason that the list of the installed plugins cannot be read. */
export type PluginInstalls = readonly PluginHooks[] | { readonly error: string };

/** This function gives the folder of the settings of Claude Code: `CLAUDE_CONFIG_DIR`, or `.claude` in the home folder. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
}

/** This function gives the path of the list of the installed plugins in the folder of the settings of Claude Code. */
export function installedPluginsPath(configDir: string): string {
  return join(configDir, "plugins", "installed_plugins.json");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** This function reads the hooks of each install of the plugin. No list of installed plugins gives no install. */
export function readPluginInstalls(configDir: string, name: string = PLUGIN_NAME): PluginInstalls {
  const list = installedPluginsPath(configDir);
  let parsed: unknown;
  try {
    parsed = readJson(list);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    return { error: `${list}: ${errorText(error)}` };
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== "object" || plugins === null) return { error: `${list}: it has no object "plugins"` };
  const installs: PluginHooks[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    if (key.split("@")[0] !== name) continue;
    for (const entry of Array.isArray(entries) ? (entries as unknown[]) : [entries]) {
      const root = (entry as { installPath?: unknown } | null)?.installPath;
      if (typeof root !== "string") {
        installs.push({ file: `${list} (${key})`, error: "the install has no installPath" });
        continue;
      }
      const file = join(root, "hooks", "hooks.json");
      try {
        installs.push({ file, config: readJson(file) });
      } catch (error) {
        installs.push({ file, error: errorText(error) });
      }
    }
  }
  return installs;
}

/** One hook of a hooks.json, as Claude Code reads it. */
interface HookEntry {
  readonly type?: unknown;
  readonly url?: unknown;
}

function hookEntries(config: unknown): HookEntry[] {
  const events = (config as { hooks?: unknown } | null)?.hooks;
  if (typeof events !== "object" || events === null) return [];
  const groups = Object.values(events).flatMap((each) => (Array.isArray(each) ? (each as unknown[]) : []));
  return groups.flatMap((group) => {
    const hooks = (group as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(hooks) ? (hooks as HookEntry[]) : [];
  });
}

/** This function gives the problem of one install, or `null` when its hook reaches the daemon on `port`. */
export function installProblem(install: PluginHooks, port: number): string | null {
  if ("error" in install) return `The hooks of the plugin ${PLUGIN_NAME} in ${install.file} cannot be read (${install.error}), so the check has no read.`;
  const hooks = hookEntries(install.config);
  const routes: URL[] = [];
  for (const hook of hooks) {
    if (hook.type !== "http" || typeof hook.url !== "string") continue;
    let url: URL;
    try {
      url = new URL(hook.url);
    } catch {
      return `The plugin ${PLUGIN_NAME} in ${install.file} has a hook with the URL "${hook.url}", which is not a URL.`;
    }
    if (url.pathname === HOOK_PATH) routes.push(url);
  }
  if (routes.length === 0) {
    // The command hook before version 0.2.0 of the plugin finds the daemon by its discovery file.
    if (hooks.some((hook) => hook.type === "command")) return null;
    return `The plugin ${PLUGIN_NAME} in ${install.file} has no hook for the daemon: the guard is off.`;
  }
  for (const url of routes) {
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return `The hook of the plugin ${PLUGIN_NAME} asks ${url.host}, not this computer: the guard is off.`;
    }
    const asked = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (asked !== port) {
      return `The hook of the plugin ${PLUGIN_NAME} asks port ${asked}, and this daemon listens on port ${port}: the guard is off.`;
    }
  }
  return null;
}

/** This function gives the state of the hook for the installs of the plugin and the port of the daemon. */
export function hookProbe(installs: PluginInstalls, port: number): ServiceProbe {
  if (!Array.isArray(installs)) {
    const { error } = installs as { readonly error: string };
    return { state: "down", latencyMs: null, error: `The list of the installed plugins of Claude Code cannot be read (${error}), so the check has no read.` };
  }
  if (installs.length === 0) return { state: "absent", latencyMs: null, error: null };
  const problems = installs.map((install) => installProblem(install, port)).filter((problem) => problem !== null);
  if (problems.length === 0) return { state: "ok", latencyMs: null, error: null };
  return { state: "down", latencyMs: null, error: [...new Set(problems)].join(" ").slice(0, 600) };
}

/** The options of the check of the hook. */
export interface HookCheckOptions {
  /** The port of the listener of the daemon. */
  readonly port: number;
  /** The folder of the settings of Claude Code. The default is {@link claudeConfigDir}. */
  readonly configDir?: string | undefined;
}

/** This function gives the check of the hook for the monitor of the services (H27). It reads two small files at each round. */
export function hookCheck(options: HookCheckOptions): ServiceCheck {
  const configDir = options.configDir ?? claudeConfigDir();
  return {
    name: "hook",
    type: "hook",
    title: `The hook of the plugin ${PLUGIN_NAME}`,
    target: installedPluginsPath(configDir),
    critical: false,
    run: async () => hookProbe(readPluginInstalls(configDir), options.port),
  };
}
