import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { toPosix } from "@mark1russell7/files";
import { afterEach, describe, expect, it } from "vitest";
import {
  foldersOfCommand,
  joinWords,
  type LongPath,
  longestRootThatPasses,
  longPathRefusal,
  mainCheckoutOf,
  NATIVE_PATH_LIMIT,
  NativeImages,
  nativeRefusal,
  ntPathLength,
  runRefusal,
} from "./native-paths.ts";

const WINDOWS = process.platform === "win32";
/** An absolute folder of the system: the commands of the tests use it. */
const ROOT = WINDOWS ? "D:\\w" : "/w";
const HOME = WINDOWS ? "C:\\Users\\u" : "/home/u";
const at = (...parts: string[]): string => resolve(ROOT, ...parts);

describe("the NT path of a Windows path (H203)", () => {
  it("counts the device of a drive with a volume number of two digits", () => {
    expect(ntPathLength("D:\\git\\x")).toBe("\\Device\\HarddiskVolume12\\git\\x".length);
    expect(ntPathLength("D:/git/x")).toBe(ntPathLength("D:\\git\\x"));
    expect(ntPathLength("\\\\?\\D:\\git\\x")).toBe(ntPathLength("D:\\git\\x"));
  });

  it("counts a share of the network as \\Device\\Mup", () => {
    expect(ntPathLength("\\\\server\\share\\x")).toBe("\\Device\\Mup\\server\\share\\x".length);
  });

  it("gives the longest folder that passes, for images of a length after the folder", () => {
    const most = longestRootThatPasses(141);
    const folder = `D:\\${"a".repeat(most - 3)}`;
    expect(folder.length).toBe(most);
    expect(ntPathLength(`${folder}\\${"b".repeat(141)}`)).toBe(NATIVE_PATH_LIMIT);
    expect(ntPathLength(`${folder}a\\${"b".repeat(141)}`)).toBe(NATIVE_PATH_LIMIT + 1);
  });
});

describe("the folders where a command line runs node (H203)", () => {
  const cases: readonly (readonly [string, string | null, readonly string[]])[] = [
    ["pnpm test", ROOT, [at()]],
    [`cd ${at("b")} && pnpm test`, ROOT, [at("b")]],
    ["cd sub; pnpm exec vitest run", ROOT, [at("sub")]],
    [`pnpm -C ${at("c")} install`, ROOT, [at("c")]],
    [`npm --prefix=${at("d")} ci`, ROOT, [at("d")]],
    ["git status", ROOT, []],
    ["git log --oneline -3", ROOT, []],
    ['git commit -m "a message"', ROOT, [at()]],
    [`git -C ${at("e")} push`, ROOT, [at("e")]],
    [`bash -c "cd ${at("f")} && pnpm test"`, ROOT, [at("f")]],
    ["headroom run --mem auto --job x -- pnpm test", ROOT, [at()]],
    ["ls node_modules", ROOT, []],
    ["echo hi && cat package.json | grep name", ROOT, []],
    [`Set-Location ${at("h")}; pnpm test`, ROOT, [at("h")]],
    ["pnpm test", null, []],
    [`cd ${at("i")} && pnpm test`, null, [at("i")]],
    ["cd ~/x && pnpm i", ROOT, [resolve(HOME, "x")]],
    ["NODE_OPTIONS=--trace-warnings pnpm test", ROOT, [at()]],
    ["env FOO=1 vitest run", ROOT, [at()]],
    [`cmd /c "cd /d ${at("j")} && pnpm test"`, ROOT, [at("j")]],
    ["cat <<'EOF'\npnpm test\nEOF", ROOT, []],
  ];

  it.each(cases)("reads %j in %j", (command, cwd, folders) => {
    expect(foldersOfCommand(command, cwd, HOME).sort()).toEqual([...folders].sort());
  });

  it("gives the folder above node_modules in the path of a program, and the folder of the line", () => {
    const folders = foldersOfCommand(`node ${at("g", "node_modules", "vitest", "vitest.mjs")} run`, ROOT, HOME);
    expect(folders.sort()).toEqual([at(), at("g")].sort());
  });

  it("joins words with quotes where a word has a space or a quote", () => {
    expect(joinWords(["pnpm", "test", "a b", 'say "x"', ""])).toBe(`pnpm test "a b" 'say "x"' ""`);
  });
});

/** The temporary folders of a test. Each gets its real path, because a short 8.3 name of Windows is a different text. */
const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "headroom-native-"));
  made.push(folder);
  return realpathSync.native(folder);
}

