/**
 * The procedures of headroom: `resources.*`, `config.*`, `mcp.*`, `service.*` and `disk.*`. Each procedure uses one engine.
 */

import { BELOW_PEAK_REASON_MAX, DEFAULT_ALERT_RULES, FITS_DEFAULT, JOB_KINDS, type AlertRules, type Alerts, type CancelResult, type Config, type ConfigChange, type DrainStatus, type Engine, type Fits, type History, type JobState, type JobUsage, type Lease, type NativeRefusalCount, type NativeRefusalInput, type PeaksAnswer, type Peer, type PoolTags, type ReapCandidate, type ReapEntry, type ReapResult, type ServiceHealth, type ShadowView, type Status, type Suggestion, type TcpPorts } from "@headroom/core";
import type { DeferredStarts } from "./deferred.ts";
import type { ReportSummary } from "./disk-report.ts";
import { SERVER_NAME, type McpGateway, type McpServerState } from "./gateway.ts";
import { longPathRefusal, nativeLongPath, refusalRow, type NativeImages } from "./native-paths.ts";
import type { IdleRestart, IdleRestartState, PendingRestart } from "./restart.ts";
import { createProcedure, zodAdapter, type AnyProcedure, type ProcedureContext } from "@procedures/client";
import { z } from "zod";

const Amounts = z.record(z.string().min(1).max(64), z.number().min(0)).describe("The amounts: memory in MB, cpu in processors, or a slot of a named pool");

/**
 * The typed key of a job (H78). The client of `headroom run` reads it from the command and the files of its folder.
 * The core matches only these fields. It does not read the command.
 */
const JobKeyInput = z
  .object({
    kind: z.enum(JOB_KINDS).describe("The kind of the job: install, test, typecheck, build, lint, browser or other"),
    repo: z.string().min(1).max(200).nullable().describe("The name of the git repository of the job, or null outside a repository"),
    lock: z.string().regex(/^[0-9a-f]{16}$/).nullable().describe("The first 16 hex characters of the SHA-256 of the lockfile, or null with no lockfile"),
    filter: z.string().min(1).max(1000).nullable().describe("The sorted --filter values, else the package folder from the repository root, or null"),
    warm: z.boolean().nullable().describe("True when node_modules is at the root of the workspace, or null with no root"),
    packages: z.number().int().nonnegative().nullable().describe("The count of the packages of the lockfile, or null with no lockfile"),
    command: z.string().max(500).describe("The command with no absolute paths, temporary names or hex ids"),
  })
  .describe("The typed key of the job (H78). The ladder of --mem auto matches it. A client of before H78 sends none.");

const LeaseInput = z.object({
  holder: z.string().min(1).max(200).describe("The holder: a session or a role, for example shop"),
  job: z.string().min(1).max(500).describe("The name of the job, for example pnpm test"),
  amounts: Amounts,
  priority: z.number().int().min(-100).max(100).optional().describe("A higher priority goes first (default: 0)"),
  pid: z.number().int().positive().optional().describe("The process that holds the lease. The lease ends when it exits."),
  ttlMs: z.number().int().positive().max(86_400_000).optional().describe("Without a pid: the heartbeat limit in ms (default: 300000)"),
  log: z.string().min(1).max(1000).optional().describe("The absolute path of the log file of the job"),
  spawnHeavy: z
    .boolean()
    .optional()
    .describe("True: the job starts many processes, so no browser test runs beside it. False: a normal job. Default: the past runs decide (H47)."),
  when: z
    .array(z.string().min(1).max(64))
    .max(16)
    .optional()
    .describe("The conditions of the job (H31), for example ac, battery>=50, usage<80 or starts<700. The lease waits until each one holds."),
  timing: z.boolean().optional().describe("True: the job measures time, so it waits for AC power (H31)"),
  batteryOk: z.boolean().optional().describe("True: a heavy job starts also on battery below the floor (H31)"),
  duringDrain: z.boolean().optional().describe("True: the job starts also in a planned drain for a reboot (H34)"),
  ignorePresence: z
    .boolean()
    .optional()
    .describe("True: a heavy job does not wait while Mark is busy, and gets no efficiency mode while Mark is at the laptop (H33)"),
  cpuCap: z
    .number()
    .positive()
    .max(1024)
    .optional()
    .describe("The hard cap of the job in cores, with --cpu N --limit (H23). The client sets it on the job object, and the status names the capped jobs."),
  key: JobKeyInput.nullable().optional(),
  folder: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .describe("The full path of the folder of the job (H62). A container of a compose project in this folder can count for the lease."),
  belowPeak: z
    .string()
    .min(1)
    .max(BELOW_PEAK_REASON_MAX)
    .optional()
    .describe("The reason to start below the floor of the command (H215): the peak of its last run times 1.1. Without it, a lease below the floor gets a refusal."),
  loanMs: z
    .number()
    .int()
    .positive()
    .max(86_400_000)
    .optional()
    .describe(
      "The time limit of a loan in ms, with --loan (H219). A job that does not fit can borrow the unused hold of a long lease. At the time limit, the loan returns, or the lease ends.",
    ),
});
type LeaseInput = z.infer<typeof LeaseInput>;

