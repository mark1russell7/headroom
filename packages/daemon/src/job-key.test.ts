import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256Hex } from "@mark1russell7/rigor-generators";
import { afterEach, describe, expect, it } from "vitest";
import { countPackages, filterOf, jobFolder, jobKey, keyOfRun, kindOf, memoryAutoLine, NO_FACTS, normalizeCommand, readFacts, type FolderFacts } from "./job-key.ts";

describe("kindOf (H78)", () => {
  it.each([
    // Package managers
    ["pnpm install", "install"],
    ["pnpm i --frozen-lockfile", "install"],
    ["npm ci", "install"],
    ["yarn", "install"],
    ["pnpm add -D vitest", "install"],
    ["pnpm test", "test"],
    ["npm test", "test"],
    ["pnpm run test:unit", "test"],
    ["npm run build", "build"],
    ["bun run build", "build"],
    ["npm run typecheck", "typecheck"],
    ["pnpm typecheck", "typecheck"],
    ["pnpm -r typecheck", "typecheck"],
    ["pnpm -w lint:ste", "lint"],
    ["pnpm vitest run", "test"],
    ["pnpm tsc --noEmit", "typecheck"],
    ["pnpm --filter @headroom/core exec vitest run src/a.test.ts", "test"],
    ["pnpm --filter ./packages/x build", "build"],
    ["npm exec -- eslint .", "lint"],
    ["npm run start", "other"],
    // Runners and programs
    ["npx tsc --noEmit", "typecheck"],
    ["vite build", "build"],
    ["vite", "other"],
    ["next build", "build"],
    ["tsup", "build"],
    ["eslint .", "lint"],
    ["prettier --check .", "lint"],
    ["git status", "other"],
    // Node.js
    ["node --test src/", "test"],
    ["node --experimental-strip-types --test", "test"],
    ["node node_modules/vitest/vitest.mjs run", "test"],
    ["node ./node_modules/.bin/tsc -p .", "typecheck"],
    ["node ../../node_modules/typescript/bin/tsc -p .", "typecheck"],
    ["node node_modules/@biomejs/biome/bin/biome check", "lint"],
    ["node scripts/gen.mjs", "other"],
    ["node -e console.log(1)", "other"],
    // Browser tests take the classifier of the browser slot
    ["npx playwright test e2e/x.spec.ts", "browser"],
    ["pnpm exec vitest run e2e", "test"],
    ["pnpm exec vitest run --browser e2e", "browser"],
    // Shells, folders, variables and wrappers
    ['sh -c "pnpm build && pnpm test"', "build"],
    ['cmd /c "pnpm lint"', "lint"],
    ['pwsh -NoProfile -Command "pnpm typecheck"', "typecheck"],
    ["cd packages/core && pnpm exec vitest run", "test"],
    ["pnpm install && pnpm test", "test"],
    ["CI=1 timeout 280 pnpm test", "test"],
    ["cross-env NODE_ENV=production webpack", "build"],
    ["c8 vitest run", "test"],
    // Job names of one word
    ["h78-typecheck", "typecheck"],
    ["alerts-sources-test", "test"],
    ["lint2", "lint"],
    ["e2e", "browser"],
    ["nightly", "other"],
  ])("%s is %s", (text, kind) => {
    expect(kindOf(text)).toBe(kind);
  });
});

describe("filterOf (H78)", () => {
  it("gives the sorted filters of pnpm and the workspaces of npm, or null", () => {
    expect(filterOf("pnpm --filter @headroom/daemon --filter @headroom/core test")).toBe("@headroom/core @headroom/daemon");
    expect(filterOf("pnpm -F b -F=a test")).toBe("a b");
    expect(filterOf("CI=1 pnpm --filter x test")).toBe("x");
    expect(filterOf("npm run build --workspace=packages/x")).toBe("packages/x");
    expect(filterOf("npm -w a test")).toBe("a");
    // For pnpm, -w is the workspace root and has no value.
    expect(filterOf("pnpm -w lint")).toBeNull();
    expect(filterOf("pnpm test")).toBeNull();
    expect(filterOf('sh -c "pnpm --filter y build && pnpm --filter x test"')).toBe("x y");
  });
});