/** A walk of the tests: it gives the images of each node_modules folder of the map, and counts each call. */
function fakeFind(images: Record<string, readonly string[]>): { readonly calls: string[]; readonly find: (nodeModules: string) => Promise<readonly string[]> } {
  const calls: string[] = [];
  return {
    calls,
    find: async (nodeModules) => {
      calls.push(nodeModules);
      return images[nodeModules] ?? [];
    },
  };
}

/** A workspace with an installed `node_modules` and one long image. */
function workspace(): { readonly root: string; readonly nodeModules: string; readonly image: string } {
  const root = tempFolder();
  const nodeModules = join(root, "node_modules");
  mkdirSync(join(nodeModules, ".pnpm"), { recursive: true });
  return { root, nodeModules, image: join(nodeModules, ".pnpm", "x".repeat(30), "node_modules", "binding.node") };
}

describe("the native images of a folder (H203)", () => {
  // The prior is 0 in these tests, so the lockfile or the node_modules of a folder above the temporary folder adds no long path.
  it("refuses a folder whose longest image passes the limit, and lets go a folder at the limit", async () => {
    const { root, nodeModules, image } = workspace();
    const { find } = fakeFind({ [nodeModules]: [join(nodeModules, "short.node"), image] });
    const ntLength = ntPathLength(image);
    const strict = await new NativeImages({ find, platform: "win32", limit: ntLength - 1, defaultRelative: 0 }).check([root]);
    expect(strict).toMatchObject({ root, image, ntLength, basis: "measured", relativeLength: image.length - root.length - 1 });
    expect(await new NativeImages({ find, platform: "win32", limit: ntLength, defaultRelative: 0 }).check([root])).toBeNull();
  });

  it("walks a node_modules folder one time until its .pnpm folder changes", async () => {
    const { root, nodeModules, image } = workspace();
    const { calls, find } = fakeFind({ [nodeModules]: [image] });
    const images = new NativeImages({ find, platform: "win32", defaultRelative: 0 });
    await images.check([root]);
    await images.check([root, join(root, "packages")]);
    expect(calls.filter((each) => each === nodeModules)).toHaveLength(1);
    utimesSync(join(nodeModules, ".pnpm"), new Date(), new Date(Date.now() + 60_000));
    await images.check([root]);
    expect(calls.filter((each) => each === nodeModules)).toHaveLength(2);
  });

  it("uses the prior for a walk that passes its budget, and the measure after the walk ends", async () => {
    const root = tempFolder();
    const nodeModules = join(root, "node_modules");
    mkdirSync(nodeModules);
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => (release = done));
    const find = async (folder: string): Promise<readonly string[]> => {
      if (folder !== nodeModules) return [];
      await held;
      return [join(nodeModules, "a.node")];
    };
    const images = new NativeImages({ find, platform: "win32", defaultRelative: 200 });
    const first = await images.check([root], 20);
    expect(first).toMatchObject({ root, basis: "prior", image: null, relativeLength: 200, ntLength: ntPathLength(root) + 1 + 200 });
    release();
    expect(await images.check([root], 20)).toBeNull();
    // A short image does not lower the prior.
    expect(images.prior).toBe(200);
  });

  it("raises the prior to the longest part after the folder that a walk measured", async () => {
    const { root, nodeModules, image } = workspace();
    const { find } = fakeFind({ [nodeModules]: [image] });
    const images = new NativeImages({ find, platform: "win32", defaultRelative: 0 });
    await images.check([root]);
    expect(images.prior).toBe(image.length - root.length - 1);
  });

  it("lets each command go on outside Windows, with no walk", async () => {
    const { root, nodeModules, image } = workspace();
    const { calls, find } = fakeFind({ [nodeModules]: [image] });
    expect(await new NativeImages({ find, platform: "linux", limit: 1 }).check([root])).toBeNull();
    expect(calls).toEqual([]);
  });

  it("gives a worktree with a lockfile and no install the length of the images of its main checkout", async () => {
    const base = tempFolder();
    const main = join(base, "repo");
    const worktree = join(base, "repo-wt", "y".repeat(40));
    mkdirSync(join(main, ".git", "worktrees", "y"), { recursive: true });
    mkdirSync(join(main, "node_modules", ".pnpm"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(main, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "y")}\n`);
    const image = join(main, "node_modules", ".pnpm", "z".repeat(50), "binding.node");
    const { find } = fakeFind({ [join(main, "node_modules")]: [image] });
    const relativeLength = image.length - main.length - 1;
    const ntLength = ntPathLength(worktree) + 1 + relativeLength;
    const long = await new NativeImages({ find, platform: "win32", limit: ntLength - 1, defaultRelative: 0 }).check([worktree]);
    expect(long).toMatchObject({ root: worktree, basis: "main checkout", image, ntLength, relativeLength, mainCheckout: toPosix(main, "\\") });
  });

  it("reads the main checkout from the .git file of a worktree, and gives null for a repository or a bad file", () => {
    const base = tempFolder();
    mkdirSync(join(base, "repo", ".git"), { recursive: true });
    writeFileSync(join(base, "wt.git"), `gitdir: ${join(base, "repo", ".git", "worktrees", "a")}\n`);
    writeFileSync(join(base, "bad.git"), "not a pointer\n");
    expect(mainCheckoutOf(join(base, "wt.git"))).toBe(toPosix(join(base, "repo"), "\\"));
    expect(mainCheckoutOf(join(base, "repo", ".git"))).toBeNull();
    expect(mainCheckoutOf(join(base, "bad.git"))).toBeNull();
    expect(mainCheckoutOf(join(base, "none.git"))).toBeNull();
  });

  it("checks the folders of a command line", async () => {
    const { root, nodeModules, image } = workspace();
    const { find } = fakeFind({ [nodeModules]: [image] });
    const images = new NativeImages({ find, platform: "win32", limit: ntPathLength(image) - 1, defaultRelative: 0 });
    expect(await nativeRefusal(images, { command: `cd ${root} && pnpm test`, cwd: null })).toContain(`this command runs node in ${root}.`);
    expect(await nativeRefusal(images, { command: `cd ${root} && git status`, cwd: null })).toBeNull();
  });
});

describe("the text of a refusal for a long native path (H203)", () => {
  const long: LongPath = {
    root: "C:\\Users\\u\\AppData\\Local\\Temp\\claude\\0123456789abcdef\\scratchpad\\worktrees\\app",
    image: "D:\\git\\app\\node_modules\\.pnpm\\a\\b.node",
    ntLength: 281,
    relativeLength: 141,
    basis: "main checkout",
    mainCheckout: "D:/git/app",
    limit: NATIVE_PATH_LIMIT,
  };

  it("names the length, the limit and a short folder next to the main checkout", () => {
    const text = longPathRefusal(long);
    expect(text).toContain(`runs node in ${long.root}.`);
    expect(text).toContain("NT path of 281 characters (from the main checkout: D:\\git\\app\\node_modules\\.pnpm\\a\\b.node)");
    expect(text).toContain("The limit is 240.");
    expect(text).toContain("a folder with a path of at most 76 characters, for example D:/git/app-wt/<name>.");
  });

  it("gives the image of a walk, and the prior when no walk measured the folder", () => {
    expect(longPathRefusal({ ...long, basis: "measured" })).toContain("Its longest native image has an NT path of 281 characters: D:\\git\\app");
    expect(longPathRefusal({ ...long, basis: "prior", image: null })).toContain("No walk measured its native images yet. With the usual 141 characters");
  });

  it("names no example with no repository, or when the example is too long", () => {
    expect(longPathRefusal({ ...long, mainCheckout: null })).toMatch(/at most 76 characters\.$/);
    expect(longPathRefusal({ ...long, mainCheckout: `D:/${"q".repeat(80)}` })).toMatch(/at most 76 characters\.$/);
  });
});

describe("the check of headroom run (H203)", () => {
  const local = (): { readonly calls: number[]; readonly make: () => NativeImages } => {
    const calls: number[] = [];
    return { calls, make: () => (calls.push(1), new NativeImages({ platform: "linux" })) };
  };

  it("takes the answer of the daemon", async () => {
    const { calls, make } = local();
    expect(await runRefusal(["pnpm", "test"], ROOT, async () => ({ refusal: "too long" }), make)).toBe("too long");
    expect(await runRefusal(["pnpm", "test"], ROOT, async () => ({ refusal: null }), make)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("walks the folders itself with no daemon, a failed call or an answer of an older daemon", async () => {
    const { calls, make } = local();
    expect(await runRefusal(["pnpm", "test"], ROOT, null, make)).toBeNull();
    expect(await runRefusal(["pnpm", "test"], ROOT, async () => Promise.reject(new Error("no such procedure")), make)).toBeNull();
    expect(await runRefusal(["pnpm", "test"], ROOT, async () => ({}) as { refusal: string | null }, make)).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("sends the command with its words joined", async () => {
    const sent: unknown[] = [];
    await runRefusal(["pnpm", "exec", "vitest", "run", "a b"], ROOT, async (input) => (sent.push(input), { refusal: null }));
    expect(sent).toEqual([{ command: 'pnpm exec vitest run "a b"', cwd: ROOT }]);
  });
});
