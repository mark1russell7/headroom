/**
 * The daemon: one engine, served by `runProcedureHost` of the client on a local port.
 *
 * The runner of `@mark1russell7/service` owns the signals, the stop in stages and the exit.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createSampler, DockerReader, Engine, ServiceMonitor, Store, waitsForRoom, WORKTREE_IDLE_MS } from "@headroom/core";
import { defineModule, hostPolicy, manifestProcedure, ProcedureRegistry, REGISTRY_READ_EFFECTS, registerModules, withEffects, type AnyProcedure } from "@procedures/client";
import { peerHostOptions, type HostFaceFactory, type ProcedureHostOptions } from "@procedures/peer";
import { runProcedureHost } from "@procedures/server";
import { answers } from "./client.ts";
import { CLIENT_TITLE, DeferredStarts, launchClient } from "./deferred.ts";
import { dashboardFace } from "./dashboard.ts";
import { openEarlyListener } from "./early-listener.ts";
import { hookCheck } from "./hook-check.ts";
import { hookFace } from "./hook-face.ts";
import { McpGateway } from "./gateway.ts";
import { dockerGet, serviceChecks } from "./health.ts";
import { DAEMON_TITLE, restartFromDaemon, serviceCommand } from "./service.ts";
import { readSummary } from "./disk-report.ts";
import { announceDaemon, databasePath, diskReportPath, headroomHome, leaseEndsDir, readDiscovery, readPlannedStop, removeDiscovery, startLogPath } from "./paths.ts";
import { diskProcedures, gatewayProcedures, resourceProcedures, serviceProcedures } from "./procedures.ts";
import { IdleRestart } from "./restart.ts";
import { keepStartsBeforeStop } from "./starts-before-stop.ts";
import { resumePlanFile, writeResumePlan } from "./resume.ts";
import { defaultRoots, readWorktreePlan, readWorktreeRecord, worktreeRulesKey } from "./worktree-cli.ts";
import { launchClean, WorktreeSchedule } from "./worktree-schedule.ts";

/** The default port of the daemon. */
export const DEFAULT_PORT = 4730;

/** A time between two ticks that counts as a sleep of the computer, also with no resume event (H30). The daemon ticks every 2 seconds. */
const SLEEP_GAP_MS = 60_000;

/** The time between two sweeps of the temp folders of the ended leases (H19). */
const SWEEP_EVERY_MS = 10 * 60_000;

/** The time between two checks of the schedule of the worktree cleanup (H175). The first check comes after this time too. */
const WORKTREE_CHECK_MS = 5 * 60_000;

/**
 * This function gives the registry of the daemon: the procedures of the daemon and `procedure.manifest`. The manifest lists
 * each procedure that the policy of the host exposes, with its schemas and effects. A procedures server reads it, and
 * forwards each call of a daemon procedure to the daemon over HTTP (`peerModule` of `@procedures/client`). The manifest
 * only reads the registry.
 */
export function daemonRegistry(procedures: readonly AnyProcedure[]): ProcedureRegistry {
  const registry = new ProcedureRegistry();
  registerModules(registry, [
    defineModule("@headroom/daemon", [...procedures]),
    defineModule("@headroom/manifest", withEffects(REGISTRY_READ_EFFECTS, [manifestProcedure])),
  ]);
  return registry;
}

