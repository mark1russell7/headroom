/**
 * The procedures of headroom: `resources.*`, `config.*`, `mcp.*` and `service.*`. Each procedure uses one engine.
 */

import type { Alerts, Config, Engine, History, JobState, JobUsage, Lease, PoolTags, ServiceHealth, Status, Suggestion, TcpPorts } from "@headroom/core";
import { SERVER_NAME, type McpGateway, type McpServerState } from "./gateway.ts";
import type { IdleRestart, IdleRestartState, PendingRestart } from "./restart.ts";
import { createProcedure, zodAdapter, type AnyProcedure, type ProcedureContext } from "@procedures/client";
import { z } from "zod";

const Amounts = z.record(z.string().min(1).max(64), z.number().min(0)).describe("The amounts: memory in MB, cpu in processors, or a slot of a named pool");

const LeaseInput = z.object({
  holder: z.string().min(1).max(200).describe("The holder: a session or a role, for example graph"),
  job: z.string().min(1).max(500).describe("The name of the job, for example pnpm test"),
  amounts: Amounts,
  priority: z.number().int().min(-100).max(100).optional().describe("A higher priority goes first (default: 0)"),
  pid: z.number().int().positive().optional().describe("The process that holds the lease. The lease ends when it exits."),
  ttlMs: z.number().int().positive().max(86_400_000).optional().describe("Without a pid: the heartbeat limit in ms (default: 300000)"),
  log: z.string().min(1).max(1000).optional().describe("The absolute path of the log file of the job"),
});
type LeaseInput = z.infer<typeof LeaseInput>;

const IdInput = z.object({ id: z.string().min(1).max(100).describe("The id of the lease") });
type IdInput = z.infer<typeof IdInput>;

const WaitInput = IdInput.extend({
  timeoutMs: z.number().int().positive().max(3_600_000).default(600_000).describe("The longest wait in ms (default: 600000)"),
});
type WaitInput = z.infer<typeof WaitInput>;

const Usage = z
  .object({
    peakMb: z.number().min(0).optional().describe("The peak memory of the job in MB"),
    writtenMb: z.number().min(0).optional().describe("The MB that the job wrote"),
    cpuMs: z.number().min(0).optional().describe("The processor time of the job in ms"),
    tempMb: z.number().min(0).optional().describe("The size of the temp folder of the job in MB, before its removal"),
  })
  .strict();

const ReleaseInput = IdInput.extend({
  reason: z.string().max(200).optional().describe("Why the lease ends"),
  peakMb: z.number().min(0).optional().describe("The peak memory of the job in MB, from its job object"),
  usage: Usage.optional().describe("The use of the job at its release, from its holder"),
  exitCode: z.number().int().optional().describe("The exit code of the job"),
  signal: z.string().min(1).max(32).optional().describe("The signal that stopped the job, for example SIGTERM"),
});
type ReleaseInput = z.infer<typeof ReleaseInput>;

const JobInput = z.object({
  query: z.string().min(1).max(500).describe("The id of a lease, a prefix of 8 or more characters of it, or the name of a job"),
  holder: z.string().min(1).max(200).optional().describe("Only the jobs of this holder"),
  all: z.boolean().default(false).describe("Each match of the last 24 hours, not only the latest (default: false)"),
});
type JobInput = z.infer<typeof JobInput>;

const ConfigSetInput = z.object({
  jobTemp: z
    .string()
    .min(1)
    .max(1000)
    .nullable()
    .optional()
    .describe("The temp root of the jobs, for example D:\\headroom\\tmp. null removes it, and each job then keeps the TEMP of its parent."),
  health: z
    .record(z.string().min(1).max(64), z.string().min(1).max(2000))
    .nullable()
    .optional()
    .describe("The URLs that the service monitor checks, by name (H27). null gives the default: the fleet site. {} checks no URL."),
});
type ConfigSetInput = z.infer<typeof ConfigSetInput>;

