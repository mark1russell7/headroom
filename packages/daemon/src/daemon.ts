/**
 * The daemon: one engine, served by `runProcedureHost` of the client on a local port.
 *
 * The runner of `@mark1russell7/service` owns the signals, the stop in stages and the exit.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createSampler, Engine, Store } from "@headroom/core";
import { defineModule, hostPolicy, ProcedureRegistry, registerModules } from "@procedures/client";
import { peerHostOptions } from "@procedures/peer";
import { runProcedureHost } from "@procedures/server";
import { answers } from "./client.ts";
import { McpGateway } from "./gateway.ts";
import { DAEMON_TITLE } from "./service.ts";
import { databasePath, headroomHome, readDiscovery, removeDiscovery, writeDiscovery } from "./paths.ts";
import { gatewayProcedures, resourceProcedures } from "./procedures.ts";

/** The default port of the daemon. */
export const DEFAULT_PORT = 4730;

/** The options of `serve()`. */
export interface ServeOptions {
  readonly port?: number | undefined;
  /** The time between two ticks of the engine. The default is 2 seconds. */
  readonly tickMs?: number | undefined;
  /** The memory that the broker keeps free, in MB. The default is 1024. */
  readonly reserveMb?: number | undefined;
  /** `foreground` in a terminal: a second Ctrl-C exits at once. `background` for a service. */
  readonly mode?: "foreground" | "background" | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/** This function runs the daemon until a signal stops it. It gives the exit code. */
export async function serve(options: ServeOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  mkdirSync(headroomHome(), { recursive: true });
  const running = readDiscovery();
  if (running && running.pid !== process.pid && (await answers(running))) {
    log(`headroom already runs as process ${running.pid} at ${running.endpoint}`);
    // This is not a failure of a service, so the service manager does not start it again.
    return options.mode === "background" ? 0 : 1;
  }
  // The daemon before this one did not remove its discovery file: another process stopped it.
  const unclean = running && running.pid !== process.pid ? running.pid : null;
  process.title = DAEMON_TITLE;

  const store = new Store(databasePath());
  const gateway = new McpGateway({ specs: () => store.mcpServers(), log });
  const engine = new Engine({ sampler: await createSampler(), store, reserveMb: options.reserveMb, servers: () => gateway.pids() });
  if (unclean !== null) {
    const last = engine.history(Date.now() - 86_400_000).memory.at(-1)?.at;
    const after = last === undefined ? "" : `, after ${new Date(last).toISOString().slice(11, 16)} UTC`;
    engine.note({
      id: "stop:daemon",
      kind: "stop",
      subject: "headroom daemon",
      pid: unclean,
      mb: 0,
      message: `The daemon before this one (process ${unclean}) stopped without a clean stop${after}. Another process can have stopped it.`,
    });
    log(`The daemon before this one (process ${unclean}) stopped without a clean stop.`);
  }
  const registry = new ProcedureRegistry();
  registerModules(registry, [defineModule("@headroom/daemon", [...resourceProcedures(engine), ...gatewayProcedures(engine, gateway)])]);

  const port = options.port ?? DEFAULT_PORT;
  const host = "127.0.0.1";
  const token = randomBytes(32).toString("hex");
  const base = peerHostOptions(
    { id: `headroom-${process.pid}`, transports: [{ type: "http", port, host, basePath: "/api" }], registry, policy: hostPolicy({ token }) },
    "headroom",
  );
  // The MCP gateway is a face on the same listener as the procedures: /mcp/<name> next to /api.
  const started = await runProcedureHost({
    name: "headroom",
    mode: options.mode ?? "foreground",
    host: {
      ...base,
      faces: { ...base.faces, mcp: gateway.face() },
      listen: base.listen?.map((listener) => ({ ...listener, faces: [...(listener.faces ?? []), "mcp"] })),
    },
    log,
  });
  if (started.life.state !== "running") {
    log("headroom did not start:");
    for (const error of started.life.errors) log(`  ${String(error)}`);
    engine.close();
    await started.life.done;
    return 1;
  }

  writeDiscovery({ pid: process.pid, endpoint: `http://${host}:${port}/api`, token, startedAt: new Date().toISOString() });
  log(`headroom runs at http://${host}:${port}/api (process ${process.pid})`);
  const timer = setInterval(() => {
    try {
      engine.tick();
    } catch (error) {
      log(`The tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, options.tickMs ?? 2000);

  await started.life.done;
  clearInterval(timer);
  engine.close();
  removeDiscovery();
  return started.life.errors.length > 0 ? 1 : 0;
}

/** The size at which the log file moves to `<file>.1`. */
const LOG_LIMIT = 1024 * 1024;

/** This function gives a log that adds each line to a file, with the time. */
export function fileLog(path: string): (line: string) => void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // The file does not exist yet.
  }
  return (line) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      if (size + text.length > LOG_LIMIT) {
        renameSync(path, `${path}.1`);
        size = 0;
      }
      appendFileSync(path, text);
      size += text.length;
    } catch {
      // A log that cannot write does not stop the daemon.
    }
  };
}
