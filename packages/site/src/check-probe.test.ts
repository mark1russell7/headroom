import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The site check of the Pages workflow starts the probe in a browser. This test examines only its source.
const source = readFileSync(new URL("./check-probe.ts", import.meta.url), "utf8");

describe("the source of the site probe", () => {
  it("makes checks of the core of the simulator", () => {
    expect(source.match(/\bcheck\(/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(source).toContain("browsers can fail to start beside it");
  });
});
