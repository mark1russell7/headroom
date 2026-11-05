import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, Store, type Config, type Sampler } from "@headroom/core";
import type { AnyProcedure } from "@procedures/client";
import { afterEach, describe, expect, it } from "vitest";
import { resourceProcedures } from "./procedures.ts";

const sampler: Sampler = {
  memory: () => ({ totalMb: 28_000, availableMb: 3000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
  processes: () => [],
  close: () => undefined,
};

/** The path of a setting through the daemon: the schema of the procedure, and then the engine. */
async function configSet(procedures: readonly AnyProcedure[], input: unknown): Promise<Config> {
  const procedure = procedures.find((each) => each.path.join(".") === "config.set");
  if (procedure === undefined) throw new Error("no procedure config.set");
  const parsed = (procedure.input as unknown as { parse(value: unknown): unknown }).parse(input);
  return (await (procedure.handler as unknown as (value: unknown, context: unknown) => Promise<Config>)(parsed, {})) as Config;
}

describe("the procedure config.set", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function engine(): Engine {
    const dir = mkdtempSync(join(tmpdir(), "headroom-config-"));
    dirs.push(dir);
    return new Engine({ sampler, store: new Store(join(dir, "config.db")), sessionsDir: "/nowhere" });
  }

  it("carries the memory reserve to the engine (H60)", async () => {
    const each = engine();
    const procedures = resourceProcedures(each);
    expect((await configSet(procedures, { memoryReserveMb: 2048 })).memoryReserveMb).toBe(2048);
    expect(each.status()).toMatchObject({ reserveMb: 2048 });
    expect((await configSet(procedures, { memoryReserveMb: null })).memoryReserveMb).toBe(1024);
    each.close();
  });

  it("refuses a setting that it does not know, so that a setting is not dropped with no error", async () => {
    const each = engine();
    await expect(configSet(resourceProcedures(each), { noSuchSetting: 1 })).rejects.toThrow();
    each.close();
  });
});