const FitsInput = LeaseInput.pick({ amounts: true, priority: true, spawnHeavy: true, when: true, timing: true, batteryOk: true, duringDrain: true, ignorePresence: true, loanMs: true }).extend({
  holder: LeaseInput.shape.holder.optional().describe(`The holder of the lease to test (default: ${FITS_DEFAULT})`),
  job: LeaseInput.shape.job.optional().describe(`The job of the lease to test. Its past runs give its expected run time (default: ${FITS_DEFAULT}, with no runs).`),
});
type FitsInput = z.infer<typeof FitsInput>;

const DeferInput = LeaseInput.omit({ pid: true, ttlMs: true }).extend({
  log: z.string().min(1).max(1000).describe("The absolute path of the log file of the job"),
  start: z
    .object({
      args: z.array(z.string().max(32_000)).max(1000),
      cwd: z.string().min(1).max(4000),
      env: z.record(z.string().max(32_767), z.string().max(32_767)),
      waitMs: z.number().int().positive(),
    })
    .describe("The start of the client at the grant (H64). The daemon does not write it to the store or to its log."),
});
type DeferInput = z.infer<typeof DeferInput>;

const AdoptInput = z.object({
  id: z.string().min(1).max(200),
  pid: z.number().int().positive().describe("The client of the lease. The lease ends when it exits."),
});
type AdoptInput = z.infer<typeof AdoptInput>;

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
  processes: z.number().int().min(0).optional().describe("The processes that the job started, from its job object"),
});
type ReleaseInput = z.infer<typeof ReleaseInput>;

const RenewInput = IdInput.extend({
  processes: z.number().int().min(0).optional().describe("The processes that the job started so far, from its job object"),
});
type RenewInput = z.infer<typeof RenewInput>;

const CancelInput = z.object({
  id: z.string().min(1).max(100).optional().describe("The id of a waiting lease, or its first 8 characters or more"),
  job: z.string().min(1).max(500).optional().describe("The name of the job of a waiting lease"),
  holder: z.string().min(1).max(200).optional().describe("Only the leases of this holder"),
  all: z.boolean().default(false).describe("True: cancel each waiting match. False: a query with more than one match cancels none (default: false)"),
  by: z.string().min(1).max(200).default("cli").describe("Who cancels: the holder of the caller (default: cli)"),
});
type CancelInput = z.infer<typeof CancelInput>;

const JobInput = z.object({
  query: z.string().min(1).max(500).describe("The id of a lease, a prefix of 8 or more characters of it, or the name of a job"),
  holder: z.string().min(1).max(200).optional().describe("Only the jobs of this holder"),
  all: z.boolean().default(false).describe("Each match of the last 24 hours, not only the latest (default: false)"),
});
type JobInput = z.infer<typeof JobInput>;

/** One alert limit in a change (H179): a value of 0 or more, or `null` for the default. The engine checks the rest. */
const alertLimit = z.number().min(0).nullable().optional();

