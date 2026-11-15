import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linuxSampler } from "./linux.ts";

/** The start of the computer in the fixture: `btime` in seconds. */
const BOOT_S = 1_761_300_000;

/** This function gives a line of `/proc/<pid>/stat` with a state and a start in clock ticks (the field 22). */
function statLine(pid: number, name: string, state: string, startTicks: number): string {
  // The fields 3 to 21: the state, the parent, 9 numbers, the user time (14), the kernel time (15) and 6 numbers.
  const middle = [state, "1", "0", "0", "0", "-1", "0", "0", "0", "0", "0", "100", "200", "0", "0", "20", "0", "1", "0"];
  return `${pid} (${name}) ${middle.join(" ")} ${startTicks} 1000 200\n`;
}

describe("the Linux sampler with a fixture of /proc", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "headroom-proc-"));
    writeFileSync(join(root, "stat"), `cpu  1 2 3\nbtime ${BOOT_S}\nprocesses 99\n`);
    for (const [pid, name, state, ticks] of [
      [4242, "grep", "R", 360_000],
      [4343, "sort", "Z", 360_500],
    ] as const) {
      mkdirSync(join(root, String(pid)));
      writeFileSync(join(root, String(pid), "stat"), statLine(pid, name, state, ticks));
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the start of a live process from the field 22 and the start of the computer (H183)", () => {
    const sampler = linuxSampler(root, root);
    expect(sampler.processStart?.(4242)).toBe(BOOT_S * 1000 + 3_600_000);
  });

  it("gives no start for an ended process, a zombie, or a computer with no start", () => {
    const sampler = linuxSampler(root, root);
    expect(sampler.processStart?.(9999)).toBeUndefined();
    // A zombie ended. Only its parent did not read its exit yet.
    expect(sampler.processStart?.(4343)).toBeUndefined();
    writeFileSync(join(root, "stat"), "cpu  1 2 3\n");
    expect(sampler.processStart?.(4242)).toBeUndefined();
  });

  it("gives unknown when the read of the standard output fails, so the caveat of the writer test stays (H183)", () => {
    const sampler = linuxSampler(root, root);
    // No folder fd: the process ended, or it belongs to another user.
    expect(sampler.stdoutKind?.(4242)).toBe("unknown");
    // fd/1 is not a link, so readlink fails.
    mkdirSync(join(root, "4242", "fd"));
    writeFileSync(join(root, "4242", "fd", "1"), "");
    expect(sampler.stdoutKind?.(4242)).toBe("unknown");
  });
});
