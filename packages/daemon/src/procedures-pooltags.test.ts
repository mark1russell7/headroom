import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, Store, type PoolTag, type PoolTags, type Sampler } from "@headroom/core";
import { afterEach, describe, expect, it } from "vitest";
import { resourceProcedures } from "./procedures.ts";

describe("the procedure resources.pooltags (H53)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads back past the hour of the engine through the schema, in both pools", async () => {
    let now = 10_000_000;
    let tags: PoolTag[] = [
      { tag: "File", nonPagedMb: 100, pagedMb: 0 },
      { tag: "FMfn", nonPagedMb: 0, pagedMb: 200 },
    ];
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 700 }),
      processes: () => [],
      poolTags: () => tags,
      close: () => undefined,
    };
    const dir = mkdtempSync(join(tmpdir(), "headroom-pooltags-"));
    dirs.push(dir);
    const engine = new Engine({ sampler, store: new Store(join(dir, "tags.db")), now: () => now, sessionsDir: "/nowhere" });
    engine.tick();
    now += 3 * 3_600_000;
    tags = [
      { tag: "File", nonPagedMb: 340, pagedMb: 0 },
      { tag: "FMfn", nonPagedMb: 0, pagedMb: 500 },
    ];
    engine.tick();

    const procedure = resourceProcedures(engine).find((each) => each.path.join(".") === "resources.pooltags");
    if (procedure === undefined) throw new Error("no procedure resources.pooltags");
    const call = async (input: unknown): Promise<PoolTags> => {
      const parsed = (procedure.input as unknown as { parse(value: unknown): unknown }).parse(input);
      return (await (procedure.handler as unknown as (value: unknown, context: unknown) => Promise<PoolTags>)(parsed, {})) as PoolTags;
    };

    // Without a time, the window is the last hour: the first snapshot has left it.
    expect((await call({})).sinceAt).toBe(now);

    const sinceBoot = await call({ since: 0 });
    expect(sinceBoot.sinceAt).toBe(10_000_000);
    expect(sinceBoot.largest.map((row) => [row.tag, row.growthMb])).toEqual([
      ["File", 240],
      ["FMfn", 0],
    ]);
    expect(sinceBoot.largestPaged.map((row) => [row.tag, row.pagedMb, row.growthMb])).toEqual([
      ["FMfn", 500, 300],
      ["File", 0, 0],
    ]);
    engine.close();
  });
});