/** A change of the alert limits (H179), with one field for each name of `AlertRules`. */
const AlertsChangeInput = z
  .object(Object.fromEntries(Object.keys(DEFAULT_ALERT_RULES).map((name) => [name, alertLimit])) as Record<keyof AlertRules, typeof alertLimit>)
  .strict();

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
    .describe("The URLs that the service monitor checks, by name (H27). null removes the setting, and the monitor then checks no URL."),
  spawnHeavy: z
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .nullable()
    .optional()
    .describe("The limit of a spawn-heavy job in process starts a minute (H47). null gives the default: 600."),
  batteryFloor: z
    .number()
    .int()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .describe("The battery floor in percent (H31): on battery below it, a new heavy lease waits. 0 turns it off. null gives the default: 25."),
  usageFile: z
    .string()
    .min(1)
    .max(1000)
    .nullable()
    .optional()
    .describe("The usage file for the condition usage<N (H31). It has no default. null removes the setting, and usage<N then waits."),
  rolesFile: z
    .string()
    .min(1)
    .max(1000)
    .nullable()
    .optional()
    .describe("The registry of the roles for the owners of Docker projects and for peers (H57). The folder roles next to it holds the role files. It has no default. null removes the setting, and the roles are then unknown."),
  memoryReserveMb: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe("The memory in MB that a lease does not take (H60). A grant waits when it would leave less. null gives the default: 1024."),
  cpuReserve: z
    .number()
    .min(0)
    .max(1024)
    .nullable()
    .optional()
    .describe("The cores that the broker keeps out of the cpu amounts of the leases for Mark (H23). 0 turns it off. null gives the default: 2."),
  presence: z
    .boolean()
    .nullable()
    .optional()
    .describe("The presence rules (H33): while Mark works or is on a call, heavy jobs wait or run slower. false turns them off. null gives the default: on."),
  awayAfterMs: z
    .number()
    .int()
    .min(30_000)
    .max(86_400_000)
    .nullable()
    .optional()
    .describe("The time with no input after which Mark is away, in ms (H33). null gives the default: 300000."),
  busyWaitMs: z
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .nullable()
    .optional()
    .describe("The longest wait of a new heavy lease while Mark is busy, in ms (H33). null gives the default: 1200000."),
  presentReserve: z
    .number()
    .min(0)
    .max(1024)
    .nullable()
    .optional()
    .describe("The cores that the CPU reserve gets while Mark is present or busy (H33). null gives the default: 2."),
  autoDrainMb: z
    .number()
    .int()
    .min(0)
    .max(1_048_576)
    .nullable()
    .optional()
    .describe(
      "The level of the automatic drain in MB of the two kernel pools together (H34). At or above it for 2 minutes, new jobs wait for a reboot. 0 turns it off. null gives the default: 6144.",
    ),
  worktreeAutoClean: z
    .boolean()
    .nullable()
    .optional()
    .describe("The automatic worktree cleanup (H175). false: the daemon writes only the plan. true: it also removes the trees of the plan, in batches. null gives the default: false."),
  reapAuto: z
    .boolean()
    .nullable()
    .optional()
    .describe("The automatic reap (H183). In this version true stops no process: the daemon only writes the shadow log. null gives the default: false."),
  startTrace: z
    .array(z.string())
    .nullable()
    .optional()
    .describe(
      "The owner kinds of the start trace (H188), for example [\"session\", \"mcp\"]. The daemon puts their processes and the processes of the granted leases in job objects, and names each start in their trees. [] turns the trace off. null gives the default: session, mcp, service, docker.",
    ),
  startTraceHold: z
    .array(z.string())
    .nullable()
    .optional()
    .describe(
      "The owner kinds whose jobs of the start trace refuse a breakaway (H191), so the children of their processes stay in the trace. The change also applies to the open jobs. With [], each job lets a child break away. null gives the default: session.",
    ),
  startCap: z
    .array(z.object({ afterMs: z.number().int().min(0), perMinute: z.number().int().positive() }))
    .max(12)
    .nullable()
    .optional()
    .describe(
      "The cap on the process starts of the computer at the grant of a lease (H197): steps by the time since the boot, the first at afterMs 0, for example [{\"afterMs\":0,\"perMinute\":1822},{\"afterMs\":3600000,\"perMinute\":3500}]. [] turns the cap off. null gives the default.",
    ),
  alerts: AlertsChangeInput.nullable()
    .optional()
    .describe(
      "A change of the alert limits (H179), by the names of AlertRules, for example availableCriticalMb. A number sets a limit, and null gives the default of one limit. null for the whole object gives all the defaults.",
    ),
}).strict();
type ConfigSetInput = z.infer<typeof ConfigSetInput>;