/** This function adds faces to the options of the host, and puts each of them on each listener of the host (H194). */
export function withFaces(base: ProcedureHostOptions, faces: Readonly<Record<string, HostFaceFactory>>): ProcedureHostOptions {
  const names = Object.keys(faces);
  return {
    ...base,
    faces: { ...base.faces, ...faces },
    listen: base.listen?.map((listener) => ({ ...listener, faces: [...(listener.faces ?? []), ...names] })),
  };
}

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
  const startedAt = Date.now();
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
  // H206: the port answers before the store, the sampler and the engine open. On 2026-11-18, the work before the bind took
  // 15 minutes after a bugcheck, and each hook call of each session got a refused connection.
  const port = options.port ?? DEFAULT_PORT;
  const host = "127.0.0.1";
  const early = await openEarlyListener({ port, host });
  const earlyAt = process.uptime();
  if (early instanceof Error) log(`The early listener did not bind ${host}:${port}: ${early.message}. The port answers when the daemon runs.`);

  const store = new Store(databasePath());
  const gateway = new McpGateway({ specs: () => store.mcpServers(), log });
  // H27: Docker, the URLs of the setting health, the MCP servers of the gateway and the hook (H194), every 30 seconds.
  // H194: the check of the hook compares the port of the hook of each install of the plugin with the port of this daemon.
  const hook = hookCheck({ port });
  const monitor = new ServiceMonitor({ checks: () => serviceChecks(store.config().health, gateway.list(), undefined, [hook]) });
  // H38: the containers of Docker every 30 seconds, and the disk use of Docker every 10 minutes. The tick starts each read.
  const docker = new DockerReader({ get: dockerGet(), log });
  const sampler = await createSampler();
  const engine = new Engine({
    sampler,
    store,
    reserveMb: options.reserveMb,
    servers: () => gateway.pids(),
    services: () => monitor.list(),
    docker: () => docker.last(),
    sleepGapMs: SLEEP_GAP_MS,
    // H34: at the start of a planned drain, the daemon writes the resume plan (H13) again, for the reboot.
    onDrainStart: () => {
      const plan = writeResumePlan();
      log(`The drain for the planned reboot started. The resume plan is in ${plan.path}.`);
    },
    resumePlan: () => resumePlanFile(),
    // H193: the start trace writes each start with its command line to its own file, so the rows stay after a bugcheck.
    startLogPath: startLogPath(),
    // H202: a job that ends while no daemon answers keeps its exit in an end record.
    leaseEndsDir: leaseEndsDir(),
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
  // H64: a detached job that waits is a row here, with no process. The client starts at the grant.
  const service = serviceCommand();
  const deferred = new DeferredStarts({ leases: engine, launch: launchClient(service.node, service.cli, CLIENT_TITLE) });
  const registry = daemonRegistry([
    ...resourceProcedures(engine, () => idle.pending(), deferred),
    ...gatewayProcedures(engine, gateway),
    ...serviceProcedures(idle),
    ...diskProcedures(() => readSummary(diskReportPath())),
  ]);

  const token = randomBytes(32).toString("hex");
  const base = peerHostOptions(
    { id: `headroom-${process.pid}`, transports: [{ type: "http", port, host, basePath: "/api" }], registry, policy: hostPolicy({ token }) },
    "headroom",
  );
  // The MCP gateway, the dashboard and the hook (H194) are faces on the same listener as the procedures: /mcp/<name>, / and
  // /hooks/pre-tool-use next to /api.
  const engineAt = process.uptime();
  let closedAt: number | null = null;
  if (!(early instanceof Error)) {
    await early.close();
    closedAt = process.uptime();
    if (early.answered() > 0) log(`The early listener answered ${early.answered()} hook calls with no decision.`);
  }
  const started = await runProcedureHost({
    name: "headroom",
    mode: options.mode ?? "foreground",
    host: withFaces(base, { mcp: gateway.face(), dashboard: dashboardFace(), hook: hookFace({ status: () => engine.status() }) }),
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
  const seconds = (value: number): string => `${value.toFixed(1)} s`;
  log(
    `The start took ${seconds(process.uptime())} from the start of the process: the early listener at ${early instanceof Error ? "no bind" : seconds(earlyAt)}, the engine at ${seconds(engineAt)}, the close of the early listener at ${closedAt === null ? "no close" : seconds(closedAt)}.`,
  );
  if (unclean !== null) {
    // H193: a bugcheck is an unclean stop. The starts of its last 2 minutes stay in a file after the 24 hours of the log. H206:
    // a worker thread reads them after the bind, so the hook and the procedures answer during the read.
    keepStartsBeforeStop({ path: startLogPath(), folder: headroomHome(), before: startedAt }).then(
      (kept) => {
        if (kept !== null) log(`The ${kept.starts} starts of the 2 minutes before the stop are in ${kept.file}.`);
      },
      (error: unknown) => log(`The starts before the stop were not kept: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
  stopSelf = () => void started.life.shutdown("the restart for an idle queue", { code: 0 });
  const tick = (): void => {
    try {
      engine.tick();
      deferred.tick();
      idle.tick();
      // A read of Docker is due every 30 seconds. The reader skips the poll while a read runs.
      docker.poll();
    } catch (error) {
      log(`The tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const timer = setInterval(tick, options.tickMs ?? 2000);
  // The first admission runs at once, so the waiting leases from the store get the rules of this version without a wait.
  setImmediate(tick);
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
    try {
      engine.sweepLeaseEnds();
    } catch (error) {
      log(`The sweep of the end records failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  sweep();
  const sweeper = setInterval(sweep, SWEEP_EVERY_MS);
  // H175: the worktree cleanup runs in a child process each day, and early when a drive of a root is low.
  const roots = defaultRoots();
  const worktrees = new WorktreeSchedule({
    roots: () => roots,
    disks: () => engine.status().disks,
    autoClean: () => engine.config().worktreeAutoClean,
    key: () => worktreeRulesKey({ roots, idleMs: WORKTREE_IDLE_MS }),
    launch: launchClean(service.node, service.cli),
    record: () => readWorktreeRecord(),
    plan: () => readWorktreePlan(),
    note: (alert, forMs) => engine.note(alert, forMs),
    endNote: (id) => engine.endNote(id),
    log,
  });
  const worktreeTimer = setInterval(() => {
    try {
      worktrees.tick();
    } catch (error) {
      log(`The check of the worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, WORKTREE_CHECK_MS);
  monitor.start();

  await started.life.done;
  // H64: a planned stop gives each waiting job a client, so the job waits for the next daemon.
  deferred.handOff();
  unwatch?.();
  clearInterval(timer);
  clearInterval(sweeper);
  clearInterval(worktreeTimer);
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
