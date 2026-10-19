/**
 * The daemon: one engine, served by `runProcedureHost` of the client on a local port.
 *
 * The runner of `@mark1russell7/service` owns the signals, the stop in stages and the exit.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createSampler, Engine, processIsAlive, Store } from "@headroom/core";
import { defineModule, hostPolicy, ProcedureRegistry, registerModules } from "@procedures/client";
import { peerHostOptions } from "@procedures/peer";
import { runProcedureHost } from "@procedures/server";
import { databasePath, headroomHome, readDiscovery, removeDiscovery, writeDiscovery } from "./paths.ts";
import { resourceProcedures } from "./procedures.ts";

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
  if (running && running.pid !== process.pid && processIsAlive(running.pid)) {
    log(`headroom already runs as process ${running.pid} at ${running.endpoint}`);
    return 1;
  }

  const engine = new Engine({ sampler: await createSampler(), store: new Store(databasePath()), reserveMb: options.reserveMb });
  const registry = new ProcedureRegistry();
  registerModules(registry, [defineModule("@headroom/daemon", resourceProcedures(engine))]);

  const port = options.port ?? DEFAULT_PORT;
  const host = "127.0.0.1";
  const token = randomBytes(32).toString("hex");
  const started = await runProcedureHost({
    name: "headroom",
    mode: options.mode ?? "foreground",
    host: peerHostOptions(
      { id: `headroom-${process.pid}`, transports: [{ type: "http", port, host, basePath: "/api" }], registry, policy: hostPolicy({ token }) },
      "headroom",
    ),
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
