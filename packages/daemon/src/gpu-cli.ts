/**
 * The `headroom gpu [--json]` command (H36): each GPU adapter with its memory, its limits, its engine use and its owners. It
 * also gives the GPU memory of each leased job.
 *
 * Shared GPU memory is in the RAM. The available memory and the commit charge already count it, so the memory of headroom
 * does not subtract it again. The command tells this in its last line.
 */

import { parseArgs } from "node:util";
import { diskSize, leaseGpuText, type EngineUse, type GpuAdapterStatus, type GpuStatus, type Lease } from "@headroom/core";
import type { Connection } from "./client.ts";
import type { DaemonStatus } from "./procedures.ts";

export const GPU_USAGE = "headroom gpu [--json]";

/** The outputs of the command. The tests replace them. */
export interface GpuOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const CONSOLE: GpuOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };

/** This function writes an amount in MB as GB with one decimal: "17.8 GB". */
const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;

/** The names of the families of engines, in the order of Task Manager. */
const FAMILIES: readonly [keyof EngineUse, string][] = [["3d", "3D"], ["compute", "compute"], ["copy", "copy"], ["video", "video"], ["other", "other"]];

/** This function writes the use of the engines: "34% (3D 30%, video 10%)", or "0%". */
function busyText(busy: number | null, engines: EngineUse): string {
  if (busy === null) return "no read yet (the use needs two reads)";
  const parts = FAMILIES.flatMap(([family, name]) => {
    const value = engines[family];
    return value === undefined ? [] : [`${name} ${Math.round(value)}%`];
  });
  return `${Math.round(busy)}%${parts.length === 0 ? "" : ` (${parts.join(", ")})`}`;
}

/** This function writes the lines of one adapter. */
function adapterLines(adapter: GpuAdapterStatus): string[] {
  const dedicated = adapter.dedicatedLimitMb === null ? diskSize(adapter.dedicatedMb) : `${diskSize(adapter.dedicatedMb)} of ${diskSize(adapter.dedicatedLimitMb)}`;
  const limits =
    adapter.limitsFrom === "dxgi"
      ? `Limits from DXGI.${adapter.budgetMb === null ? "" : ` The DXGI budget of one process is ${gb(adapter.budgetMb)}.`}`
      : "DXGI does not list this adapter, for example an NPU. Its shared limit is half of the RAM, the default of Windows.";
  const lines = [
    `${adapter.id}  ${adapter.name}`,
    `  Memory: ${gb(adapter.usedMb)} of ${gb(adapter.capacityMb)}, ${gb(adapter.freeMb)} free. Dedicated ${dedicated}. Shared ${diskSize(adapter.sharedMb)} of ${diskSize(adapter.sharedLimitMb)}, in RAM.`,
    `  Busy: ${busyText(adapter.busyPercent, adapter.engines)}.`,
    `  ${limits}`,
  ];
  if (adapter.owners.length === 0) return [...lines, "  No owner has GPU memory on this adapter."];
  lines.push(`  ${"OWNER".padEnd(28)} ${"PROCESS".padEnd(22)} ${"MEMORY".padStart(9)} ${"SHARED".padStart(9)} ${"BUSY".padStart(5)}`);
  for (const owner of adapter.owners) {
    lines.push(
      `  ${owner.owner.slice(0, 28).padEnd(28)} ${(owner.top ?? "-").slice(0, 22).padEnd(22)} ${diskSize(owner.mb).padStart(9)} ${diskSize(owner.sharedMb).padStart(9)} ${`${Math.round(owner.busyPercent)}%`.padStart(5)}`,
    );
  }
  return lines;
}

/** This function gives the lines of the command for the GPU of a status and its leases. */
export function gpuLinesOf(gpu: GpuStatus | null | undefined, leases: readonly Lease[]): string[] {
  if (gpu === null || gpu === undefined) return ["No GPU read. Linux, a computer with no GPU counters and a daemon of an older version give none."];
  const lines: string[] = [];
  for (const adapter of gpu.adapters) lines.push(...adapterLines(adapter), "");
  const leased = leases.flatMap((lease) => {
    const text = leaseGpuText(lease, gpu);
    return text === null ? [] : [`  ${lease.id.slice(0, 8)} ${lease.holder.slice(0, 14).padEnd(14)} ${lease.job.slice(0, 40).padEnd(40)} ${text}`];
  });
  lines.push(leased.length === 0 ? "No leased job has GPU memory." : "Leased jobs with GPU memory:", ...leased);
  lines.push("", "Shared GPU memory is in the RAM. The available memory and the commit charge already count it, so headroom does not subtract it again.");
  return lines;
}

/** This function gives the output of `headroom gpu [--json]`, and its exit code. */
export async function gpuCommand(argv: readonly string[], connection: Connection | null, output: GpuOutput = CONSOLE): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { json: { type: "boolean" } } });
  if (connection === null) {
    output.err("headroom does not run.");
    return 1;
  }
  const status = await connection.call<DaemonStatus>(["resources", "status"], {});
  if (values.json) output.out(JSON.stringify(status.gpu ?? null, null, 2));
  else for (const line of gpuLinesOf(status.gpu, status.leases)) output.out(line);
  return 0;
}