const ReapListInput = z.object({
  all: z.boolean().default(false).describe("Also list the orphans that no session started (default: only the processes of a session)"),
});
type ReapListInput = z.infer<typeof ReapListInput>;

const ReapInput = z.object({
  pid: z.number().int().positive().describe("The process ID of a process whose parent is proven gone"),
  caller: z
    .object({ name: z.string().min(1), id: z.string() })
    .nullable()
    .default(null)
    .describe("The session that asks: its name and the ID of its session file. A process of this session gets a stop. null: no session."),
});
type ReapInput = z.infer<typeof ReapInput>;

const HistoryInput = z.object({
  minutes: z.number().int().positive().max(10_080).default(60).describe("The length of the history in minutes (default: 60)"),
  step: z.number().int().positive().max(1440).default(1).describe("The minutes in each row: each row is the average of its samples (default: 1)"),
});
type HistoryInput = z.infer<typeof HistoryInput>;

const PeaksInput = z.object({
  minutes: z.number().int().positive().max(10_080).default(60).describe("The length of the window in minutes (default: 60)"),
  minMb: z.number().nonnegative().default(0).describe("The least peak in MB of a minute that counts (default: 0, each kept minute)"),
  lease: z.string().min(1).max(200).optional().describe("Only the minutes of this lease ID"),
  limit: z.number().int().positive().max(500).default(30).describe("The most holders in the answer (default: 30)"),
  kind: z.enum(["process", "container"]).default("process").describe("The kind of the holder of the key: process or container"),
  key: z.string().min(1).max(200).optional().describe("The key of one holder, for example 4120:1763491200000. The answer then also gives its minutes."),
});
type PeaksInput = z.infer<typeof PeaksInput>;

const PoolInput = z.object({
  name: z.string().min(1).max(64).refine((name) => name !== "memory", "The memory is measured, not configured").describe("The name of the pool"),
  capacity: z.number().describe("The capacity. A capacity below 0 removes the pool, and then its capacity is 1."),
});
type PoolInput = z.infer<typeof PoolInput>;

const PoolTagsInput = z.object({
  limit: z.number().int().positive().max(200).default(20).describe("The number of tags in each list (default: 20)"),
  since: z.number().int().nonnegative().optional().describe("The start of the window in ms. 0 is the start of Windows. Without it: the last hour"),
  series: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("The number of lines in each pool: the tags that grew most in the window, with their size at each snapshot (H53). Without it: no lines"),
});
type PoolTagsInput = z.infer<typeof PoolTagsInput>;

const SuggestInput = z.object({
  job: z.string().min(1).max(500).describe("The job, as headroom run names it: the command line or --job"),
  holder: z.string().min(1).max(200).optional().describe("The holder: its own runs come first"),
  key: JobKeyInput.nullable().optional(),
});
type SuggestInput = z.infer<typeof SuggestInput>;

const Port = z.number().int().min(1).max(65_535);

const PeerInput = z.object({
  localPort: Port.describe("The local port that the site sees: the port of its listener"),
  remotePort: Port.describe("The remote port that the site sees: the port of the client"),
});
type PeerInput = z.infer<typeof PeerInput>;

const Time = z.number().int().min(0).max(8_640_000_000_000_000);

const DrainInput = z
  .object({
    at: Time.optional().describe("The time of the planned reboot in ms since the epoch. From it, new leases wait (H34)."),
    until: Time.nullable().optional().describe("The end of the drain when no reboot came, in ms since the epoch. null: no end."),
    cancel: z.boolean().default(false).describe("True: cancel the drain. The waiting leases start when they fit."),
  })
  .strict();
type DrainInput = z.infer<typeof DrainInput>;

const Empty = z.object({}).strict();
type Empty = z.infer<typeof Empty>;

