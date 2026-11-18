/**
 * The `headroom peaks` command (H62 part 5): the memory peaks of the large processes and containers of the last minutes.
 * Each read of the processes gives the private memory of each large holder. The minute sample keeps the largest amount
 * of each holder in the minute. The command gives each holder with its largest minute, the largest first.
 *
 * The memory of a container is in the VM of Docker, so the VM process is also a large process. The rows are peaks, not a sum.
 */

import { parseArgs } from "node:util";
import { diskSize, type PeakKind, type PeakPoint, type PeaksAnswer, type PeakSummary } from "@headroom/core";
import type { Connection } from "./client.ts";
import { parseMemory } from "./parse.ts";

export const PEAKS_USAGE = "headroom peaks [--minutes <n>] [--min <amount>] [--lease <id>] [--key <key> [--container]] [--limit <n>] [--json]";

/** The outputs of the command. The tests replace them. */
export interface PeaksOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const CONSOLE: PeaksOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };

/** This function writes the hour and the minute of a time in UTC: "18:42". */
const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);

/** This function writes the length of a window of minutes: "60 minutes", "1 minute". */
const minutesText = (minutes: number): string => `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;

/** This function writes the line of one holder, and the line of its command when it has one. */
function holderLines(peak: PeakSummary): string[] {
  const lease = peak.lease === null ? "-" : peak.lease.slice(0, 8);
  const key = peak.kind === "container" ? peak.key.slice(0, 12) : peak.key;
  const line = `  ${diskSize(peak.peakMb).padStart(8)}  ${clock(peak.at)}  ${peak.kind.padEnd(9)}  ${peak.name.slice(0, 24).padEnd(24)}  ${(peak.owner ?? "-").slice(0, 18).padEnd(18)}  ${lease.padEnd(8)}  ${String(peak.minutes).padStart(7)}  ${key}`;
  return peak.command === null ? [line] : [line, `            ${peak.command.slice(0, 110)}`];
}

/** This function writes the minutes of one holder. */
function trailLines(kind: PeakKind, key: string, trail: readonly PeakPoint[]): string[] {
  if (trail.length === 0) return [`No minute of the ${kind} ${key} in the window.`];
  return [`The minutes of the ${kind} ${key}:`, ...trail.map((point) => `  ${clock(point.at)}  ${diskSize(point.peakMb).padStart(8)}  ${point.lease === null ? "" : `lease ${point.lease.slice(0, 8)}`}`.trimEnd())];
}

/** This function gives the lines of the command for an answer of a window of `minutes`. */
export function peaksLinesOf(answer: PeaksAnswer, minutes: number, kind: PeakKind = "process", key?: string): string[] {
  const lines = [
    `The memory peaks of the last ${minutesText(minutes)}: each process and container of ${diskSize(answer.minMb)} or more, at most ${answer.limit} in a minute. Times in UTC.`,
  ];
  if (answer.peaks.length === 0) lines.push("No large process or container in the window.");
  else {
    lines.push(`  ${"PEAK".padStart(8)}  ${"AT".padEnd(5)}  ${"KIND".padEnd(9)}  ${"NAME".padEnd(24)}  ${"OWNER".padEnd(18)}  ${"LEASE".padEnd(8)}  ${"MINUTES".padStart(7)}  KEY`);
    for (const peak of answer.peaks) lines.push(...holderLines(peak));
  }
  if (key !== undefined) lines.push("", ...trailLines(kind, key, answer.trail ?? []));
  lines.push("", "A container holds its memory in the VM of Docker, so the VM process is also a large process. The rows are peaks, not a sum.");
  return lines;
}

/** This function gives the output of `headroom peaks`, and its exit code. */
export async function peaksCommand(argv: readonly string[], connection: Connection | null, output: PeaksOutput = CONSOLE): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      minutes: { type: "string" },
      min: { type: "string" },
      lease: { type: "string" },
      key: { type: "string" },
      container: { type: "boolean" },
      limit: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const minutes = Number(values.minutes ?? 60);
  const limit = Number(values.limit ?? 30);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    output.err(`Usage: ${PEAKS_USAGE}. --minutes is 1 to 10080, and --limit is 1 to 500.`);
    return 1;
  }
  let minMb = 0;
  try {
    minMb = values.min === undefined ? 0 : parseMemory(values.min);
  } catch (error) {
    output.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (connection === null) {
    output.err("headroom does not run.");
    return 1;
  }
  const kind: PeakKind = values.container === true ? "container" : "process";
  const answer = await connection.call<PeaksAnswer>(["resources", "peaks"], {
    minutes,
    minMb,
    limit,
    kind,
    ...(values.lease === undefined ? {} : { lease: values.lease }),
    ...(values.key === undefined ? {} : { key: values.key }),
  });
  if (values.json) output.out(JSON.stringify(answer, null, 2));
  else for (const line of peaksLinesOf(answer, minutes, kind, values.key)) output.out(line);
  return 0;
}
