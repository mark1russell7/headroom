import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walk, Walker } from "./disk-walk.ts";

describe("the walk of the disk report (H21)", () => {
  let base = "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "headroom-walk-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("sizes the files of a folder and its sub-folders", async () => {
    const root = join(base, "root");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "one.bin"), Buffer.alloc(1000));
    writeFileSync(join(root, "a", "two.bin"), Buffer.alloc(2000));
    writeFileSync(join(root, "a", "b", "three.bin"), Buffer.alloc(3000));
    const result = await walk(root, { deadline: Number.POSITIVE_INFINITY });
    expect(result).toMatchObject({ exists: true, bytes: 6000, files: 3, folders: 3, links: 0, errors: 0, partial: false, oneLinkBytes: 6000 });
    expect(result.newestMs).toBeGreaterThan(0);
  });

  it("sizes one file, and gives nothing for a path that does not exist", async () => {
    writeFileSync(join(base, "image.vhdx"), Buffer.alloc(4096));
    expect(await walk(join(base, "image.vhdx"), { deadline: Number.POSITIVE_INFINITY })).toMatchObject({ exists: true, bytes: 4096, files: 1, partial: false });
    expect(await walk(join(base, "absent"), { deadline: Number.POSITIVE_INFINITY })).toMatchObject({ exists: false, bytes: 0, partial: false });
  });

  it("does not follow a junction, so it counts no file two times and makes no loop", async () => {
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "big.bin"), Buffer.alloc(50_000));
    writeFileSync(join(root, "small.bin"), Buffer.alloc(10));
    symlinkSync(outside, join(root, "to-outside"), "junction");
    // A junction to its own parent makes a loop for a walk that follows links.
    symlinkSync(root, join(root, "loop"), "junction");
    const result = await walk(root, { deadline: Number.POSITIVE_INFINITY });
    expect(result).toMatchObject({ bytes: 10, files: 1, links: 2, partial: false });
    // A root that is a junction is not walked.
    expect(await walk(join(root, "to-outside"), { deadline: Number.POSITIVE_INFINITY })).toMatchObject({ exists: false, bytes: 0, links: 1 });
  });

  it("counts a file with two hard links one time for the walks that share the seen set", async () => {
    const first = join(base, "first");
    const second = join(base, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, "shared.bin"), Buffer.alloc(5000));
    linkSync(join(first, "shared.bin"), join(second, "shared.bin"));
    writeFileSync(join(second, "own.bin"), Buffer.alloc(100));
    const seen = new Set<string>();
    const a = await walk(first, { deadline: Number.POSITIVE_INFINITY, seen });
    const b = await walk(second, { deadline: Number.POSITIVE_INFINITY, seen });
    expect(a.bytes + b.bytes).toBe(5100);
    expect(a.oneLinkBytes + b.oneLinkBytes).toBe(100);
  });

  it("stops at the deadline with a partial result, and a walker continues from the same entry", async () => {
    const root = join(base, "root");
    mkdirSync(join(root, "sub"), { recursive: true });
    for (let index = 0; index < 40; index++) writeFileSync(join(root, `f${index}.bin`), Buffer.alloc(100));
    for (let index = 0; index < 40; index++) writeFileSync(join(root, "sub", `g${index}.bin`), Buffer.alloc(10));
    let tick = 0;
    const now = (): number => tick++;
    // The deadline comes in the middle of the first folder.
    const stopped = await walk(root, { deadline: 15, now, parallel: 1 });
    expect(stopped.partial).toBe(true);
    expect(stopped.files).toBeLessThan(80);

    tick = 0;
    const walker = new Walker(root, { now, parallel: 1 });
    const first = await walker.run(15);
    expect(first.partial).toBe(true);
    expect(walker.done).toBe(false);
    const second = await walker.run(Number.POSITIVE_INFINITY);
    await walker.close();
    expect(second).toMatchObject({ partial: false, files: 80, bytes: 4400 });
  });

  it("keeps the size of each folder to the depth of the options", async () => {
    const root = join(base, "root");
    mkdirSync(join(root, "a", "b", "c", "d"), { recursive: true });
    writeFileSync(join(root, "a", "b", "c", "d", "deep.bin"), Buffer.alloc(700));
    writeFileSync(join(root, "a", "top.bin"), Buffer.alloc(300));
    const result = await walk(root, { deadline: Number.POSITIVE_INFINITY, depth: 3 });
    expect(result.folderBytes.get(join(root, "a"))).toBe(1000);
    expect(result.folderBytes.get(join(root, "a", "b"))).toBe(700);
    expect(result.folderBytes.get(join(root, "a", "b", "c"))).toBe(700);
    expect(result.folderBytes.has(join(root, "a", "b", "c", "d"))).toBe(false);
  });
});
