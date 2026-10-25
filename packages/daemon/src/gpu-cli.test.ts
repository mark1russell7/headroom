import type { GpuStatus, Lease } from "@headroom/core";
import { describe, expect, it } from "vitest";
import { gpuCommand, gpuLinesOf } from "./gpu-cli.ts";
import type { Connection } from "./client.ts";

const GPU: GpuStatus = {
  adapters: [
    {
      id: "gpu:0",
      name: "AMD Radeon(TM) 860M Graphics",
      luid: "0x00000000_0x0001665f",
      dedicatedMb: 1024,
      sharedMb: 300,
      usedMb: 1324,
      capacityMb: 18_251,
      freeMb: 16_927,
      dedicatedLimitMb: 4096,
      sharedLimitMb: 14_155,
      budgetMb: 17_430,
      limitsFrom: "dxgi",
      busyPercent: 40,
      engines: { "3d": 35, video: 40 },
      owners: [{ owner: "session:graph", kind: "session", mb: 561, dedicatedMb: 523, sharedMb: 38, busyPercent: 40, processes: 2, top: "Code.exe" }],
    },
    {
      id: "gpu:2",
      name: "adapter 0x0001dfbe",
      luid: "0x00000000_0x0001dfbe",
      dedicatedMb: 0,
      sharedMb: 620,
      usedMb: 620,
      capacityMb: 14_155,
      freeMb: 13_535,
      dedicatedLimitMb: null,
      sharedLimitMb: 14_155,
      budgetMb: null,
      limitsFrom: "default",
      busyPercent: null,
      engines: {},
      owners: [],
    },
  ],
  leases: { "3f2a9c1e-0000": 150 },
};

const LEASE = { id: "3f2a9c1e-0000", holder: "graph", job: "playwright test", peakGpuMb: 400 } as Lease;

describe("headroom gpu (H36)", () => {
  it("writes each adapter, its owners, the leased jobs and the memory rule", () => {
    const lines = gpuLinesOf(GPU, [LEASE]);
    expect(lines).toContain("gpu:0  AMD Radeon(TM) 860M Graphics");
    expect(lines).toContain("  Memory: 1.3 GB of 17.8 GB, 16.5 GB free. Dedicated 1 GB of 4 GB. Shared 300 MB of 13.8 GB, in RAM.");
    expect(lines).toContain("  Busy: 40% (3D 35%, video 40%).");
    expect(lines).toContain("  Limits from DXGI. The DXGI budget of one process is 17.0 GB.");
    expect(lines.some((line) => line.includes("session:graph") && line.includes("Code.exe") && line.includes("561 MB"))).toBe(true);
    expect(lines).toContain("  Busy: no read yet (the use needs two reads).");
    expect(lines).toContain("  No owner has GPU memory on this adapter.");
    expect(lines.some((line) => line.includes("playwright test") && line.endsWith("GPU 150 MB, peak 400 MB"))).toBe(true);
    expect(lines.at(-1)).toContain("headroom does not subtract it again");
  });

  it("tells when the daemon gives no GPU, and gives the JSON of the status", async () => {
    expect(gpuLinesOf(undefined, [])[0]).toMatch(/^No GPU read\./);
    const out: string[] = [];
    const connection = { call: async () => ({ gpu: GPU, leases: [] }) } as unknown as Connection;
    expect(await gpuCommand(["--json"], connection, { out: (text) => out.push(text), err: () => undefined })).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual(GPU);
    expect(await gpuCommand([], null, { out: () => undefined, err: () => undefined })).toBe(1);
  });
});