const HistoryInput = z.object({
  minutes: z.number().int().positive().max(10_080).default(60).describe("The length of the history in minutes (default: 60)"),
  step: z.number().int().positive().max(1440).default(1).describe("The minutes in each row: each row is the average of its samples (default: 1)"),
});
type HistoryInput = z.infer<typeof HistoryInput>;

const PoolInput = z.object({
  name: z.string().min(1).max(64).refine((name) => name !== "memory", "The memory is measured, not configured").describe("The name of the pool"),
  capacity: z.number().describe("The capacity. A capacity below 0 removes the pool, and then its capacity is 1."),
});
type PoolInput = z.infer<typeof PoolInput>;

const PoolTagsInput = z.object({
  limit: z.number().int().positive().max(200).default(20).describe("The number of tags in each list (default: 20)"),
});
type PoolTagsInput = z.infer<typeof PoolTagsInput>;

const SuggestInput = z.object({
  job: z.string().min(1).max(500).describe("The job, as headroom run names it: the command line or --job"),
  holder: z.string().min(1).max(200).optional().describe("The holder: its own runs come first"),
});
type SuggestInput = z.infer<typeof SuggestInput>;

const Empty = z.object({}).strict();
type Empty = z.infer<typeof Empty>;

const anything = <T>(): ReturnType<typeof zodAdapter<T>> => zodAdapter<T>(z.custom<T>(() => true));

/** The status of the daemon: the status of the engine, and the restart that waits for an idle queue. */
export interface DaemonStatus extends Status {
  /** The restart that waits for an idle queue. A daemon of an older version does not give it. */
  readonly restart?: PendingRestart | undefined;
}

