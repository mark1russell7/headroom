import { Engine, Store, type CancelQuery, type Sampler } from "@headroom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelCommand, NOT_STARTED, notStartedLine, type CancelOutput } from "./cancel-cli.ts";
import type { Connection } from "./client.ts";
import { NO_JOB } from "./job-cli.ts";

const sampler: Sampler = {
  memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
  processes: () => [],
  close: () => undefined,
};

describe("headroom cancel", () => {
  let now: number;
  let engine: Engine;
  let calls: unknown[];
  let lines: string[];
  let errors: string[];
  let connection: Connection;
  const io = (): CancelOutput => ({ out: (text) => lines.push(text), err: (text) => errors.push(text) });
  // The slot docker is a lock of 1: the first lease runs, and the others wait. This process holds each lease.
  const ask = (holder: string, job: string) => {
    now += 1000;
    return engine.request({ holder, job, amounts: { docker: 1 }, pid: process.pid });
  };

  beforeEach(() => {
    now = 1_000_000;
    engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    calls = [];
    lines = [];
    errors = [];
    connection = {
      endpoint: "http://127.0.0.1:0",
      call: async <T>(path: readonly string[], input: unknown): Promise<T> => {
        calls.push({ path, input });
        return engine.cancel(input as CancelQuery) as T;
      },
    };
  });
  afterEach(() => engine.close());

  it("cancels a waiting job by its id prefix, and its waiting client exits with code 75 and the name of who cancelled it", async () => {
    ask("graph", "docker build");
    const queued = ask("jarvis", "pnpm test");
    const wait = engine.waitFor(queued.id, { timeoutMs: 60_000 });
    expect(await cancelCommand([queued.id.slice(0, 8)], connection, "jarvis", io())).toBe(0);
    expect(calls).toEqual([{ path: ["resources", "cancel"], input: { id: queued.id.slice(0, 8), all: false, by: "jarvis" } }]);
    expect(lines).toEqual([`Cancelled pnpm test (${queued.id.slice(0, 8)}) of jarvis. It did not start, and its headroom run exits with code 75.`]);
    const ended = await wait;
    expect(NOT_STARTED).toBe(75);
    expect(notStartedLine("pnpm test", ended)).toBe("headroom: pnpm test was cancelled by jarvis before it started. Nothing ran.");
  });

  it("cancels by job, lists more than one match and cancels none, and cancels each with --all", async () => {
    ask("graph", "docker build");
    const a = ask("jarvis", "pnpm test");
    const b = ask("vex", "pnpm test");
    expect(await cancelCommand(["--job", "pnpm test"], connection, "cli", io())).toBe(1);
    expect(errors[0]).toBe('headroom: 2 waiting jobs match "pnpm test", so none is cancelled. Give the id of one, or --all to cancel each:');
    expect(errors.slice(1).map((line) => line.trim().split(" ")[0])).toEqual([a.id, b.id]);
    expect(engine.get(a.id)?.state).toBe("waiting");
    expect(await cancelCommand(["--job", "pnpm test", "--holder", "vex"], connection, "cli", io())).toBe(0);
    expect(engine.get(b.id)).toMatchObject({ state: "cancelled", cancelledBy: "cli" });
    const c = ask("vex", "pnpm test");
    expect(await cancelCommand(["--job", "pnpm test", "--all"], connection, "organizer", io())).toBe(0);
    expect([a, c].map((lease) => engine.get(lease.id)?.cancelledBy)).toEqual(["organizer", "organizer"]);
  });

  it("does not take a running job, tells of an ended job, and gives 3 with no match", async () => {
    const runs = ask("graph", "docker build");
    expect(await cancelCommand([runs.id], connection, "cli", io())).toBe(1);
    expect(errors).toEqual([
      `headroom: docker build (${runs.id.slice(0, 8)}) of graph runs, so headroom cancel does not take it. headroom release ${runs.id} ends its lease, but the job does not stop.`,
    ]);
    engine.release(runs.id, "the job ended with code 0");
    expect(await cancelCommand([runs.id], connection, "cli", io())).toBe(0);
    expect(lines).toEqual([`docker build (${runs.id.slice(0, 8)}) of graph ended already: released (the job ended with code 0). Nothing waits.`]);
    expect(await cancelCommand(["--job", "nothing"], connection, "cli", io())).toBe(NO_JOB);
    expect(errors.at(-1)).toBe('headroom: no waiting job matches "nothing".');
  });

  it("gives 2 for a wrong use, 1 without the daemon, and the result as JSON", async () => {
    expect(await cancelCommand([], connection, "cli", io())).toBe(2);
    expect(await cancelCommand(["abcdefgh", "--job", "x"], connection, "cli", io())).toBe(2);
    expect(await cancelCommand(["abc"], connection, "cli", io())).toBe(2);
    expect(errors.at(-1)).toBe("headroom: give the lease id or its first 8 characters or more, not abc.");
    expect(calls).toEqual([]);
    expect(await cancelCommand(["abcdefgh"], null, "cli", io())).toBe(1);
    ask("graph", "docker build");
    const queued = ask("jarvis", "pnpm test");
    expect(await cancelCommand([queued.id, "--json"], connection, "cli", io())).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ cancelled: [{ id: queued.id, state: "cancelled" }], matches: [{ id: queued.id }] });
  });

  it("gives the old line for a lease that ended without a cancel", () => {
    const lease = ask("graph", "docker build");
    expect(notStartedLine("docker build", { ...lease, state: "expired", reason: "the process exited" })).toBe(
      "headroom: the lease ended before the job started: the process exited",
    );
  });
});
