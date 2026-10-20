import { describe, expect, it } from "vitest";
import { autoSlots } from "./slots.ts";

describe("autoSlots", () => {
  it("gives the browser slot to browser tests", () => {
    expect(autoSlots("npx playwright test e2e/a.spec.ts")).toEqual(["browser"]);
    expect(autoSlots("node scripts/gate.mjs e2e --skip-build --lanes svelte-chromium")).toEqual(["browser"]);
    expect(autoSlots("pnpm run test:e2e")).toEqual(["browser"]);
    expect(autoSlots("npx cypress run")).toEqual(["browser"]);
  });

  it("gives no slot to other jobs", () => {
    expect(autoSlots("pnpm test")).toEqual([]);
    expect(autoSlots("jarvis gate")).toEqual([]);
    expect(autoSlots("pnpm exec tsc -b")).toEqual([]);
  });
});
