import { describe, expect, it } from "vitest";
import { autoSlots } from "./slots.ts";

describe("autoSlots", () => {
  it("gives the browser slot to browser tests", () => {
    expect(autoSlots("npx playwright test e2e/a.spec.ts")).toEqual(["browser"]);
    expect(autoSlots("node scripts/gate.mjs e2e --skip-build --lanes svelte-chromium")).toEqual(["browser"]);
    expect(autoSlots("pnpm run test:e2e")).toEqual(["browser"]);
    expect(autoSlots("npx cypress run")).toEqual(["browser"]);
    expect(autoSlots("node scripts/gate.mjs e2e --skip-build")).toEqual(["browser"]);
    expect(autoSlots("pnpm exec wdio run wdio.conf.ts")).toEqual(["browser"]);
  });

  it("gives no slot to other jobs", () => {
    expect(autoSlots("pnpm test")).toEqual([]);
    expect(autoSlots("assistant gate")).toEqual([]);
    expect(autoSlots("pnpm exec tsc -b")).toEqual([]);
  });

  it("gives no slot for the word e2e of a unit test runner (H55)", () => {
    // The false case of 2026-11-04: this job waited 30 minutes behind a browser job, and timed out with exit 75.
    expect(autoSlots("pnpm exec vitest run src/app/core/board-layout e2e-map")).toEqual([]);
    expect(autoSlots("vitest run e2e")).toEqual([]);
    expect(autoSlots("npx vitest run tests/e2e/helpers.test.ts")).toEqual([]);
    expect(autoSlots("pnpm --filter web exec vitest run e2e-map")).toEqual([]);
    expect(autoSlots("pnpm -C packages/web vitest e2e")).toEqual([]);
    expect(autoSlots("CI=1 node_modules/.bin/vitest run e2e")).toEqual([]);
    expect(autoSlots("cross-env CI=1 vitest run e2e")).toEqual([]);
    expect(autoSlots("node node_modules/vitest/vitest.mjs run e2e")).toEqual([]);
    expect(autoSlots(".\\node_modules\\.bin\\vitest.cmd run e2e")).toEqual([]);
    expect(autoSlots("npx jest e2e-map")).toEqual([]);
    expect(autoSlots("yarn jest --testPathPattern e2e")).toEqual([]);
  });

  it("reads each part of a line (H55)", () => {
    expect(autoSlots("cd app && pnpm exec vitest run e2e-map")).toEqual([]);
    expect(autoSlots("vitest run e2e | tail -5")).toEqual([]);
    expect(autoSlots("vitest run e2e; jest e2e")).toEqual([]);
    expect(autoSlots("vitest run e2e-map && pnpm run test:e2e")).toEqual(["browser"]);
    expect(autoSlots("pnpm run test:e2e || vitest run")).toEqual(["browser"]);
    expect(autoSlots("vitest run; npx playwright test")).toEqual(["browser"]);
  });

  it("gives the slot to a unit test runner with --browser (H55)", () => {
    expect(autoSlots("pnpm exec vitest run --browser e2e-map")).toEqual(["browser"]);
    expect(autoSlots("vitest e2e --browser=chromium")).toEqual(["browser"]);
    expect(autoSlots("vitest e2e --browser.name chromium")).toEqual(["browser"]);
  });

  it("gives the slot to a unit test runner that picks an e2e suite (H55)", () => {
    expect(autoSlots("vitest run --project e2e")).toEqual(["browser"]);
    expect(autoSlots("pnpm exec vitest run --project=web-e2e")).toEqual(["browser"]);
    expect(autoSlots("vitest --config vitest.e2e.config.ts")).toEqual(["browser"]);
    expect(autoSlots("npx vitest -c vitest.e2e.config.ts run")).toEqual(["browser"]);
    expect(autoSlots("jest --config=jest.e2e.json")).toEqual(["browser"]);
    expect(autoSlots("jest --projects e2e")).toEqual(["browser"]);
    expect(autoSlots("vitest run e2e-map --project unit")).toEqual([]);
  });

  it("keeps the slot when the program is not the runner itself (H55)", () => {
    // A script or a shell can start a browser. A false slot costs a wait, and a missing slot risks failed process starts.
    expect(autoSlots("pnpm run vitest e2e")).toEqual(["browser"]);
    expect(autoSlots("pnpm e2e")).toEqual(["browser"]);
    expect(autoSlots("bash -c vitest e2e")).toEqual(["browser"]);
  });

  it("keeps the words of a browser runner in a part of a unit test runner (H55)", () => {
    expect(autoSlots("vitest run playwright test")).toEqual(["browser"]);
    expect(autoSlots("jest wdio")).toEqual(["browser"]);
  });

  it("gives no slot to a program that never starts a browser (H52)", () => {
    expect(autoSlots("tsc -p e2e/tsconfig.json")).toEqual([]);
    expect(autoSlots("pnpm exec tsc -p e2e/tsconfig.json --noEmit")).toEqual([]);
    expect(autoSlots("node_modules/.bin/eslint e2e")).toEqual([]);
    expect(autoSlots("npx prettier --check e2e/**/*.ts")).toEqual([]);
    expect(autoSlots("git add e2e/a.spec.ts")).toEqual([]);
    expect(autoSlots('git commit -m "run playwright test in e2e"')).toEqual([]);
    expect(autoSlots('gh pr create --title "e2e: a fix"')).toEqual([]);
    expect(autoSlots("pnpm --filter web-e2e install")).toEqual([]);
    expect(autoSlots("cat e2e/a.spec.ts")).toEqual([]);
  });

  it("gives no slot to a browser test runner that only lists its tests or gives its help (H52)", () => {
    expect(autoSlots("npx playwright test --list")).toEqual([]);
    expect(autoSlots("pnpm exec playwright test e2e --list")).toEqual([]);
    expect(autoSlots("npx playwright test --help")).toEqual([]);
    expect(autoSlots("npx cypress run -h")).toEqual([]);
    expect(autoSlots("pnpm exec wdio --version")).toEqual([]);
  });

  it("keeps the slot of each other part beside a light part, and of each unknown program that names e2e (H52)", () => {
    expect(autoSlots("tsc -p e2e/tsconfig.json && npx playwright test")).toEqual(["browser"]);
    expect(autoSlots("npx playwright test --list; npx playwright test")).toEqual(["browser"]);
    expect(autoSlots("npx playwright test --listen-port 9000")).toEqual(["browser"]);
    expect(autoSlots("node scripts/e2e.mjs")).toEqual(["browser"]);
    expect(autoSlots("bash scripts/run-e2e.sh")).toEqual(["browser"]);
    expect(autoSlots("pnpm --filter web-e2e test")).toEqual(["browser"]);
  });
});
