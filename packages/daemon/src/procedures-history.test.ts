import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, Store, type History, type Sampler } from "@headroom/core";
import { afterEach, describe, expect, it } from "vitest";
import { resourceProcedures } from "./procedures.ts";

describe("the procedure resources.history (H201)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads a window with a start, an end and the parts, through the schema", async () => {
    let now = 10_000_000;
    let availableMb = 9000;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 700 }),
      processes: () => [],
      close: () => undefined,
    };
    const dir = mkdtempSync(join(tmpdir(), "headroom-history-"));
    dirs.push(dir);
    const engine = new Engine({ sampler, store: new Store(join(dir, "history.db")), now: () => now, sessionsDir: "/nowhere" });
    const first = now;
    engine.tick();
    now += 61_000;
    availableMb = 8000;
    engine.tick();

    const procedure = resourceProcedures(engine).find((each) => each.path.join(".") === "resources.history");
    if (procedure === undefined) throw new Error("no procedure resources.history");
    const call = async (input: unknown): Promise<History> => {
      const parsed = (procedure.input as unknown as { parse(value: unknown): unknown }).parse(input);
      return (await (procedure.handler as unknown as (value: unknown, context: unknown) => Promise<History>)(parsed, {})) as History;
    };

    // The end time is not in the window.
    const window = await call({ since: first, until: now, parts: ["memory"] });
    expect(window.memory.map((row) => [row.at, row.availableMb])).toEqual([[first, 9000]]);
    expect(window.sleeps).toEqual([]);
    // With no end, the window has the samples up to the call.
    expect((await call({ since: first })).memory).toHaveLength(2);
    // --minutes counts back from the end.
    expect((await call({ minutes: 1, until: now + 1 })).memory.map((row) => row.at)).toEqual([now]);
    await expect(call({ since: now, until: now })).rejects.toThrow("The start of the window must be before its end");
    expect(() => (procedure.input as unknown as { parse(value: unknown): unknown }).parse({ parts: ["disks"] })).toThrow();
    engine.close();
  });
});