/** This function gives the procedures of headroom for one engine. `pendingRestart` gives the restart that waits for an idle queue. */
export function resourceProcedures(engine: Engine, pendingRestart: () => PendingRestart | null = () => null): AnyProcedure[] {
  const found = (lease: Lease | undefined, id: string): Lease => {
    if (!lease) throw new Error(`No lease has the id ${id}`);
    return lease;
  };

  const status = createProcedure()
    .path(["resources", "status"])
    .input(zodAdapter<Empty>(Empty))
    .output(anything<DaemonStatus>())
    .meta({
      description: "Give the memory of the computer, the free amounts, the active leases, the memory of each owner and a restart that waits",
      args: [],
      output: "json",
      effects: { reads: ["headroom", "process"], writes: [], destructive: false },
    })
    .handler(async (): Promise<DaemonStatus> => {
      const restart = pendingRestart();
      return restart === null ? engine.status() : { ...engine.status(), restart };
    })
    .build() as AnyProcedure;

  const lease = createProcedure()
    .path(["resources", "lease"])
    .input(zodAdapter<LeaseInput>(LeaseInput))
    .output(anything<Lease>())
    .meta({
      description: "Ask for a lease. It is granted at once when it fits, else it waits: use resources.wait",
      args: ["holder", "job"],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: false },
    })
    .handler(async (input: LeaseInput): Promise<Lease> =>
      engine.request({
        holder: input.holder,
        job: input.job,
        amounts: input.amounts,
        priority: input.priority,
        pid: input.pid,
        ttlMs: input.ttlMs,
        log: input.log,
      }),
    )
    .build() as AnyProcedure;

  const wait = createProcedure()
    .path(["resources", "wait"])
    .input(zodAdapter<WaitInput>(WaitInput))
    .output(anything<Lease>())
    .meta({
      description: "Wait until a lease is granted or ends, or until the time limit",
      args: ["id"],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (input: WaitInput, ctx?: ProcedureContext): Promise<Lease> =>
      engine.waitFor(input.id, { signal: ctx?.signal, timeoutMs: input.timeoutMs }),
    )
    .build() as AnyProcedure;

  const release = createProcedure()
    .path(["resources", "release"])
    .input(zodAdapter<ReleaseInput>(ReleaseInput))
    .output(anything<Lease>())
    .meta({
      description: "End a lease. The waiting leases that now fit are granted.",
      args: ["id"],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: false, idempotent: true },
    })
    .handler(async (input: ReleaseInput): Promise<Lease> => {
      const exit = input.exitCode === undefined && input.signal === undefined ? undefined : { code: input.exitCode ?? null, signal: input.signal ?? null };
      return found(engine.release(input.id, input.reason, input.peakMb, usageOf(input.usage), exit), input.id);
    })
    .build() as AnyProcedure;

  const job = createProcedure()
    .path(["resources", "job"])
    .input(zodAdapter<JobInput>(JobInput))
    .output(anything<JobState[]>())
    .meta({
      description:
        "Give the state of a job of headroom run: queued, running or exited, with its exit code, its times, its peak memory and its log. The newest first: one job, or each match of 24 hours with all.",
      args: ["query"],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (input: JobInput): Promise<JobState[]> => engine.jobs({ query: input.query, holder: input.holder, all: input.all }))
    .build() as AnyProcedure;

  const renew = createProcedure()
    .path(["resources", "renew"])
    .input(zodAdapter<IdInput>(IdInput))
    .output(anything<Lease>())
    .meta({
      description: "Record a heartbeat of a lease that has no process",
      args: ["id"],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: false, idempotent: true },
    })
    .handler(async (input: IdInput): Promise<Lease> => found(engine.renew(input.id), input.id))
    .build() as AnyProcedure;

  const history = createProcedure()
    .path(["resources", "history"])
    .input(zodAdapter<HistoryInput>(HistoryInput))
    .output(anything<History>())
    .meta({
      description: "Give the memory samples, the memory of each owner, the ended leases and the points of each resource of the last minutes",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (input: HistoryInput): Promise<History> => engine.history(Date.now() - input.minutes * 60_000, input.step * 60_000))
    .build() as AnyProcedure;

  const pool = createProcedure()
    .path(["resources", "pool"])
    .input(zodAdapter<PoolInput>(PoolInput))
    .output(anything<Status>())
    .meta({
      description: "Set the capacity of a named pool, for example cpu 8. A pool with no capacity is a lock of 1.",
      args: ["name", "capacity"],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: false, idempotent: true },
    })
    .handler(async (input: PoolInput): Promise<Status> => {
      engine.setPool(input.name, input.capacity);
      return engine.status();
    })
    .build() as AnyProcedure;

  const alerts = createProcedure()
    .path(["resources", "alerts"])
    .input(zodAdapter<Empty>(Empty))
    .output(anything<Alerts>())
    .meta({
      description:
        "Give the active alerts (a runaway process, an orphan, low memory, the commit charge, the kernel pool, a drive, the dynamic TCP ports, a service) and the alerts that ended last",
      args: [],
      output: "json",
      effects: { reads: ["headroom", "process"], writes: [], destructive: false },
    })
    .handler(async (): Promise<Alerts> => engine.alerts())
    .build() as AnyProcedure;

  const pooltags = createProcedure()
    .path(["resources", "pooltags"])
    .input(zodAdapter<PoolTagsInput>(PoolTagsInput))
    .output(anything<PoolTags>())
    .meta({
      description: "Give the non-paged kernel pool by pool tag: the largest tags and the tags that grew in the last hour (Windows)",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (input: PoolTagsInput): Promise<PoolTags> => engine.poolTags(input.limit))
    .build() as AnyProcedure;

  const ports = createProcedure()
    .path(["resources", "ports"])
    .input(zodAdapter<Empty>(Empty))
    .output(anything<TcpPorts>())
    .meta({
      description: "Give the listening TCP ports with the process and the owner of each, by port, and the dynamic port range",
      args: [],
      output: "json",
      effects: { reads: ["headroom", "process"], writes: [], destructive: false },
    })
    .handler(async (): Promise<TcpPorts> => engine.ports())
    .build() as AnyProcedure;

  const services = createProcedure()
    .path(["resources", "services"])
    .input(zodAdapter<Empty>(Empty))
    .output(anything<ServiceHealth[]>())
    .meta({
      description: "Give the health of each shared service: Docker, the URLs of the setting health and the MCP servers of the gateway (H27)",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (): Promise<ServiceHealth[]> => engine.services())
    .build() as AnyProcedure;

  const suggest = createProcedure()
    .path(["resources", "suggest"])
    .input(zodAdapter<SuggestInput>(SuggestInput))
    .output(anything<Suggestion>())
    .meta({
      description: "Give a memory amount for a job from the peaks of its last runs (the 90th percentile and 25% more)",
      args: ["job"],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (input: SuggestInput): Promise<Suggestion> => engine.suggest(input.job, input.holder))
    .build() as AnyProcedure;

  const configGet = createProcedure()
    .path(["config", "get"])
    .input(zodAdapter<Empty>(Empty))
    .output(anything<Config>())
    .meta({
      description: "Give the settings of headroom, for example the temp root of the jobs",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (): Promise<Config> => engine.config())
    .build() as AnyProcedure;

  const configSet = createProcedure()
    .path(["config", "set"])
    .input(zodAdapter<ConfigSetInput>(ConfigSetInput))
    .output(anything<Config>())
    .meta({
      description: "Change the settings of headroom. jobTemp: each job of headroom run gets its TEMP folder under it. health: the URLs to check.",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: false, idempotent: true },
    })
    .handler(async (input: ConfigSetInput): Promise<Config> => engine.setConfig({ jobTemp: input.jobTemp, health: input.health }))
    .build() as AnyProcedure;

  return [status, lease, wait, release, job, renew, history, pool, alerts, pooltags, ports, services, suggest, configGet, configSet];
}

const RestartWhenIdleInput = z.object({
  cancel: z.boolean().default(false).describe("True: cancel the restart that waits (default: false)"),
});
type RestartWhenIdleInput = z.infer<typeof RestartWhenIdleInput>;

/** This function gives the procedures of the service: `service.*`. */
export function serviceProcedures(idle: IdleRestart): AnyProcedure[] {
  const restartWhenIdle = createProcedure()
    .path(["service", "restartWhenIdle"])
    .input(zodAdapter<RestartWhenIdleInput>(RestartWhenIdleInput))
    .output(anything<IdleRestartState>())
    .meta({
      description: "Restart the daemon at the first tick when no lease waits, and return at once. cancel: true cancels the restart.",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom", "process"], destructive: false, idempotent: true },
    })
    .handler(async (input: RestartWhenIdleInput): Promise<IdleRestartState> => (input.cancel ? idle.cancel() : idle.ask()))
    .build() as AnyProcedure;

  return [restartWhenIdle];
}

/** This function gives the usage of a release with only the fields that have a value. */
function usageOf(input: ReleaseInput["usage"]): JobUsage | undefined {
  if (input === undefined) return undefined;
  const usage: Record<string, number> = {};
  for (const [name, value] of Object.entries(input)) if (typeof value === "number") usage[name] = value;
  return usage as JobUsage;
}

const ServerName = z.string().regex(SERVER_NAME, "Use letters, digits, - and _").describe("The name of the server, for example vex");

const McpAddInput = z.object({
  name: ServerName,
  command: z.string().min(1).max(1000).describe("The program of the server, for example node"),
  args: z.array(z.string().max(4000)).max(100).optional().describe("The arguments of the program"),
  cwd: z.string().max(1000).optional().describe("The folder where the server starts"),
  env: z.record(z.string().max(200), z.string().max(4000)).optional().describe("More environment variables of the server"),
  idleMinutes: z.number().int().min(0).max(10_080).optional().describe("Stop the server after this idle time (default: 30). 0 keeps it."),
});
type McpAddInput = z.infer<typeof McpAddInput>;

const McpNameInput = z.object({ name: ServerName });
type McpNameInput = z.infer<typeof McpNameInput>;

const McpWarmInput = z.object({
  names: z.array(ServerName).max(100).optional().describe("The servers to start (default: each configured server)"),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000).describe("The longest wait in ms (default: 120000)"),
});
type McpWarmInput = z.infer<typeof McpWarmInput>;

/** The state of a server of the gateway, with the memory of its processes. */
export interface McpServerRow extends McpServerState {
  readonly memoryMb: number;
}

/** This function gives the procedures of the MCP gateway: `mcp.*`. */
export function gatewayProcedures(engine: Engine, gateway: McpGateway): AnyProcedure[] {
  const rows = (): McpServerRow[] => gateway.list().map((state) => ({ ...state, memoryMb: state.pid === null ? 0 : Math.round(engine.treeMb(state.pid)) }));

  const list = createProcedure()
    .path(["mcp", "list"])
    .input(zodAdapter<Empty>(Empty))
    .output(anything<McpServerRow[]>())
    .meta({
      description: "Give each MCP server of the gateway: its state, its process, its memory and its sessions",
      args: [],
      output: "json",
      effects: { reads: ["headroom", "process"], writes: [], destructive: false },
    })
    .handler(async (): Promise<McpServerRow[]> => rows())
    .build() as AnyProcedure;

  const add = createProcedure()
    .path(["mcp", "add"])
    .input(zodAdapter<McpAddInput>(McpAddInput))
    .output(anything<McpServerRow[]>())
    .meta({
      description: "Add or change an MCP server of the gateway. The sessions reach it at /mcp/<name>.",
      args: ["name", "command"],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: false, idempotent: true },
    })
    .handler(async (input: McpAddInput): Promise<McpServerRow[]> => {
      const { name, ...spec } = input;
      engine.setMcpServer(name, spec);
      await gateway.reset(name);
      return rows();
    })
    .build() as AnyProcedure;

  const remove = createProcedure()
    .path(["mcp", "remove"])
    .input(zodAdapter<McpNameInput>(McpNameInput))
    .output(anything<McpServerRow[]>())
    .meta({
      description: "Stop an MCP server of the gateway and remove it",
      args: ["name"],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom", "process"], destructive: true, idempotent: true },
    })
    .handler(async (input: McpNameInput): Promise<McpServerRow[]> => {
      engine.setMcpServer(input.name, null);
      await gateway.reset(input.name);
      return rows();
    })
    .build() as AnyProcedure;

  const restart = createProcedure()
    .path(["mcp", "restart"])
    .input(zodAdapter<McpNameInput>(McpNameInput))
    .output(anything<McpServerRow[]>())
    .meta({
      description: "Stop an MCP server of the gateway. Its sessions stay open, and the next request starts it again.",
      args: ["name"],
      output: "json",
      effects: { reads: ["headroom"], writes: ["process"], destructive: false, idempotent: true },
    })
    .handler(async (input: McpNameInput): Promise<McpServerRow[]> => {
      await gateway.restart(input.name);
      return rows();
    })
    .build() as AnyProcedure;

  const warm = createProcedure()
    .path(["mcp", "warm"])
    .input(zodAdapter<McpWarmInput>(McpWarmInput))
    .output(anything<McpServerRow[]>())
    .meta({
      description: "Start MCP servers of the gateway before the first request, and wait until each answers or the time ends",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: ["process"], destructive: false, idempotent: true },
    })
    .handler(async (input: McpWarmInput): Promise<McpServerRow[]> => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, input.timeoutMs);
      });
      try {
        await Promise.race([gateway.warm(input.names), timeout]);
      } finally {
        clearTimeout(timer);
      }
      return rows();
    })
    .build() as AnyProcedure;

  return [list, add, remove, restart, warm];
}
