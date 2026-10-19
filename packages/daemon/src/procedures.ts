/**
 * The procedures of headroom: `resources.*`. Each procedure uses one engine.
 */

import type { Engine, History, Lease, Status } from "@headroom/core";
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
});
type LeaseInput = z.infer<typeof LeaseInput>;

const IdInput = z.object({ id: z.string().min(1).max(100).describe("The id of the lease") });
type IdInput = z.infer<typeof IdInput>;

const WaitInput = IdInput.extend({
  timeoutMs: z.number().int().positive().max(3_600_000).default(600_000).describe("The longest wait in ms (default: 600000)"),
});
type WaitInput = z.infer<typeof WaitInput>;

const ReleaseInput = IdInput.extend({ reason: z.string().max(200).optional().describe("Why the lease ends") });
type ReleaseInput = z.infer<typeof ReleaseInput>;

const HistoryInput = z.object({
  minutes: z.number().int().positive().max(10_080).default(60).describe("The length of the history in minutes (default: 60)"),
});
type HistoryInput = z.infer<typeof HistoryInput>;

const PoolInput = z.object({
  name: z.string().min(1).max(64).refine((name) => name !== "memory", "The memory is measured, not configured").describe("The name of the pool"),
  capacity: z.number().describe("The capacity. A capacity below 0 removes the pool, and then its capacity is 1."),
});
type PoolInput = z.infer<typeof PoolInput>;

const Empty = z.object({}).strict();
type Empty = z.infer<typeof Empty>;

const anything = <T>(): ReturnType<typeof zodAdapter<T>> => zodAdapter<T>(z.custom<T>(() => true));

/** This function gives the procedures of headroom for one engine. */
export function resourceProcedures(engine: Engine): AnyProcedure[] {
  const found = (lease: Lease | undefined, id: string): Lease => {
    if (!lease) throw new Error(`No lease has the id ${id}`);
    return lease;
  };

  const status = createProcedure()
    .path(["resources", "status"])
    .input(zodAdapter<Empty>(Empty))
    .output(anything<Status>())
    .meta({
      description: "Give the memory of the computer, the free amounts, the active leases and the memory of each owner",
      args: [],
      output: "json",
      effects: { reads: ["headroom", "process"], writes: [], destructive: false },
    })
    .handler(async (): Promise<Status> => engine.status())
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
    .handler(async (input: ReleaseInput): Promise<Lease> => found(engine.release(input.id, input.reason), input.id))
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
      description: "Give the memory samples, the memory of each owner and the ended leases of the last minutes",
      args: [],
      output: "json",
      effects: { reads: ["headroom"], writes: [], destructive: false },
    })
    .handler(async (input: HistoryInput): Promise<History> => engine.history(Date.now() - input.minutes * 60_000))
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

  return [status, lease, wait, release, renew, history, pool];
}
