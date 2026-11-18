import type { History, MemoryRow } from "@headroom/core";
import { describe, expect, it } from "vitest";
import type { Connection } from "./client.ts";
import { historyWindow, memoryCommand, memoryLines, type MemorySamples } from "./history-cli.ts";

const NOW = Date.UTC(2026, 10, 18, 5, 0, 30);
const MINUTE = 60_000;

function sample(at: number, availableMb: number): MemoryRow {
  return { at, totalMb: 28_310, availableMb, commitMb: 41_984, commitLimitMb: 56_934, kernelPagedMb: 2400, kernelNonpagedMb: 610, processes: 900, userObjects: null, gdiObjects: null };
}

const HISTORY: History = {
  memory: [sample(NOW - 2 * MINUTE, 5324.8), sample(NOW - MINUTE, 4096)],
  owners: [],
  leases: [],
  resources: {},
  sleeps: [],
};

function capture(): { readonly lines: string[]; readonly errors: string[]; readonly out: (text: string) => void; readonly err: (text: string) => void } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (text) => lines.push(text), err: (text) => errors.push(text) };
}

function connectionOf(history: History, calls: unknown[][] = []): Connection {
  return {
    endpoint: "http://127.0.0.1:1",
    call: async <T,>(path: readonly string[], input: unknown): Promise<T> => {
      calls.push([path, input]);
      return history as T;
    },
  };
}

describe("the window of the history commands (H201)", () => {
  it("gives the last 60 minutes by default, and a start, an end and a step from the options", () => {
    expect(historyWindow({}, NOW)).toEqual({ since: NOW - 60 * MINUTE, step: 1 });
    expect(historyWindow({ minutes: "30", step: "5" }, NOW)).toEqual({ since: NOW - 30 * MINUTE, step: 5 });
    expect(historyWindow({ since: "2026-11-18T04:00Z", until: "2026-11-18T04:30Z" }, NOW)).toEqual({
      since: Date.UTC(2026, 10, 18, 4),
      until: Date.UTC(2026, 10, 18, 4, 30),
      step: 1,
    });
    // --minutes counts back from the end, when the window has one.
    expect(historyWindow({ minutes: "10", until: "2026-11-18T04:30Z" }, NOW)).toMatchObject({ since: Date.UTC(2026, 10, 18, 4, 20) });
  });

  it("gives the text of the error for a wrong option", () => {
    expect(historyWindow({ minutes: "0" }, NOW)).toBe('--minutes takes a whole number from 1 to 10080, not "0".');
    expect(historyWindow({ step: "1.5" }, NOW)).toBe('--step takes a whole number from 1 to 1440, not "1.5".');
    expect(historyWindow({ since: "yesterday" }, NOW)).toBe('--since takes a time such as 2026-11-18T04:00Z, not "yesterday".');
    expect(historyWindow({ minutes: "5", since: "2026-11-18T04:00Z" }, NOW)).toBe("--minutes and --since both give the start. Give only one of them.");
    expect(historyWindow({ since: "2026-11-18T04:00Z", until: "2026-11-18T04:00Z" }, NOW)).toBe("The start 2026-11-18T04:00:00.000Z is not before the end 2026-11-18T04:00:00.000Z.");
  });
});

describe("headroom memory (H201)", () => {
  it("asks the daemon for the memory and the sleeps of the window, and gives the samples as JSON", async () => {
    const calls: unknown[][] = [];
    const output = capture();
    expect(await memoryCommand(["--since", "2026-11-18T04:00Z", "--json"], connectionOf(HISTORY, calls), output, () => NOW)).toBe(0);
    expect(calls).toEqual([[["resources", "history"], { since: Date.UTC(2026, 10, 18, 4), step: 1, parts: ["memory", "sleeps"] }]]);
    const report = JSON.parse(output.lines.join("\n")) as MemorySamples;
    expect(report).toEqual({ since: Date.UTC(2026, 10, 18, 4), until: null, step: 1, samples: HISTORY.memory, sleeps: [] });
    // The fields that a script of the lift test reads.
    expect(report.samples[0]).toMatchObject({ at: NOW - 2 * MINUTE, availableMb: 5324.8, commitMb: 41_984, commitLimitMb: 56_934 });
  });

  it("writes one line for each sample, and each sleep", () => {
    const report: MemorySamples = { since: NOW - 60 * MINUTE, until: null, step: 1, samples: HISTORY.memory, sleeps: [[NOW - 30 * MINUTE, NOW - 20 * MINUTE]] };
    expect(memoryLines(report, NOW)).toEqual([
      "The memory samples from 2026-11-18 04:00 to now UTC (2 samples of 1 minute):",
      "  04:58  available   5.2 GB  committed  41.0 GB of 55.6 GB",
      "  04:59  available   4.0 GB  committed  41.0 GB of 55.6 GB",
      "The computer slept from 04:30 to 04:40 UTC.",
    ]);
    // A window across midnight UTC writes the date of each time, and a step says that each sample is an average.
    const long = { ...report, since: NOW - 6 * 60 * MINUTE, until: NOW, step: 5, sleeps: [] };
    expect(memoryLines(long, NOW)[0]).toBe("The memory samples from 2026-11-17 23:00 to 2026-11-18 05:00 UTC (2 samples of 5 minutes, each the average of its samples):");
    expect(memoryLines(long, NOW)[1]).toMatch(/^ {2}11-18 04:58 {2}available/);
    expect(memoryLines({ ...report, samples: [] }, NOW)).toEqual(["No memory sample is in the window from 2026-11-18 04:00 to now UTC."]);
  });

  it("refuses wrong options with exit 2, and says when the daemon does not run or is too old", async () => {
    for (const args of [["--since", "never"], ["--minutes", "5", "--since", "2026-11-18T04:00Z"], ["extra"], ["--nope"]]) {
      const output = capture();
      expect(await memoryCommand(args, connectionOf(HISTORY), output, () => NOW)).toBe(2);
      expect(output.errors.join("\n")).toContain("Usage: headroom memory");
    }
    const down = capture();
    expect(await memoryCommand([], null, down, () => NOW)).toBe(1);
    expect(down.errors).toEqual(["headroom does not run."]);
    // A daemon of before H201 does not read the parts, so it gives the owners too.
    const old = capture();
    const owners = [{ at: NOW, owner: "kernel", kind: "kernel" as const, privateMb: 3000, workingMb: 3000, processes: 0 }];
    expect(await memoryCommand(["--json"], connectionOf({ ...HISTORY, owners }), old, () => NOW)).toBe(1);
    expect(old.errors.join("\n")).toContain("The daemon is older than this command");
    expect(old.lines).toEqual([]);
  });
});
