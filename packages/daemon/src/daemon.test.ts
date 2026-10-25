import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileLog } from "./daemon.ts";

describe("fileLog", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "headroom-log-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("moves a full file to <file>.1", () => {
    const path = join(dir, "daemon.log");
    const log = fileLog(path, 120);
    log("one ".repeat(10));
    log("two ".repeat(10));
    expect(readFileSync(`${path}.1`, "utf8")).toContain("one");
    expect(readFileSync(path, "utf8")).toContain("two");
  });

  it("continues to write after another process removed the file", () => {
    const path = join(dir, "daemon.log");
    // Each line has a time of 24 characters. The second line is past the limit, and the third line is not.
    const log = fileLog(path, 130);
    log("first ".repeat(10));
    rmSync(path);
    log("second ".repeat(10));
    log("third");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("second");
    expect(text).toContain("third");
  });
});
