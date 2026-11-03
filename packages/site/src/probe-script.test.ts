import { describe, expect, it } from "vitest";
import { readProbe } from "./probe-script.ts";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;

describe("the script of the site probe", () => {
  const script = readProbe();

  it("has no types and no export", () => {
    expect(script).not.toMatch(/^export /m);
    expect(script).not.toMatch(/declare const/);
    expect(script).not.toMatch(/: Element\[\]/);
  });

  it("is the body of an async function with the helpers of the site check", () => {
    expect(() => new AsyncFunction("check", "until", "$", "$$", "click", script)).not.toThrow();
  });

  it("makes checks of the core of the simulator", () => {
    expect(script.match(/\bcheck\(/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(script).toContain("browsers can fail to start beside it");
  });
});
