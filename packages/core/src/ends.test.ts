import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { leaseEndPath, readLeaseEnd, removeLeaseEnd, sweepLeaseEnds, writeLeaseEnd, type LeaseEnd } from "./ends.ts";

const root = mkdtempSync(join(tmpdir(), "headroom-ends-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
/** This function gives a new folder for one case. The folder does not exist yet, so the write must make it. */
const folder = (): string => join(root, `case-${++count}`, "ends");

const END: LeaseEnd = { id: "0d8e16fd-1aa1-42ea-8f00-000000000001", at: 1_763_000_000_000, reason: "the job ended with code 5, peak 120 MB", peakMb: 120, usage: { cpuMs: 30, tempMb: 2 }, exitCode: 5, processes: 4 };

describe("the end records of jobs (H202)", () => {
  it("writes a record that a read gives back, in a folder that the write makes", () => {
    const dir = folder();
    expect(writeLeaseEnd(dir, END)).toBe(true);
    expect(readLeaseEnd(dir, END.id)).toEqual(END);
    expect(readdirSync(dir)).toEqual([`${END.id}.json`]);
  });

  it("keeps the signal of a job that a signal stopped", () => {
    const dir = folder();
    const end: LeaseEnd = { id: "a1", at: 5, reason: "the job ended with signal SIGTERM", signal: "SIGTERM" };
    writeLeaseEnd(dir, end);
    expect(readLeaseEnd(dir, "a1")).toEqual(end);
  });

  it("refuses an ID that can name a file outside the folder", () => {
    const dir = folder();
    for (const id of ["../x", "a/b", "a\\b", "", "a.json", "x".repeat(65)]) {
      expect(leaseEndPath(dir, id)).toBeNull();
      expect(writeLeaseEnd(dir, { ...END, id })).toBe(false);
      expect(readLeaseEnd(dir, id)).toBeNull();
    }
    expect(existsSync(dir)).toBe(false);
  });

  it("gives null for no file, for a file that is not JSON, and for the record of another lease", () => {
    const dir = folder();
    expect(readLeaseEnd(dir, "absent")).toBeNull();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "half.json"), '{"id":"half","at":');
    expect(readLeaseEnd(dir, "half")).toBeNull();
    writeFileSync(join(dir, "mine.json"), JSON.stringify({ ...END, id: "other" }));
    expect(readLeaseEnd(dir, "mine")).toBeNull();
    writeFileSync(join(dir, "late.json"), JSON.stringify({ id: "late", at: "soon", reason: "x" }));
    expect(readLeaseEnd(dir, "late")).toBeNull();
  });

  it("drops each field that has the wrong type, and keeps the rest of the record", () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "odd.json"), JSON.stringify({ id: "odd", at: 7, reason: "r", exitCode: 1.5, signal: 9, peakMb: "big", usage: { cpuMs: "x" }, processes: -1 }));
    expect(readLeaseEnd(dir, "odd")).toEqual({ id: "odd", at: 7, reason: "r" });
  });

  it("removes a record, and a removal of no record is no error", () => {
    const dir = folder();
    writeLeaseEnd(dir, END);
    removeLeaseEnd(dir, END.id);
    expect(readLeaseEnd(dir, END.id)).toBeNull();
    expect(() => removeLeaseEnd(dir, END.id)).not.toThrow();
    expect(() => removeLeaseEnd(folder(), "a")).not.toThrow();
  });

  it("sweeps the records of ended leases and the temporary files of stopped writes, and keeps the rest", () => {
    const dir = folder();
    writeLeaseEnd(dir, { ...END, id: "ended" });
    writeLeaseEnd(dir, { ...END, id: "active" });
    writeFileSync(join(dir, "stopped.json.1.tmp"), "{");
    writeFileSync(join(dir, "writing.json.2.tmp"), "{");
    writeFileSync(join(dir, "notes.txt"), "kept");
    const now = Date.now();
    const old = new Date(now - 120_000);
    utimesSync(join(dir, "stopped.json.1.tmp"), old, old);
    expect(sweepLeaseEnds(dir, (id) => id === "ended", now)).toEqual(["ended"]);
    expect(readdirSync(dir).sort()).toEqual(["active.json", "notes.txt", "writing.json.2.tmp"]);
  });

  it("sweeps nothing in a folder that does not exist", () => {
    expect(sweepLeaseEnds(folder(), () => true)).toEqual([]);
  });
});
