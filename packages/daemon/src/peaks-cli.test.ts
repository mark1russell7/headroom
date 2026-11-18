import type { PeaksAnswer, PeakSummary } from "@headroom/core";
import { describe, expect, it } from "vitest";
import type { Connection } from "./client.ts";
import { peaksCommand, peaksLinesOf } from "./peaks-cli.ts";

const AT = Date.UTC(2026, 10, 18, 18, 42);
const summary = (fields: Partial<PeakSummary>): PeakSummary => ({
  kind: "process", key: "4120:1763491200000", name: "node.exe", owner: "shop", pid: 4120, created: 1763491200000, lease: null, peakMb: 1900,
  command: null, at: AT, firstAt: AT, lastAt: AT, minutes: 1, ...fields,
});
const ANSWER: PeaksAnswer = {
  minMb: 512,
  limit: 30,
  peaks: [
    summary({ kind: "container", key: "9f2c41ab77e0d3c5", name: "share-mongo-1", pid: null, created: null, lease: "0966fe4b-8759", peakMb: 3380, command: "mongo:7", minutes: 12 }),
    summary({ command: "node build.js --watch" }),
  ],
};

/** This function gives a connection that answers each call with an answer, and keeps the calls. */
function connectionOf(answer: PeaksAnswer, calls: unknown[][]): Connection {
  return { call: async (...args: unknown[]) => (calls.push(args), answer) } as unknown as Connection;
}

describe("headroom peaks (H62 part 5)", () => {
  it("writes each holder with its peak, its minute, its owner, its lease and its command", () => {
    const lines = peaksLinesOf(ANSWER, 60);
    expect(lines[0]).toBe("The memory peaks of the last 60 minutes: each process and container of 512 MB or more, at most 30 in a minute. Times in UTC.");
    expect(lines[2]).toMatch(/^ +3\.3 GB {2}18:42 {2}container {2}share-mongo-1 +shop +0966fe4b +12 {2}9f2c41ab77e0$/);
    expect(lines[3]).toBe("            mongo:7");
    expect(lines[4]).toMatch(/^ +1\.9 GB {2}18:42 {2}process {4}node\.exe +shop +- +1 {2}4120:1763491200000$/);
    expect(lines[5]).toBe("            node build.js --watch");
    expect(lines.at(-1)).toContain("The rows are peaks, not a sum.");
  });

  it("writes the minutes of one holder, and a window with no holder", () => {
    const trail = { ...ANSWER, trail: [{ at: AT, peakMb: 700, lease: null }, { at: AT + 60_000, peakMb: 1900, lease: "0966fe4b-8759" }] };
    const lines = peaksLinesOf(trail, 1, "process", "4120:1763491200000");
    expect(lines[0]).toContain("of the last 1 minute:");
    expect(lines).toEqual(expect.arrayContaining(["The minutes of the process 4120:1763491200000:", "  18:42    700 MB", "  18:43    1.9 GB  lease 0966fe4b"]));
    expect(peaksLinesOf({ minMb: 512, limit: 30, peaks: [] }, 60, "container", "x")).toEqual(
      expect.arrayContaining(["No large process or container in the window.", "No minute of the container x in the window."]),
    );
  });

  it("sends the options to the procedure, and refuses a bad option before the call", async () => {
    const calls: unknown[][] = [];
    const out: string[] = [];
    const err: string[] = [];
    const output = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) };
    expect(await peaksCommand(["--minutes", "120", "--min", "1g", "--lease", "l1", "--key", "abc", "--container", "--json"], connectionOf(ANSWER, calls), output)).toBe(0);
    expect(calls).toEqual([[["resources", "peaks"], { minutes: 120, minMb: 1024, limit: 30, kind: "container", lease: "l1", key: "abc" }]]);
    expect(JSON.parse(out.join("\n"))).toEqual(ANSWER);
    expect(await peaksCommand(["--minutes", "0"], connectionOf(ANSWER, calls), output)).toBe(1);
    expect(await peaksCommand(["--min", "lots"], connectionOf(ANSWER, calls), output)).toBe(1);
    expect(await peaksCommand([], null, output)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(err).toEqual([expect.stringContaining("--minutes is 1 to 10080"), expect.stringContaining("Not a memory amount: lots"), "headroom does not run."]);
  });
});