describe("normalizeCommand (H78)", () => {
  it("gives one text for the runs of a command from two worktrees or two temporary folders", () => {
    expect(normalizeCommand("node D:\\git\\a\\scripts\\gen.mjs")).toBe("node <abs>/gen.mjs");
    expect(normalizeCommand("node D:/git/b/scripts/gen.mjs")).toBe("node <abs>/gen.mjs");
    expect(normalizeCommand("vitest run C:/Users/x/AppData/Local/Temp/abc/t.test.ts")).toBe("vitest run <tmp>/t.test.ts");
    expect(normalizeCommand("sh /tmp/x/run.sh")).toBe("sh <tmp>/run.sh");
  });

  it("replaces ids, keeps relative paths, and collapses the spaces", () => {
    expect(normalizeCommand("git show 3fa9c2e1b")).toBe("git show <id>");
    expect(normalizeCommand("headroom cancel 1ea5c2dd-1111-2222-3333-444455556666")).toBe("headroom cancel <id>");
    expect(normalizeCommand("pnpm   exec vitest run src/a.test.ts")).toBe("pnpm exec vitest run src/a.test.ts");
    expect(normalizeCommand(`echo ${"x".repeat(600)}`)).toHaveLength(500);
  });
});

describe("jobFolder (H78)", () => {
  it("takes a leading cd, then -C, --dir or --prefix, else the current folder", () => {
    const cwd = resolve(tmpdir(), "headroom-folder");
    expect(jobFolder(["sh", "-c", "cd packages/core && pnpm test"], cwd)).toBe(resolve(cwd, "packages/core"));
    expect(jobFolder(["pnpm", "-C", "packages/x", "test"], cwd)).toBe(resolve(cwd, "packages/x"));
    expect(jobFolder(["npm", "--prefix=app", "test"], cwd)).toBe(resolve(cwd, "app"));
    expect(jobFolder(["pnpm", "test"], cwd)).toBe(cwd);
  });
});

/** A lockfile of pnpm with two packages. */
const PNPM_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      a:
        specifier: ^1.0.0

packages:

  a@1.0.0:
    resolution: {integrity: sha512-x}

  '@b/c@2.0.0':
    resolution: {integrity: sha512-y}

snapshots:

  a@1.0.0: {}