const anything = <T>(): ReturnType<typeof zodAdapter<T>> => zodAdapter<T>(z.custom<T>(() => true));

/**
 * The answer of a heartbeat: the lease, and the efficiency mode for its job (H30). On battery, `eco` is true, and the client
 * of `headroom run` puts the processes of its job in EcoQoS. While Mark is at the laptop, `eco` is true for a heavy job
 * (H33). A daemon of an older version does not give it.
 */
export interface RenewAnswer extends Lease {
  readonly eco: boolean;
  /** The reason of the efficiency mode, for example "Mark works at the laptop", or `null` (H33). A daemon of an older version does not give it. */
  readonly ecoReason?: string | null | undefined;
}

/** The status of the daemon: the status of the engine, and the restart that waits for an idle queue. */
export interface DaemonStatus extends Status {
  /** The restart that waits for an idle queue. A daemon of an older version does not give it. */
  readonly restart?: PendingRestart | undefined;
}

/** This function gives the procedures of headroom for one engine. `pendingRestart` gives the restart that waits for an idle queue. */
export function resourceProcedures(engine: Engine, pendingRestart: () => PendingRestart | null = () => null, deferred: DeferredStarts | null = null): AnyProcedure[] {
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
        spawnHeavy: input.spawnHeavy,
        when: input.when,
        timing: input.timing,
        batteryOk: input.batteryOk,
        duringDrain: input.duringDrain,
        ignorePresence: input.ignorePresence,
        cpuCap: input.cpuCap,
        key: input.key,
        folder: input.folder,
        belowPeak: input.belowPeak,
        loanMs: input.loanMs,
      }),
    )
    .build() as AnyProcedure;

  const fits = createProcedure()
    .path(["resources", "fits"])
    .input(zodAdapter<FitsInput>(FitsInput))
    .output(anything<Fits>())
    .meta({
      description:
        "Tell if a lease of these amounts and this priority starts at the next tick, else why it waits (H220). It is a dry tick: no lease is made. It counts the queue and the hold of a long first request (H178).",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (input: FitsInput): Promise<Fits> =>
      engine.fits({
        holder: input.holder ?? FITS_DEFAULT,
        job: input.job ?? FITS_DEFAULT,
        amounts: input.amounts,
        priority: input.priority,
        spawnHeavy: input.spawnHeavy,
        when: input.when,
        timing: input.timing,
        batteryOk: input.batteryOk,
        duringDrain: input.duringDrain,
        ignorePresence: input.ignorePresence,
        loanMs: input.loanMs,
      }),
    )
    .build() as AnyProcedure;

  const defer = createProcedure()
    .path(["resources", "defer"])
    .input(zodAdapter<DeferInput>(DeferInput))
    .output(anything<Lease>())
    .meta({
      description: "Ask for a lease with no process. The daemon starts the client of the job at the grant (H64)",
      args: ["holder", "job"],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: false },
    })
    .handler(async (input: DeferInput): Promise<Lease> => {
      if (deferred === null) throw new Error("This host has no queue of detached jobs");
      const { start, ...request } = input;
      const lease = engine.request(request);
      deferred.add(lease.id, { ...start, log: input.log });
      return engine.get(lease.id) ?? lease;
    })
    .build() as AnyProcedure;

  const adopt = createProcedure()
    .path(["resources", "adopt"])
    .input(zodAdapter<AdoptInput>(AdoptInput))
    .output(anything<Lease>())
    .meta({
      description: "Give a lease its client, after the daemon started the client at the grant (H64)",
      args: ["id", "pid"],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: false },
    })
    .handler(async (input: AdoptInput): Promise<Lease> => found(engine.adopt(input.id, input.pid), input.id))
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
      return found(engine.release(input.id, input.reason, input.peakMb, usageOf(input.usage), exit, input.processes), input.id);
    })
    .build() as AnyProcedure;

  const cancel = createProcedure()
    .path(["resources", "cancel"])
    .input(zodAdapter<CancelInput>(CancelInput))
    .output(anything<CancelResult>())
    .meta({
      description:
        "Take a waiting lease off the queue by its id or by its job: its job does not start, and its client of headroom run exits with code 75. More than one match cancels none, unless all is true. A granted lease does not change: use resources.release.",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: true },
    })
    .handler(async (input: CancelInput): Promise<CancelResult> =>
      engine.cancel({ id: input.id, job: input.job, holder: input.holder, all: input.all, by: input.by }),
    )
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
    .input(zodAdapter<RenewInput>(RenewInput))
    .output(anything<RenewAnswer>())
    .meta({
      description: "Record a heartbeat of a lease, with the count of processes that its job started so far. The answer tells if the job runs in efficiency mode.",
      args: ["id"],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: false, idempotent: true },
    })
    .handler(async (input: RenewInput): Promise<RenewAnswer> => {
      const lease = found(engine.renew(input.id, input.processes), input.id);
      const eco = engine.ecoOf(lease);
      return { ...lease, eco: eco.on, ecoReason: eco.reason };
    })
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

  const peaks = createProcedure()
    .path(["resources", "peaks"])
    .input(zodAdapter<PeaksInput>(PeaksInput))
    .output(anything<PeaksAnswer>())
    .meta({
      description: "Give the memory peaks of the large processes and containers of the last minutes, the largest first (H62)",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (input: PeaksInput): Promise<PeaksAnswer> =>
      engine.peaks(Date.now() - input.minutes * 60_000, { minMb: input.minMb, lease: input.lease, limit: input.limit, kind: input.kind, key: input.key }),
    )
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
        "Give the active alerts (a runaway process, an orphan, a process with many handles, low memory, the commit charge, the kernel pool, a drive, the dynamic TCP ports, a service) and the alerts that ended last",
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
      description: "Give the kernel pools by pool tag: the largest tags, the tags that grew in the window, and on request their lines for a chart (Windows)",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (input: PoolTagsInput): Promise<PoolTags> => engine.poolTags(input.limit, input.since, input.series))
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

  const peer = createProcedure()
    .path(["resources", "peer"])
    .input(zodAdapter<PeerInput>(PeerInput))
    .output(anything<Peer>())
    .meta({
      description:
        "Give the process at the other end of a loopback TCP connection, the nearest claude.exe above it, its session and its role (H46). Errors: NO_CONNECTION, PEER_GONE, NOT_SUPPORTED.",
      args: ["localPort", "remotePort"],
      output: "json",
      effects: { reads: ["headroom", "process"], writes: [], destructive: false },
    })
    .handler(async (input: PeerInput): Promise<Peer> => engine.peer(input))
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
      description:
        "Give a memory amount and the cores for a job from the peaks of its last runs. With a key, the ladder of H78 goes from the job to its key, its repository, a fit over the repositories and its kind",
      args: ["job"],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (input: SuggestInput): Promise<Suggestion> => engine.suggest(input.job, input.holder, input.key ?? null))
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
      description:
        "Change the settings of headroom. jobTemp: each job of headroom run gets its TEMP folder under it. health: the URLs to check. spawnHeavy: the limit of a spawn-heavy job. batteryFloor: the battery floor for heavy jobs. usageFile: the usage file for usage<N. rolesFile: the registry of the roles. cpuReserve: the cores kept for Mark. presence, awayAfterMs, busyWaitMs, presentReserve: the presence rules (H33). autoDrainMb: the level of the automatic drain (H34). worktreeAutoClean: the automatic worktree cleanup (H175). reapAuto: the automatic reap, which stops no process in this version (H183). startTrace: the owner kinds of the start trace (H188). startTraceHold: the owner kinds whose jobs of the trace refuse a breakaway (H191). startCap: the cap on the process starts at the grant of a lease (H197). alerts: the alert limits that differ from the defaults (H179).",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: false, idempotent: true },
    })
    .handler(
      async (input: ConfigSetInput): Promise<Config> => {
        // Each field of the engine is named here, so the type check fails on a setting that this list leaves out.
        const change: { readonly [K in keyof Required<ConfigChange>]: ConfigChange[K] } = {
          jobTemp: input.jobTemp,
          health: input.health,
          spawnHeavy: input.spawnHeavy,
          batteryFloor: input.batteryFloor,
          usageFile: input.usageFile,
          rolesFile: input.rolesFile,
          memoryReserveMb: input.memoryReserveMb,
          cpuReserve: input.cpuReserve,
          presence: input.presence,
          awayAfterMs: input.awayAfterMs,
          busyWaitMs: input.busyWaitMs,
          presentReserve: input.presentReserve,
          autoDrainMb: input.autoDrainMb,
          worktreeAutoClean: input.worktreeAutoClean,
          reapAuto: input.reapAuto,
          startTrace: input.startTrace,
          startTraceHold: input.startTraceHold,
          startCap: input.startCap,
          alerts: input.alerts,
        };
        return engine.setConfig(change);
      },
    )
    .build() as AnyProcedure;

  const drain = createProcedure()
    .path(["resources", "drain"])
    .input(zodAdapter<DrainInput>(DrainInput))
    .output(anything<DrainStatus | null>())
    .meta({
      description:
        "Plan a drain for a reboot (H34): from at, new leases wait and the running leases finish. until ends it with no reboot. cancel ends it, also an automatic drain. With no field, give the drain.",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: ["headroom"], destructive: false, idempotent: true },
    })
    .handler(async (input: DrainInput): Promise<DrainStatus | null> => {
      if (input.cancel) return engine.cancelDrain();
      if (input.at === undefined) {
        if (input.until !== undefined) throw new RangeError("until needs at");
        return engine.drain();
      }
      return engine.setDrain(input.at, input.until ?? null);
    })
    .build() as AnyProcedure;

  const reapList = createProcedure()
    .path(["resources", "reapList"])
    .input(zodAdapter<ReapListInput>(ReapListInput))
    .output(anything<ReapCandidate[]>())
    .meta({
      description:
        "List the processes whose parent is proven gone (H183), the most private memory first: the ID, the private memory, the age, the session and the command line. By default only the processes of a session.",
      args: [],
      output: "json",
      effects: { reads: ["headroom", "process"], writes: [], destructive: false },
    })
    .handler(async (input: ReapListInput): Promise<ReapCandidate[]> => engine.reapList(input.all))
    .build() as AnyProcedure;

  const reap = createProcedure()
    .path(["resources", "reap"])
    .input(zodAdapter<ReapInput>(ReapInput))
    .output(anything<ReapResult>())
    .meta({
      description:
        "Reap one process whose parent is proven gone (H183). A process of the session of the caller gets a stop. For a process of another session, headroom records a request and shows it as an alert. It does not stop it. A process of no running session needs the owner of the machine.",
      args: ["pid"],
      output: "json",
      effects: { reads: ["headroom", "process"], writes: ["headroom", "process"], destructive: true },
    })
    .handler(async (input: ReapInput): Promise<ReapResult> => engine.reap(input.pid, input.caller))
    .build() as AnyProcedure;

  const reapShadow = createProcedure()
    .path(["resources", "reapShadow"])
    .input(zodAdapter<Empty>(Empty))
    .output(anything<ShadowView>())
    .meta({
      description:
        "Give the shadow log of the automatic reap rule (H183): each process that the rule stops in a later version, with the rule and the setting reapAuto. No rule stops a process in this version.",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (): Promise<ShadowView> => engine.reapShadow())
    .build() as AnyProcedure;

  const reapLog = createProcedure()
    .path(["resources", "reapLog"])
    .input(zodAdapter<Empty>(Empty))
    .output(anything<ReapEntry[]>())
    .meta({
      description: "Give the reap log (H183), the newest first: the stops, the requests, and the processes that need the owner of the machine.",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (): Promise<ReapEntry[]> => engine.reapLog())
    .build() as AnyProcedure;

  return [status, lease, fits, defer, adopt, wait, release, cancel, job, renew, history, peaks, pool, alerts, pooltags, ports, peer, services, suggest, configGet, configSet, drain, reapList, reap, reapShadow, reapLog];
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

/**
 * This function gives the procedures of the disk report (H21): `disk.report`. The command `headroom disk report` writes the
 * report in its own process. The daemon only reads the summary of the saved file, so the dashboard can show it.
 */
export function diskProcedures(summary: () => ReportSummary | null): AnyProcedure[] {
  const report = createProcedure()
    .path(["disk", "report"])
    .input(zodAdapter<Empty>(Empty))
    .output(anything<ReportSummary | null>())
    .meta({
      description: "Give the summary of the last headroom disk report: its time, the free space and the largest places. null: no report.",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (): Promise<ReportSummary | null> => summary())
    .build() as AnyProcedure;

  return [report];
}

const NativeInput = z.object({
  command: z.string().min(1).max(200_000).describe("The command line, for example pnpm test"),
  cwd: z.string().min(1).max(4000).describe("The absolute folder where the command starts"),
  budgetMs: z.number().int().min(0).max(600_000).optional().describe("The longest wait for a walk of the native images in ms. Default: no limit."),
  holder: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("The holder of the command of headroom run. With a holder, a refusal goes in the log of refusals under its name."),
});
type NativeInput = z.infer<typeof NativeInput>;

const RefusalsInput = z.object({
  from: z.number().int().min(0).optional().describe("The start of the range in ms since the epoch. Default: 7 days before the end."),
  to: z.number().int().min(0).optional().describe("The end of the range in ms since the epoch. Default: now."),
});
type RefusalsInput = z.infer<typeof RefusalsInput>;

/** The answer of `resources native`: the refusal of the command for a long native path, or `null` (H203). */
export interface NativeAnswer {
  readonly refusal: string | null;
  readonly limit: number;
}

/** The answer of `resources refusals`: the refusals of the gate of long native paths for each session and source (H203). */
export interface RefusalsAnswer {
  readonly from: number;
  readonly to: number;
  readonly counts: readonly NativeRefusalCount[];
}

/** The log of the refusals of long native paths (H203): the engine writes and counts the rows. */
export interface RefusalLog {
  record(entry: NativeRefusalInput): unknown;
  counts(from: number, to: number): readonly NativeRefusalCount[];
}

/** The default range of `resources refusals`: 7 days, the range of the score of the gate. */
export const REFUSALS_RANGE_MS: number = 7 * 86_400_000;

/**
 * This function gives the procedures of the gate of long native paths (H203). The daemon keeps the cache of the walks.
 * With a log, each refusal of `headroom run` (a call with a holder) is a row of the log, and `resources refusals` counts them.
 */
export function nativeProcedures(images: NativeImages, log?: RefusalLog, now: () => number = Date.now): AnyProcedure[] {
  const native = createProcedure()
    .path(["resources", "native"])
    .input(zodAdapter<NativeInput>(NativeInput))
    .output(anything<NativeAnswer>())
    .meta({
      description:
        "Check a command for a native image path over the limit (H203): a command that runs node in a folder whose longest .node, .exe or .dll has an NT path over 240 characters gets a refusal.",
      args: ["command", "cwd"],
      output: "json",
      effects: { reads: ["files"], writes: log === undefined ? [] : ["headroom"], destructive: false },
    })
    .handler(async (input: NativeInput): Promise<NativeAnswer> => {
      const long = await nativeLongPath(images, input);
      if (long !== null && input.holder !== undefined && log !== undefined) {
        // A failed write of the log does not change the answer: the command still gets its refusal.
        try {
          log.record(refusalRow(long, "run", { session: input.holder }));
        } catch {
          // The store is not writable. The refusal goes on.
        }
      }
      return { refusal: long === null ? null : longPathRefusal(long), limit: images.limit };
    })
    .build() as AnyProcedure;
  if (log === undefined) return [native];

  const refusals = createProcedure()
    .path(["resources", "refusals"])
    .input(zodAdapter<RefusalsInput>(RefusalsInput))
    .output(anything<RefusalsAnswer>())
    .meta({
      description:
        "Count the refusals of the gate of long native paths (H203) for each session and source (hook or run) in a range. Default: the last 7 days.",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (input: RefusalsInput): Promise<RefusalsAnswer> => {
      const to = input.to ?? now();
      const from = input.from ?? to - REFUSALS_RANGE_MS;
      return { from, to, counts: log.counts(from, to) };
    })
    .build() as AnyProcedure;

  return [native, refusals];
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
