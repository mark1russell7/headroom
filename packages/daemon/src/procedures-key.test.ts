import { Engine, Store, type Lease, type Sampler, type Suggestion } from "@headroom/core";
import type { AnyProcedure } from "@procedures/client";
import { describe, expect, it } from "vitest";
import { resourceProcedures } from "./procedures.ts";

const sampler: Sampler = {
  memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
  processes: () => [],
  close: () => undefined,
};

/** This function calls a procedure through its schema, as the daemon does. */
async function call<T>(procedures: readonly AnyProcedure[], path: string, input: unknown): Promise<T> {
  const procedure = procedures.find((each) => each.path.join(".") === path);
  if (procedure === undefined) throw new Error(`no procedure ${path}`);
  const parsed = (procedure.input as unknown as { parse(value: unknown): unknown }).parse(input);
  return (await (procedure.handler as unknown as (value: unknown, context: unknown) => Promise<T>)(parsed, {})) as T;
}

const KEY = { kind: "test", repo: "shop", lock: "0123456789abcdef", filter: ".", warm: true, packages: 800, command: "pnpm test" };

describe("the key of a request (H78)", () => {
  it("takes a lease and a suggestion without a key, as from a client of before H78", async () => {
    const store = new Store(":memory:");
    const procedures = resourceProcedures(new Engine({ sampler, store, sessionsDir: "/nowhere" }));
    const lease = await call<Lease>(procedures, "resources.lease", { holder: "shop", job: "pnpm test", amounts: { memory: 512 }, ttlMs: 60_000 });
    expect(lease.state).toBe("granted");
    expect(store.leaseKey(lease.id)).toBeNull();
    expect(await call<Suggestion>(procedures, "resources.suggest", { job: "pnpm test", holder: "shop" })).toMatchObject({ memoryMb: null, rung: "none" });
  });

  it("writes the key of a lease, and gives the rung of a suggestion with a key", async () => {
    const store = new Store(":memory:");
    const engine = new Engine({ sampler, store, sessionsDir: "/nowhere" });
    const procedures = resourceProcedures(engine);
    const lease = await call<Lease>(procedures, "resources.lease", { holder: "shop", job: "h1-test", amounts: { memory: 512 }, ttlMs: 60_000, key: KEY });
    expect(store.leaseKey(lease.id)).toEqual(KEY);
    engine.release(lease.id, "the job ended", 600, undefined, { code: 0, signal: null });
    expect(await call<Suggestion>(procedures, "resources.suggest", { job: "h2-test", holder: "shop", key: KEY })).toMatchObject({ rung: "key", runs: 1, peakMb: 600 });
    expect(await call<Suggestion>(procedures, "resources.suggest", { job: "h2-test", holder: "shop", key: null })).toMatchObject({ rung: "none" });
  });

  it("refuses a key with a kind that it does not know or a lock that is no hash", async () => {
    const procedures = resourceProcedures(new Engine({ sampler, store: new Store(":memory:"), sessionsDir: "/nowhere" }));
    const base = { holder: "shop", job: "x", amounts: {}, ttlMs: 60_000 };
    await expect(call(procedures, "resources.lease", { ...base, key: { ...KEY, kind: "deploy" } })).rejects.toThrow();
    await expect(call(procedures, "resources.lease", { ...base, key: { ...KEY, lock: "not-a-hash" } })).rejects.toThrow();
  });
});

describe("the folder of a request (H62)", () => {
  it("keeps the folder of the job in the lease and in the store, and refuses an empty folder", async () => {
    const store = new Store(":memory:");
    const procedures = resourceProcedures(new Engine({ sampler, store, sessionsDir: "/nowhere" }));
    const base = { holder: "shop", job: "share-stack", amounts: { memory: 512 }, ttlMs: 60_000 };
    const lease = await call<Lease>(procedures, "resources.lease", { ...base, folder: "D:/work/Shop" });
    expect(lease.folder).toBe("D:/work/Shop");
    expect(store.lease(lease.id)?.folder).toBe("D:/work/Shop");
    // A client of before H62 sends no folder.
    expect(await call<Lease>(procedures, "resources.lease", base)).not.toHaveProperty("folder");
    await expect(call(procedures, "resources.lease", { ...base, folder: "" })).rejects.toThrow();
  });
});