`;

describe("countPackages (H78)", () => {
  it("counts the packages of a lockfile of pnpm or npm, or gives null with no packages section", () => {
    expect(countPackages("pnpm-lock.yaml", PNPM_LOCK)).toBe(2);
    expect(countPackages("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")).toBeNull();
    expect(countPackages("package-lock.json", JSON.stringify({ packages: { "": {}, "node_modules/a": {}, "node_modules/b": {} } }))).toBe(2);
    expect(countPackages("package-lock.json", JSON.stringify({ dependencies: { a: {}, b: {}, c: {} } }))).toBe(3);
    expect(countPackages("package-lock.json", "{}")).toBeNull();
  });
});

describe("readFacts and keyOfRun (H78)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** This function makes a repository `shop` with a lockfile, a package and a worktree `feature` of it. */
  function repos(): { shop: string; feature: string } {
    const dir = mkdtempSync(join(tmpdir(), "headroom-key-"));
    dirs.push(dir);
    const shop = join(dir, "shop");
    mkdirSync(join(shop, ".git", "worktrees", "feature"), { recursive: true });
    mkdirSync(join(shop, "packages", "core"), { recursive: true });
    mkdirSync(join(shop, "node_modules"));
    writeFileSync(join(shop, "pnpm-lock.yaml"), PNPM_LOCK);
    writeFileSync(join(shop, "package.json"), "{}");
    writeFileSync(join(shop, "packages", "core", "package.json"), "{}");
    const feature = join(dir, "worktrees", "feature");
    mkdirSync(feature, { recursive: true });
    writeFileSync(join(feature, ".git"), `gitdir: ${join(shop, ".git", "worktrees", "feature")}\n`);
    return { shop, feature };
  }

  it("reads the repo, the lockfile, its packages, the warm state and the package folder", () => {
    const { shop } = repos();
    expect(readFacts(join(shop, "packages", "core"))).toEqual({
      repo: "shop",
      lock: sha256Hex(PNPM_LOCK).slice(0, 16),
      packages: 2,
      warm: true,
      folder: "packages/core",
    });
    expect(readFacts(shop)).toMatchObject({ repo: "shop", folder: "." });
  });

  it("gives the main repository of a worktree, and a worktree with no lockfile and no node_modules", () => {
    const { feature } = repos();
    expect(readFacts(feature)).toEqual({ repo: "shop", lock: null, packages: null, warm: false, folder: null });
  });

  it("gives the key of a command of headroom run from its folder", () => {
    const { shop } = repos();
    expect(keyOfRun(["sh", "-c", "cd packages/core && pnpm test"], shop)).toEqual({
      kind: "test",
      repo: "shop",
      lock: sha256Hex(PNPM_LOCK).slice(0, 16),
      filter: "packages/core",
      warm: true,
      packages: 2,
      command: "sh -c cd packages/core && pnpm test",
    });
  });
});

describe("jobKey (H78)", () => {
  const facts: FolderFacts = { repo: "shop", lock: "0123456789abcdef", packages: 900, warm: false, folder: "packages/core" };

  it("takes the filter of the command before the package folder", () => {
    expect(jobKey(["pnpm", "--filter", "x", "test"], facts)).toMatchObject({ kind: "test", filter: "x" });
    expect(jobKey(["pnpm", "test"], facts)).toEqual({ kind: "test", repo: "shop", lock: "0123456789abcdef", filter: "packages/core", warm: false, packages: 900, command: "pnpm test" });
  });

  it("gives a key with null facts for a folder with no repository", () => {
    expect(jobKey(["pnpm", "install"], NO_FACTS)).toEqual({ kind: "install", repo: null, lock: null, filter: null, warm: null, packages: null, command: "pnpm install" });
  });
});

describe("memoryAutoLine (H78)", () => {
  const mb = (value: number): string => `${value} MB`;
  const key = jobKey(["pnpm", "test"], NO_FACTS);

  it("says no read at the rung none", () => {
    expect(memoryAutoLine(null, null, 1024, mb)).toBe("headroom: --mem auto gives 1024 MB: no read, because no run of this job has a peak yet.");
    expect(memoryAutoLine({ memoryMb: null, runs: 0, peakMb: null, rung: "none" }, key, 1024, mb)).toBe(
      "headroom: --mem auto gives 1024 MB: no read, because no run of this job, its key or its kind (test) has a peak yet.",
    );
  });

  it("names the rung and the count of runs", () => {
    expect(memoryAutoLine({ memoryMb: 832, runs: 2, peakMb: 600, rung: "key" }, key, 1024, mb)).toBe(
      "headroom: --mem auto gives 832 MB, at the rung key: the peaks of 2 runs of the same key (kind, repository, lockfile and package) (the highest 600 MB).",
    );
    expect(memoryAutoLine({ memoryMb: 512, runs: 50, peakMb: 900, rung: "kind" }, key, 1024, mb)).toBe(
      "headroom: --mem auto gives 512 MB, at the rung kind: the peaks of 50 runs of the kind test (the highest 900 MB).",
    );
  });

  it("names the floor of the command when the floor gives the amount (H215)", () => {
    const floor = { floorMb: 884, run: { id: "abcdef01", job: "visuals bundle", holder: "visuals", peakMb: 803, endedAt: 0 } };
    expect(memoryAutoLine({ memoryMb: 884, runs: 9, peakMb: 803, rung: "key", floor }, key, 1024, mb)).toBe(
      "headroom: --mem auto gives 884 MB: the floor of this command, the peak of its last run (803 MB, job visuals bundle) times 1.1.",
    );
    // The ladder gives more than the floor: the line names the rung.
    expect(memoryAutoLine({ memoryMb: 1011, runs: 1, peakMb: 803, rung: "key", floor }, key, 1024, mb)).toContain("at the rung key");
  });

  it("gives the rung job for a daemon before H78, which sends no rung", () => {
    expect(memoryAutoLine({ memoryMb: 1152, runs: 1, peakMb: 900 } as never, null, 1024, mb)).toBe(
      "headroom: --mem auto gives 1152 MB, at the rung job: the peaks of 1 run of this job (the highest 900 MB).",
    );
  });
});
