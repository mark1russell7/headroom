/**
 * The daemon: one engine, served by `runProcedureHost` of the client on a local port.
 *
 * The runner of `@mark1russell7/service` owns the signals, the stop in stages and the exit.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createSampler, Engine, ServiceMonitor, Store, waitsForRoom } from "@headroom/core";
import { defineModule, hostPolicy, ProcedureRegistry, registerModules } from "@procedures/client";
import { peerHostOptions } from "@procedures/peer";
import { runProcedureHost } from "@procedures/server";
import { answers } from "./client.ts";
import { dashboardFace } from "./dashboard.ts";
import { McpGateway } from "./gateway.ts";
import { serviceChecks } from "./health.ts";
import { DAEMON_TITLE, restartFromDaemon } from "./service.ts";
import { announceDaemon, databasePath, headroomHome, readDiscovery, readPlannedStop, removeDiscovery } from "./paths.ts";
import { gatewayProcedures, resourceProcedures, serviceProcedures } from "./procedures.ts";
import { IdleRestart } from "./restart.ts";

/** The default port of the daemon. */
export const DEFAULT_PORT = 4730;

/** A time between two ticks that counts as a sleep of the computer, also with no resume event (H30). The daemon ticks every 2 seconds. */
const SLEEP_GAP_MS = 60_000;

/** The time between two sweeps of the temp folders of the ended leases (H19). */
const SWEEP_EVERY_MS = 10 * 60_000;

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
  // The daemon before this one did not remove its discovery file: another process stopped it,
  // unless `headroom service restart` marked the stop as planned. The mark stays until the new discovery file exists.
  const planned = readPlannedStop()?.pid ?? null;
  const unclean = running && running.pid !== process.pid && running.pid !== planned ? running.pid : null;
  if (planned !== null && running?.pid === planned) log(`The planned restart stopped the daemon before this one (process ${planned}).`);
  process.title = DAEMON_TITLE;

  const store = new Store(databasePath());
  const gateway = new McpGateway({ specs: () => store.mcpServers(), log });
  // H27: Docker, the URLs of the setting health and the MCP servers of the gateway, every 30 seconds.
  const monitor = new ServiceMonitor({ checks: () => serviceChecks(store.config().health, gateway.list()) });
  const sampler = await createSampler();
  const engine = new Engine({
    sampler,
    store,
    reserveMb: options.reserveMb,
    servers: () => gateway.pids(),
    services: () => monitor.list(),
    sleepGapMs: SLEEP_GAP_MS,
  });
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
  // `headroom service restart --when-idle`: the daemon waits for an idle queue, and then it restarts itself.
  let stopSelf = (): void => undefined;
  const idle: IdleRestart = new IdleRestart({
    // H31: a lease that waits for a condition does not hold the restart. The new daemon keeps it.
    waiting: () => engine.status().leases.filter(waitsForRoom).length,
    restart: () => {
      log("No lease waits, so the restart for an idle queue starts.");
      restartFromDaemon(process.pid, log).then(
        (stops) => {
          if (stops) stopSelf();
        },
        (error: unknown) => {
          log(`The restart for an idle queue did not start: ${error instanceof Error ? error.message : String(error)}`);
          idle.failed();
        },
      );
    },
  });
  const registry = new ProcedureRegistry();
  registerModules(registry, [
    defineModule("@headroom/daemon", [...resourceProcedures(engine, () => idle.pending()), ...gatewayProcedures(engine, gateway), ...serviceProcedures(idle)]),
  ]);

  const port = options.port ?? DEFAULT_PORT;
  const host = "127.0.0.1";
  const token = randomBytes(32).toString("hex");
  const base = peerHostOptions(
    { id: `headroom-${process.pid}`, transports: [{ type: "http", port, host, basePath: "/api" }], registry, policy: hostPolicy({ token }) },
    "headroom",
  );
  // The MCP gateway and the dashboard are faces on the same listener as the procedures: /mcp/<name> and / next to /api.
  const started = await runProcedureHost({
    name: "headroom",
    mode: options.mode ?? "foreground",
    host: {
      ...base,
      faces: { ...base.faces, mcp: gateway.face(), dashboard: dashboardFace() },
      listen: base.listen?.map((listener) => ({ ...listener, faces: [...(listener.faces ?? []), "mcp", "dashboard"] })),
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

  announceDaemon({ pid: process.pid, endpoint: `http://${host}:${port}/api`, token, startedAt: new Date().toISOString() }, planned);
  log(`headroom runs at http://${host}:${port}/api (process ${process.pid})`);
  stopSelf = () => void started.life.shutdown("the restart for an idle queue", { code: 0 });
  const tick = (): void => {
    try {
      engine.tick();
      idle.tick();
    } catch (error) {
      log(`The tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const timer = setInterval(tick, options.tickMs ?? 2000);
  // H30: a power event sets the state of the engine and asks for a tick at once. The handler does not wait, because the
  // thread of Windows that gives the event waits for it.
  const unwatch = sampler.watchPower?.((event) => {
    engine.powerEvent(event);
    setImmediate(tick);
  }, log);
  // H19: a client that stopped before its release left the temp folder of its lease.
  const sweep = (): void => {
    try {
      const removed = engine.sweepJobTemp();
      if (removed.length > 0) log(`Removed the temp folders of ${removed.length} ended leases: ${removed.join(", ")}`);
    } catch (error) {
      log(`The sweep of the temp folders failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  sweep();
  const sweeper = setInterval(sweep, SWEEP_EVERY_MS);
  monitor.start();

  await started.life.done;
  unwatch?.();
  clearInterval(timer);
  clearInterval(sweeper);
  monitor.stop();
  engine.close();
  removeDiscovery();
  return started.life.errors.length > 0 ? 1 : 0;
}

/** The size at which the log file moves to `<file>.1`. */
const LOG_LIMIT = 1024 * 1024;

/** This function gives the size of a file, or 0 when the file does not exist. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * This function gives a log that adds each line to a file, with the time. At `limit` bytes, the file moves to `<file>.1`.
 * When the move fails, the log reads the real size of the file and writes the line all the same.
 */
export function fileLog(path: string, limit: number = LOG_LIMIT): (line: string) => void {
  let size = sizeOf(path);
  return (line) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      if (size + text.length > limit) {
        try {
          renameSync(path, `${path}.1`);
          size = 0;
        } catch {
          // Another process removed the file, moved it or holds it open.
          size = sizeOf(path);
        }
      }
      appendFileSync(path, text);
      size += text.length;
    } catch {
      // A log that cannot write does not stop the daemon.
    }
  };
}
