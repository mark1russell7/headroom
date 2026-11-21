import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  classifyWorktree,
  cleanDue,
  cleanWorktrees,
  findNodeModules,
  installLinkRefusal,
  keepAlert,
  LinkCache,
  linksInto,
  moduleFolders,
  moduleLinks,
  nodeRunner,
  parsePorcelain,
  pathKey,
  trimEndSlashes,
  refusal,
  removeNodeModules,
  removeWorktree,
  repoCheckouts,
  samePath,
  scanWorktrees,
  summarize,
  worktreeRulesSource,
  WORKTREE_CLEAN_EVERY_MS,
  type EntryKind,
  type GitResult,
  type WorktreeRunner,
} from "./worktrees.ts";

const NOW = Date.UTC(2026, 10, 8, 12);
const OLD = NOW - 3 * 86_400_000;
const FRESH = NOW - 3_600_000;
const ROOT = "/r/git";
const key = (path: string): string => pathKey(path, "linux");

interface Node {
  kind: EntryKind;
  mtimeMs: number;
  text?: string;
  /** The target of a link. A link with no target cannot be read. */
  target?: string;
}

interface Tree {
  path: string;
  branch?: string;
  locked?: boolean;
  prunable?: boolean;
}

/** How the fake `git worktree remove` acts: it removes the tree, it fails partway after it unregisters the tree, or it refuses. */
type RemoveMode = "ok" | "partial" | "refuse";

/** A fake file system and a fake git for the tests. */
class Fake implements WorktreeRunner {
  readonly nodes = new Map<string, Node>();
  readonly trees = new Map<string, Tree[]>();
  readonly dirty = new Set<string>();
  readonly unpushed = new Map<string, number>();
  readonly gitCalls: string[][] = [];
  readonly removed: string[] = [];
  readonly order: string[] = [];
  removeMode: RemoveMode = "ok";

  add(path: string, kind: EntryKind = "file", mtimeMs = OLD, text?: string): this {
    const parts = key(path).split("/");
    for (let at = 2; at < parts.length; at++) {
      const parent = parts.slice(0, at).join("/");
      if (!this.nodes.has(parent)) this.nodes.set(parent, { kind: "dir", mtimeMs: OLD });
    }
    this.nodes.set(key(path), { kind, mtimeMs, ...(text === undefined ? {} : { text }) });
    return this;
  }

  /** This function adds a link with its target, as a junction or a symbolic link. `null` makes a link that cannot be read. */
  link(path: string, target: string | null): this {
    this.add(path, "link");
    if (target !== null) (this.nodes.get(key(path)) as Node).target = target;
    return this;
  }

  /** This function adds a main checkout with its linked trees. Each linked tree gets a `.git` file and a git folder. */
  repo(name: string, trees: Tree[] = []): this {
    const main = `${ROOT}/${name}`;
    this.add(`${main}/.git`, "dir").add(`${main}/package.json`);
    this.trees.set(key(main), [{ path: main, branch: "main" }, ...trees]);
    for (const tree of trees) {
      const id = tree.path.split("/").pop() as string;
      this.add(`${main}/.git/worktrees/${id}/HEAD`).add(`${main}/.git/worktrees/${id}/index`);
      this.add(`${main}/.git/worktrees/${id}/gitdir`, "file", OLD, `${tree.path}/.git\n`).add(`${main}/.git/worktrees/${id}/commondir`, "file", OLD, "../..\n");
      if (tree.prunable !== true) this.add(`${tree.path}/.git`, "file", OLD, `gitdir: ${main}/.git/worktrees/${id}\n`).add(`${tree.path}/src/a.ts`);
    }
    return this;
  }

  entries(path: string): { name: string; kind: EntryKind }[] | null {
    const base = key(path);
    if (this.nodes.get(base)?.kind !== "dir") return null;
    const list: { name: string; kind: EntryKind }[] = [];
    for (const [each, node] of this.nodes) {
      if (!each.startsWith(`${base}/`)) continue;
      const rest = each.slice(base.length + 1);
      if (!rest.includes("/")) list.push({ name: rest, kind: node.kind });
    }
    return list;
  }

  stat(path: string): { kind: EntryKind; mtimeMs: number } | null {
    const node = this.nodes.get(key(path));
    return node === undefined ? null : { kind: node.kind, mtimeMs: node.mtimeMs };
  }

  readText(path: string): string | null {
    return this.nodes.get(key(path))?.text ?? null;
  }

  readLink(path: string): string | null {
    const node = this.nodes.get(key(path));
    return node?.kind === "link" ? (node.target ?? null) : null;
  }

  remove(path: string): void {
    const base = key(path);
    this.removed.push(base);
    this.order.push(`rm ${base}`);
    for (const each of [...this.nodes.keys()]) if (each === base || each.startsWith(`${base}/`)) this.nodes.delete(each);
  }

  freeMb(): number {
    return 10_000 + this.removed.length;
  }

  #porcelain(main: string): string {
    return (this.trees.get(key(main)) ?? [])
      .map((tree) =>
        [`worktree ${tree.path}`, "HEAD 0123", tree.branch === undefined ? "detached" : `branch refs/heads/${tree.branch}`, ...(tree.locked === true ? ["locked"] : []), ...(tree.prunable === true ? ["prunable gitdir file points to non-existent location"] : [])].join("\n"),
      )
      .join("\n\n");
  }

  async git(args: readonly string[]): Promise<GitResult> {
    this.gitCalls.push([...args]);
    const [flag, where, command, ...rest] = args[0] === "--no-optional-locks" ? args.slice(1) : args;
    if (flag !== "-C" || where === undefined) return { code: 129, stdout: "", stderr: "usage" };
    const at = key(where);
    const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: "" });
    if (command === "worktree" && rest[0] === "list") return this.trees.has(at) ? ok(`${this.#porcelain(where)}\n`) : { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    if (command === "status") return ok(this.dirty.has(at) ? " M src/a.ts\n" : "");
    if (command === "rev-list") return ok(`${this.unpushed.get(at) ?? 0}\n`);
    if (command === "check-ignore") {
      const paths = rest.slice(1).filter((path) => path.split("/").pop() === "node_modules");
      return paths.length === 0 ? { code: 1, stdout: "", stderr: "" } : ok(`${paths.join("\n")}\n`);
    }
    if (command === "worktree" && rest[0] === "prune") {
      this.order.push(`prune ${at}`);
      this.trees.set(at, (this.trees.get(at) ?? []).filter((tree) => tree.prunable !== true));
      return ok("");
    }
    if (command === "worktree" && rest[0] === "remove") {
      const target = key(rest.at(-1) as string);
      this.order.push(`git remove ${target}`);
      if (this.removeMode === "refuse") return { code: 128, stdout: "", stderr: `fatal: '${target}' contains modified or untracked files, use --force to delete it` };
      this.trees.set(at, (this.trees.get(at) ?? []).filter((tree) => key(tree.path) !== target));
      if (this.removeMode === "partial") {
        this.nodes.delete(`${target}/src/a.ts`);
        return { code: 255, stdout: "", stderr: `error: failed to delete '${target}': Directory not empty` };
      }
      for (const each of [...this.nodes.keys()]) if (each === target || each.startsWith(`${target}/`)) this.nodes.delete(each);
      return ok("");
    }
    return { code: 1, stdout: "", stderr: `fake git: no answer for ${args.join(" ")}` };
  }

  /** This function tells if a git call used `--force`. */
  forced(): boolean {
    return this.gitCalls.some((call) => call.includes("--force") || call.includes("-f"));
  }

  exists(path: string): boolean {
    return this.nodes.has(key(path));
  }
}

const options = (fake: Fake): { roots: string[]; runner: Fake; now: number; platform: "linux" } => ({ roots: [ROOT], runner: fake, now: NOW, platform: "linux" });

describe("parsePorcelain", () => {
  it("reads the main checkout, a branch, a detached HEAD, a lock, a prunable tree and a bare entry", () => {
    const text = [
      "worktree /r/git/app\nHEAD aaa\nbranch refs/heads/main",
      "worktree /r/git/app-wt/one\nHEAD bbb\nbranch refs/heads/feature/one\nlocked reason",
      "worktree /r/git/app-wt/two\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location",
      "worktree /r/git/bare.git\nbare",
    ].join("\n\n");
    const entries = parsePorcelain(`${text}\n`);
    expect(entries.map((entry) => entry.path)).toEqual(["/r/git/app", "/r/git/app-wt/one", "/r/git/app-wt/two", "/r/git/bare.git"]);
    expect(entries[1]).toMatchObject({ branch: "feature/one", locked: true, prunable: false });
    expect(entries[2]).toMatchObject({ branch: null, locked: false, prunable: true });
    expect(entries[3]?.bare).toBe(true);
  });

  it("reads Windows line ends", () => {
    expect(parsePorcelain("worktree D:/git/app\r\nHEAD a\r\nbranch refs/heads/main\r\n\r\nworktree D:/git/app-wt/x\r\nHEAD b\r\ndetached\r\n").map((entry) => entry.path)).toEqual(["D:/git/app", "D:/git/app-wt/x"]);
  });
});

describe("classifyWorktree", () => {
  const base = { exists: true, prunable: false, locked: false, dirty: false, unpushed: 0, changedAt: OLD, now: NOW, idleMs: 86_400_000 };

  it("gives each state", () => {
    expect(classifyWorktree(base).state).toBe("removable");
    expect(classifyWorktree({ ...base, changedAt: FRESH }).state).toBe("active");
    expect(classifyWorktree({ ...base, dirty: true })).toEqual({ state: "keep", reasons: ["changes that are not committed"] });
    expect(classifyWorktree({ ...base, unpushed: 2 })).toEqual({ state: "keep", reasons: ["2 commits that are not on a remote"] });
    expect(classifyWorktree({ ...base, locked: true }).state).toBe("keep");
    expect(classifyWorktree({ ...base, prunable: true }).state).toBe("broken");
    expect(classifyWorktree({ ...base, exists: false }).state).toBe("broken");
  });

  it("counts a fact that git could not read against the removal", () => {
    expect(classifyWorktree({ ...base, dirty: null }).state).toBe("keep");
    expect(classifyWorktree({ ...base, unpushed: null }).state).toBe("keep");
    expect(classifyWorktree({ ...base, changedAt: null }).state).toBe("active");
  });
});

describe("scanWorktrees", () => {
  it("gives the state of each linked tree, and never lists a main checkout as a tree", async () => {
    const fake = new Fake().repo("app", [
      { path: `${ROOT}/app-wt/idle`, branch: "idle" },
      { path: `${ROOT}/app-wt/busy`, branch: "busy" },
      { path: `${ROOT}/app-wt/dirty`, branch: "dirty" },
      { path: `${ROOT}/app-wt/ahead`, branch: "ahead" },
      { path: `${ROOT}/app-wt/gone`, branch: "gone", prunable: true },
      { path: "/elsewhere/app-x", branch: "x" },
    ]);
    fake.add(`${ROOT}/app-wt/busy/notes.md`, "file", FRESH);
    fake.dirty.add(`${ROOT}/app-wt/dirty`);
    fake.unpushed.set(`${ROOT}/app-wt/ahead`, 3);
    const scan = await scanWorktrees(options(fake));
    const state = Object.fromEntries(scan.trees.map((tree) => [tree.path, tree.state]));
    expect(state).toEqual({
      [`${ROOT}/app-wt/idle`]: "removable",
      [`${ROOT}/app-wt/busy`]: "active",
      [`${ROOT}/app-wt/dirty`]: "keep",
      [`${ROOT}/app-wt/ahead`]: "keep",
      [`${ROOT}/app-wt/gone`]: "broken",
      "/elsewhere/app-x": "removable",
    });
    expect(scan.mains.map(key)).toEqual([`${ROOT}/app`]);
    expect(scan.trees.find((tree) => tree.path === "/elsewhere/app-x")?.inRoots).toBe(false);
  });

  it("uses the git HEAD and index for the idle time, and not node_modules", async () => {
    const fake = new Fake().repo("app", [{ path: `${ROOT}/app-wt/t`, branch: "t" }]);
    fake.add(`${ROOT}/app-wt/t/node_modules`, "dir", FRESH);
    expect((await scanWorktrees(options(fake))).trees[0]?.state).toBe("removable");
    fake.add(`${ROOT}/app/.git/worktrees/t/index`, "file", FRESH);
    expect((await scanWorktrees(options(fake))).trees[0]?.state).toBe("active");
  });

  it("finds the orphans next to a main checkout and in its -wt folder, with their newest time", async () => {
    const fake = new Fake().repo("algebra", [{ path: `${ROOT}/algebra-wt/live`, branch: "live" }]).repo("algebra-tools");
    fake.add(`${ROOT}/algebra-a13-packing/src/pack.ts`, "file", FRESH);
    fake.add(`${ROOT}/algebra-a13-packing/node_modules/x/index.js`, "file", NOW);
    fake.add(`${ROOT}/algebra-wt/left/README.md`);
    fake.add(`${ROOT}/algebra-wt/empty/node_modules/x.js`);
    fake.add(`${ROOT}/other/notes.md`);
    const scan = await scanWorktrees(options(fake));
    expect(scan.orphans.map((orphan) => key(orphan.path)).sort()).toEqual([`${ROOT}/algebra-a13-packing`, `${ROOT}/algebra-wt/left`]);
    expect(scan.orphans.find((orphan) => key(orphan.path).endsWith("packing"))).toMatchObject({ repo: "algebra", newestMs: FRESH });
    expect(summarize(scan).counts).toMatchObject({ orphan: 2, removable: 1 });
  });

  it("waits the git gap before the start of each git command, and gives the same states as a scan with no wait (H198)", async () => {
    const make = (): Fake => {
      const fake = new Fake().repo("app", [
        { path: `${ROOT}/app-wt/a`, branch: "a" },
        { path: `${ROOT}/app-wt/b`, branch: "b" },
        { path: `${ROOT}/app-wt/c`, branch: "c" },
      ]);
      fake.dirty.add(`${ROOT}/app-wt/b`);
      return fake;
    };
    const plain = await scanWorktrees(options(make()));
    const fake = make();
    const waits: { ms: number; startedBefore: number }[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push({ ms, startedBefore: fake.gitCalls.length });
    };
    const spaced = await scanWorktrees({ ...options(fake), gitGapMs: 500, sleep });
    expect(spaced.trees.map((tree) => tree.state)).toEqual(plain.trees.map((tree) => tree.state));
    // 1 worktree list and 2 calls for each of the 3 trees. Each wait comes before the start of its own git command.
    expect(fake.gitCalls).toHaveLength(7);
    expect(waits.map((wait) => wait.ms)).toEqual(Array.from({ length: 7 }, () => 500));
    expect(waits.map((wait) => wait.startedBefore)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const none: number[] = [];
    await scanWorktrees({ ...options(make()), gitGapMs: 0, sleep: async (ms) => void none.push(ms) });
    expect(none).toEqual([]);
  });
});

describe("worktreeRulesSource", () => {
  it("gives the source of the rules of the cleanup", () => {
    const source = worktreeRulesSource();
    expect(source).toContain("export function classifyWorktree");
    expect(source).toContain("export function refusal");
  });
});

describe("refusal", () => {
  const fake = new Fake().repo("app");
  fake.add(`${ROOT}/nested/inner/.git`, "dir");
  const context = { roots: [ROOT], mains: [`${ROOT}/app`, `${ROOT}/nested/inner`], runner: fake, platform: "linux" as const };

  it("refuses a path outside the roots, a root, a main checkout and a folder that holds one", () => {
    expect(refusal("/tmp/app-wt/x", context)).toMatch(/outside the roots/);
    expect(refusal(ROOT, context)).toMatch(/outside the roots/);
    expect(refusal(`${ROOT}/app`, context)).toMatch(/main checkout/);
    expect(refusal(`${ROOT}/nested`, context)).toMatch(/main checkout/);
    expect(refusal("app-wt/x", context)).toMatch(/not an absolute path/);
    expect(refusal(`${ROOT}/app-wt/x`, context)).toBeNull();
  });

  it("refuses a folder with a .git folder", () => {
    fake.add(`${ROOT}/app-wt/clone/.git`, "dir");
    expect(refusal(`${ROOT}/app-wt/clone`, context)).toMatch(/\.git folder/);
  });
});

describe("removeWorktree", () => {
  const tree = `${ROOT}/app-wt/t`;
  const make = (): Fake => new Fake().repo("app", [{ path: tree, branch: "t" }]);
  const remove = (fake: Fake, path = tree) => removeWorktree(path, { roots: [ROOT], mains: [`${ROOT}/app`], runner: fake, main: `${ROOT}/app`, platform: "linux" });
  const changed = (fake: Fake): boolean => fake.removed.length > 0 || fake.order.length > 0;

  it("refuses a tree with changes, and changes nothing", async () => {
    const fake = make();
    fake.add(`${tree}/node_modules/x.js`);
    fake.dirty.add(tree);
    const result = await remove(fake);
    expect(result).toMatchObject({ ok: false });
    expect(result.refused).toMatch(/changes that are not committed/);
    expect(changed(fake)).toBe(false);
    expect(fake.exists(`${tree}/node_modules/x.js`)).toBe(true);
  });

  it("refuses a tree with commits that are on no remote", async () => {
    const fake = make();
    fake.unpushed.set(tree, 1);
    expect((await remove(fake)).refused).toMatch(/1 commit that is not on a remote/);
    expect(changed(fake)).toBe(false);
  });

  it("refuses a locked tree, a path that git does not list, the main checkout and a path outside the roots", async () => {
    const locked = new Fake().repo("app", [{ path: tree, branch: "t", locked: true }]);
    expect((await remove(locked)).refused).toMatch(/locked/);
    const fake = make();
    fake.add(`${ROOT}/app-wt/unknown/src/a.ts`);
    expect((await remove(fake, `${ROOT}/app-wt/unknown`)).refused).toMatch(/does not list/);
    expect((await remove(fake, `${ROOT}/app`)).refused).toMatch(/main checkout/);
    expect((await remove(fake, "/tmp/elsewhere")).refused).toMatch(/outside the roots/);
    expect(changed(fake) || changed(locked)).toBe(false);
  });

  it("deletes each node_modules of a workspace before git, and does not follow a link", async () => {
    const fake = make();
    fake.add(`${tree}/node_modules/.pnpm/a/node_modules/a/index.js`);
    fake.add(`${tree}/packages/one/node_modules/b/index.js`);
    fake.add(`${tree}/packages/two/node_modules/c/index.js`);
    fake.add(`${tree}/packages/two/src/deep/lib/node_modules/d.js`);
    fake.add(`${tree}/packages/linked`, "link");
    fake.add(`${tree}/.git/node_modules`, "dir");
    expect(findNodeModules(tree, fake).map(key)).toEqual([
      `${tree}/node_modules`,
      `${tree}/packages/one/node_modules`,
      `${tree}/packages/two/node_modules`,
      `${tree}/packages/two/src/deep/lib/node_modules`,
    ]);
    const result = await remove(fake);
    expect(result.ok).toBe(true);
    expect(result.nodeModules).toHaveLength(4);
    const gitAt = fake.order.findIndex((step) => step.startsWith("git remove"));
    expect(gitAt).toBe(4);
    expect(fake.order.slice(0, 4).every((step) => step.startsWith("rm ") && step.endsWith("/node_modules"))).toBe(true);
    expect(fake.exists(tree)).toBe(false);
    expect(fake.forced()).toBe(false);
  });

  it("stops when git fails and still lists the tree, and keeps the folder", async () => {
    const fake = make();
    fake.removeMode = "refuse";
    const result = await remove(fake);
    expect(result.ok).toBe(false);
    expect(result.steps.join(" ")).toMatch(/still lists the tree/);
    expect(fake.exists(`${tree}/src/a.ts`)).toBe(true);
    expect(fake.removed.some((path) => path === key(tree))).toBe(false);
    expect(fake.forced()).toBe(false);
  });

  it("deletes the rest of the folder when git fails partway after it unregisters the tree", async () => {
    const fake = make();
    fake.add(`${tree}/packages/one/node_modules/b.js`);
    fake.removeMode = "partial";
    const result = await remove(fake);
    expect(result.steps.join(" ")).toMatch(/failed to delete/);
    expect(result.ok).toBe(true);
    expect(fake.removed.at(-1)).toBe(key(tree));
    expect(fake.exists(tree)).toBe(false);
  });

  it("changes nothing in a dry run", async () => {
    const fake = make();
    fake.add(`${tree}/node_modules/x.js`);
    const result = await removeWorktree(tree, { roots: [ROOT], mains: [`${ROOT}/app`], runner: fake, main: `${ROOT}/app`, platform: "linux", dryRun: true });
    expect(result.ok).toBe(true);
    expect(changed(fake)).toBe(false);
  });
});

describe("links into a tree (H223)", () => {
  const main = `${ROOT}/app`;
  const tree = `${ROOT}/app-wt/t`;
  const other = `${ROOT}/app-wt/o`;
  const make = (): Fake => new Fake().repo("app", [{ path: tree, branch: "t" }, { path: other, branch: "o" }]);
  const context = (fake: Fake) => ({ roots: [ROOT], mains: [main], runner: fake, main, platform: "linux" as const });
  const slashes = (text: string | null | undefined): string => (text ?? "").replace(/\\/g, "/");
  const vitest = `${tree}/node_modules/.pnpm/vitest@4/node_modules/vitest`;

  it("finds the checkouts of a repository from the files of git, from the main checkout and from inside a tree", () => {
    const fake = make();
    for (const from of [main, tree, `${tree}/src`]) expect(repoCheckouts(from, fake)?.checkouts.map(key)).toEqual([main, tree, other]);
    const found = repoCheckouts(`${tree}/src`, fake);
    expect([key(found?.top ?? ""), key(found?.main ?? "")]).toEqual([tree, main]);
    expect(repoCheckouts("/r/elsewhere/x", fake)).toBeNull();
  });

  it("holds the removal while a link of the main checkout points into the tree, names the link, and changes nothing", async () => {
    const fake = make();
    fake.link(`${main}/node_modules/vitest`, vitest);
    fake.link(`${main}/node_modules/@scope/core`, `${tree}/packages/core`);
    fake.add(`${vitest}/index.js`);
    const result = await removeWorktree(tree, context(fake));
    expect(result.ok).toBe(false);
    expect(slashes(result.refused)).toContain(`The link ${main}/node_modules/vitest in the checkout ${main} points to ${vitest}. A delete of ${tree} breaks it.`);
    expect(result.refused).toMatch(/1 other link also points/);
    expect(result.refused).toMatch(/Run the install of/);
    expect(fake.order).toEqual([]);
    expect(fake.removed).toEqual([]);
    expect(fake.exists(`${vitest}/index.js`)).toBe(true);
  });

  it("holds a dry run and the delete of the node_modules of the tree the same way", async () => {
    const fake = make();
    fake.link(`${main}/node_modules/vitest`, vitest);
    fake.add(`${vitest}/index.js`);
    expect((await removeWorktree(tree, { ...context(fake), dryRun: true })).refused).toMatch(/points to/);
    const modules = await removeNodeModules(tree, context(fake));
    expect(modules.refused).toMatch(/points to/);
    expect(modules.removed).toEqual([]);
    expect(fake.exists(`${vitest}/index.js`)).toBe(true);
  });

  it("lets the removal go on when the links of the other checkouts point into their own folders or elsewhere", async () => {
    const fake = make();
    fake.link(`${main}/node_modules/vitest`, `${main}/node_modules/.pnpm/vitest@4/node_modules/vitest`);
    fake.link(`${tree}/node_modules/vitest`, vitest);
    fake.link(`${other}/node_modules`, `${main}/node_modules`);
    const result = await removeWorktree(tree, context(fake));
    expect(result.ok).toBe(true);
    expect(result.steps.join(" ")).toMatch(/No link of another checkout points into the tree/);
    expect(fake.exists(tree)).toBe(false);
  });

  it("holds on a link that it cannot read, and on a node_modules of another checkout that is a link into the tree", async () => {
    const unreadable = make();
    unreadable.link(`${main}/node_modules/odd`, null);
    expect((await removeWorktree(tree, context(unreadable))).refused).toMatch(/cannot read the link/);
    const junction = make();
    junction.link(`${other}/node_modules`, `${tree}/node_modules`);
    const refused = (await removeWorktree(tree, context(junction))).refused;
    expect(slashes(refused)).toContain(`The link ${other}/node_modules in the checkout ${other} points to ${tree}/node_modules.`);
    expect(refused).toMatch(/Remove only the link/);
    expect(junction.order).toEqual([]);
  });

  it("skips the tree in the cleanup while a link points into it, and removes the other tree", async () => {
    const fake = make();
    fake.link(`${main}/node_modules/vitest`, vitest);
    const scan = await scanWorktrees(options(fake));
    const result = await cleanWorktrees(scan, { runner: fake, dryRun: false, platform: "linux", pauseMs: 0 });
    const held = result.actions.find((action) => key(action.path) === tree);
    expect(held).toMatchObject({ action: "skip" });
    expect(held?.detail).toMatch(/points to/);
    expect(fake.exists(tree)).toBe(true);
    expect(fake.exists(other)).toBe(false);
  });

  it("skips the delete of the node_modules of a keep tree while a link points into it, also in a dry run", async () => {
    for (const dryRun of [true, false]) {
      const fake = make();
      fake.dirty.add(tree);
      fake.add(`${vitest}/index.js`);
      fake.link(`${main}/node_modules/vitest`, vitest);
      const scan = await scanWorktrees(options(fake));
      const result = await cleanWorktrees(scan, { runner: fake, dryRun, platform: "linux", pauseMs: 0 });
      const held = result.actions.find((action) => key(action.path) === tree);
      expect(held).toMatchObject({ action: "skip" });
      expect(held?.detail).toMatch(/points to/);
      expect(fake.exists(`${vitest}/index.js`)).toBe(true);
    }
  });

  it("does not count the links inside the deleted folder or the links of its own checkout", () => {
    const links = [
      { checkout: tree, link: `${tree}/packages/a/node_modules/b`, target: `${tree}/node_modules/.pnpm/b` },
      { checkout: main, link: `${main}/node_modules/b`, target: `${tree}/node_modules/.pnpm/b` },
      { checkout: main, link: `${main}/node_modules/c`, target: `${main}/node_modules/.pnpm/c` },
    ];
    expect(linksInto(`${tree}/node_modules`, links, tree, "linux").map((link) => link.link)).toEqual([`${main}/node_modules/b`]);
    expect(linksInto(`${ROOT}/app-wt`, links, null, "linux").map((link) => link.link)).toEqual([`${main}/node_modules/b`]);
  });

  it("finds node_modules two folders deep and in the packages of the workspace, and skips a nested checkout", () => {
    const fake = new Fake().repo("app");
    fake.add(`${main}/pnpm-workspace.yaml`, "file", OLD, "packages:\n  - \"packages/*\"\n  - 'apps/*/libs/*'\n  - '!**/test/**'\nonlyBuiltDependencies:\n  - esbuild\n");
    fake.add(`${main}/node_modules/.pnpm/a/index.js`);
    fake.add(`${main}/packages/one/node_modules/b/index.js`);
    fake.add(`${main}/apps/web/libs/ui/node_modules/c/index.js`);
    fake.link(`${main}/packages/two/node_modules`, `${ROOT}/elsewhere/node_modules`);
    fake.add(`${main}/nested/.git`, "file", OLD, "gitdir: x\n").add(`${main}/nested/node_modules/d.js`);
    fake.add(`${main}/a/b/c/node_modules/e.js`);
    expect(moduleFolders(main, fake).map((folder) => `${key(folder.path)} ${folder.kind}`).sort()).toEqual(
      [`${main}/apps/web/libs/ui/node_modules dir`, `${main}/node_modules dir`, `${main}/packages/one/node_modules dir`, `${main}/packages/two/node_modules link`].sort(),
    );
  });

  it("reads the links at the top of node_modules and in its scopes, and not in .pnpm or .bin", () => {
    const fake = new Fake().repo("app");
    fake.link(`${main}/node_modules/a`, "/t/a");
    fake.link(`${main}/node_modules/@s/b`, "/t/b");
    fake.link(`${main}/node_modules/.pnpm/x/node_modules/y`, "/t/y");
    fake.link(`${main}/node_modules/.bin/z`, "/t/z");
    fake.add(`${main}/node_modules/plain/index.js`);
    expect(moduleLinks(main, fake).map((link) => `${key(link.link)} ${link.target}`).sort()).toEqual([`${main}/node_modules/@s/b /t/b`, `${main}/node_modules/a /t/a`]);
  });

  it("refuses an install whose node_modules, or its .pnpm store, is a link into another checkout, and names the link", () => {
    const shared = make();
    shared.link(`${tree}/node_modules`, `${main}/node_modules`);
    const refused = slashes(installLinkRefusal(tree, shared, "linux"));
    expect(refused).toContain(`The folder ${tree}/node_modules is a link to ${main}/node_modules, in the checkout ${main}.`);
    expect(refused).toContain(`A delete of ${tree} breaks them.`);
    expect(refused).toMatch(/Remove only the link/);
    expect(slashes(installLinkRefusal(`${tree}/packages/a`, shared, "linux"))).toContain(`${tree}/node_modules is a link`);
    const store = make();
    store.add(`${tree}/node_modules/.modules.yaml`).link(`${tree}/node_modules/.pnpm`, `${main}/node_modules/.pnpm`);
    expect(slashes(installLinkRefusal(tree, store, "linux"))).toContain(`The folder ${tree}/node_modules/.pnpm is a link to`);
    const workspace = make();
    workspace.add(`${tree}/pnpm-workspace.yaml`, "file", OLD, "packages:\n  - packages/*\n").link(`${tree}/packages/a/node_modules`, `${main}/packages/a/node_modules`);
    expect(slashes(installLinkRefusal(tree, workspace, "linux"))).toContain(`${tree}/packages/a/node_modules is a link`);
    const unreadable = make();
    unreadable.link(`${tree}/node_modules`, null);
    expect(installLinkRefusal(tree, unreadable, "linux")).toMatch(/cannot read the link/);
  });

  it("lets an install go on when its node_modules are folders, or links into its own checkout or outside each checkout", () => {
    const fake = make();
    fake.add(`${main}/node_modules/.pnpm/a/index.js`);
    fake.link(`${tree}/node_modules`, `${tree}/.cache/node_modules`);
    fake.link(`${other}/node_modules`, "/r/cache/node_modules");
    expect(installLinkRefusal(main, fake, "linux")).toBeNull();
    expect(installLinkRefusal(tree, fake, "linux")).toBeNull();
    expect(installLinkRefusal(other, fake, "linux")).toBeNull();
    expect(installLinkRefusal("/r/elsewhere", fake, "linux")).toBeNull();
  });

  it("keeps the links of a checkout until a node_modules or scope folder changes, or the entry gets old", () => {
    const fake = make();
    fake.link(`${main}/node_modules/a`, "/t/a").link(`${main}/node_modules/@s/b`, "/t/b");
    let reads = 0;
    const read = fake.readLink.bind(fake);
    fake.readLink = (path: string): string | null => {
      reads += 1;
      return read(path);
    };
    let now = NOW;
    const cache = new LinkCache(fake, () => now, 1_000);
    expect(cache.cached(main)).toBeNull();
    expect(cache.links(main)).toHaveLength(2);
    expect(cache.links(main)).toHaveLength(2);
    expect(reads).toBe(2);
    (fake.nodes.get(key(`${main}/node_modules/@s`)) as { mtimeMs: number }).mtimeMs = FRESH;
    cache.links(main);
    expect(reads).toBe(4);
    (fake.nodes.get(key(`${main}/node_modules`)) as { mtimeMs: number }).mtimeMs = FRESH + 1;
    cache.links(main);
    expect(reads).toBe(6);
    now += 1_001;
    expect(cache.cached(main)).toBeNull();
    cache.links(main);
    expect(reads).toBe(8);
  });

  it("reads the target of a real junction or symbolic link, also when the target is gone", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "headroom-link-")));
    try {
      const target = join(base, "store", "pkg");
      mkdirSync(target, { recursive: true });
      const link = join(base, "pkg");
      symlinkSync(target, link, "junction");
      const runner = nodeRunner();
      expect(runner.entries(base)?.find((entry) => entry.name === "pkg")?.kind).toBe("link");
      expect(samePath(runner.readLink(link) ?? "", target)).toBe(true);
      rmSync(target, { recursive: true });
      expect(samePath(runner.readLink(link) ?? "", target)).toBe(true);
      expect(runner.readLink(base)).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("cleanWorktrees", () => {
  const build = (): Fake => {
    const fake = new Fake().repo("app", [
      { path: `${ROOT}/app-wt/done`, branch: "done" },
      { path: `${ROOT}/app-wt/busy`, branch: "busy" },
      { path: `${ROOT}/app-wt/dirty`, branch: "dirty" },
      { path: `${ROOT}/app-wt/gone1`, branch: "gone1", prunable: true },
      { path: `${ROOT}/app-wt/gone2`, branch: "gone2", prunable: true },
      { path: "/elsewhere/app-x", branch: "x" },
    ]);
    for (const name of ["done", "busy", "dirty"]) fake.add(`${ROOT}/app-wt/${name}/node_modules/x.js`);
    fake.add(`${ROOT}/app-wt/busy/notes.md`, "file", FRESH);
    fake.dirty.add(`${ROOT}/app-wt/dirty`);
    fake.add("/elsewhere/app-x/.git", "file", OLD, "gitdir: /r/git/app/.git/worktrees/app-x\n").add("/elsewhere/app-x/node_modules/y.js");
    fake.add(`${ROOT}/app-a13-packing/src/work.ts`).add(`${ROOT}/app-a13-packing/node_modules/z.js`);
    fake.add(`${ROOT}/app-wt/left/src/work.ts`).add(`${ROOT}/app-wt/left/node_modules/z.js`);
    return fake;
  };

  it("removes a removable tree, deletes only node_modules of a keep tree, prunes each main once, and leaves the rest", async () => {
    const fake = build();
    const scan = await scanWorktrees(options(fake));
    const result = await cleanWorktrees(scan, { runner: fake, dryRun: false, platform: "linux", pauseMs: 0 });
    expect(fake.exists(`${ROOT}/app-wt/done`)).toBe(false);
    expect(fake.exists(`${ROOT}/app-wt/dirty/src/a.ts`)).toBe(true);
    expect(fake.exists(`${ROOT}/app-wt/dirty/node_modules`)).toBe(false);
    expect(fake.exists(`${ROOT}/app-wt/busy/node_modules/x.js`)).toBe(true);
    expect(fake.exists("/elsewhere/app-x/node_modules/y.js")).toBe(true);
    expect(fake.order.filter((step) => step.startsWith("prune"))).toHaveLength(1);
    expect(result.actions.find((action) => action.path === "/elsewhere/app-x")?.action).toBe("skip");
    expect(fake.forced()).toBe(false);
  });

  it("never touches an orphan", async () => {
    const fake = build();
    const scan = await scanWorktrees(options(fake));
    expect(scan.orphans).toHaveLength(2);
    await cleanWorktrees(scan, { runner: fake, dryRun: false, platform: "linux", pauseMs: 0 });
    for (const orphan of [`${ROOT}/app-a13-packing`, `${ROOT}/app-wt/left`]) {
      expect(fake.exists(`${orphan}/src/work.ts`)).toBe(true);
      expect(fake.exists(`${orphan}/node_modules/z.js`)).toBe(true);
      expect(fake.removed.some((path) => path === key(orphan) || path.startsWith(`${key(orphan)}/`))).toBe(false);
    }
  });

  it("changes nothing in a dry run", async () => {
    const fake = build();
    const scan = await scanWorktrees(options(fake));
    const result = await cleanWorktrees(scan, { runner: fake, dryRun: true, platform: "linux" });
    expect(fake.removed).toEqual([]);
    expect(fake.order).toEqual([]);
    expect(result.actions.map((action) => action.action).sort()).toEqual(["node_modules", "prune", "remove", "skip"]);
  });
});

describe("cleanWorktrees in batches", () => {
  const trees = (count: number): Fake => {
    const fake = new Fake().repo(
      "app",
      Array.from({ length: count }, (_, index) => ({ path: `${ROOT}/app-wt/t${index}`, branch: `t${index}` })),
    );
    for (let index = 0; index < count; index++) fake.add(`${ROOT}/app-wt/t${index}/node_modules/x.js`);
    return fake;
  };
  const left = (fake: Fake, count: number): number => Array.from({ length: count }, (_, index) => `${ROOT}/app-wt/t${index}`).filter((path) => fake.exists(path)).length;

  it("changes at most max trees in a run, pauses between two trees, and the next runs take the rest", async () => {
    const fake = trees(5);
    const pauses: number[] = [];
    const sleep = async (ms: number): Promise<void> => void pauses.push(ms);
    const run = async () => cleanWorktrees(await scanWorktrees(options(fake)), { runner: fake, dryRun: false, platform: "linux", max: 2, pauseMs: 5000, sleep });
    const first = await run();
    expect(first.stopped).toBe("max");
    expect(first.remaining).toBe(3);
    expect(first.actions.filter((action) => action.action === "remove" && action.ok)).toHaveLength(2);
    expect(left(fake, 5)).toBe(3);
    expect(pauses).toEqual([5000]);
    expect((await run()).remaining).toBe(1);
    const last = await run();
    expect(last.stopped).toBeNull();
    expect(last.remaining).toBe(0);
    expect(left(fake, 5)).toBe(0);
    expect(fake.forced()).toBe(false);
  });

  it("stops before a tree when less memory than the floor is available, and changes nothing more", async () => {
    const fake = trees(4);
    const readings = [3000, 2500, 1500, 3000];
    const availableMb = (): number | null => readings.shift() ?? null;
    const result = await cleanWorktrees(await scanWorktrees(options(fake)), { runner: fake, dryRun: false, platform: "linux", minFreeMb: 2048, availableMb, pauseMs: 0 });
    expect(result.stopped).toBe("memory");
    expect(result.availableMb).toBe(1500);
    expect(result.remaining).toBe(2);
    expect(left(fake, 4)).toBe(2);
    expect(readings).toEqual([3000]);
  });

  it("changes nothing when the memory is under the floor at the start, and a dry run gives the whole plan", async () => {
    const fake = trees(3);
    const low = await cleanWorktrees(await scanWorktrees(options(fake)), { runner: fake, dryRun: false, platform: "linux", availableMb: () => 900, pauseMs: 0 });
    expect(low.stopped).toBe("memory");
    expect(low.remaining).toBe(3);
    expect(fake.removed).toEqual([]);
    expect(fake.order).toEqual([]);
    const plan = await cleanWorktrees(await scanWorktrees(options(fake)), { runner: fake, dryRun: true, platform: "linux", max: 1, availableMb: () => 900 });
    expect(plan.stopped).toBeNull();
    expect(plan.actions.filter((action) => action.action === "remove")).toHaveLength(3);
    expect(fake.removed).toEqual([]);
  });
});

describe("summarize, keepAlert and cleanDue", () => {
  it("counts each state of each repository, and alerts above 100 keep trees with the top repositories", async () => {
    const trees = Array.from({ length: 101 }, (_, index) => ({ path: `${ROOT}/${index % 2 === 0 ? "big" : "small"}-wt/t${index}`, branch: `t${index}` }));
    const fake = new Fake().repo("big", trees.filter((tree) => tree.path.includes("big-"))).repo("small", trees.filter((tree) => tree.path.includes("small-")));
    for (const tree of trees) fake.dirty.add(tree.path);
    const summary = summarize(await scanWorktrees(options(fake)));
    expect(summary.counts.keep).toBe(101);
    expect(summary.repos.map((row) => [row.repo, row.counts.keep])).toEqual([["big", 51], ["small", 50]]);
    expect(keepAlert(summary)?.message).toMatch(/^101 idle worktrees .* Most: big 51, small 50\./);
    expect(keepAlert({ ...summary, counts: { ...summary.counts, keep: 100 } })).toBeNull();
  });

  it("runs the cleanup each day, and after 1 hour on low free space", () => {
    expect(cleanDue(NOW, null, false)).toBe("daily");
    expect(cleanDue(NOW, NOW - WORKTREE_CLEAN_EVERY_MS, false)).toBe("daily");
    expect(cleanDue(NOW, NOW - 30 * 60_000, true)).toBeNull();
    expect(cleanDue(NOW, NOW - 61 * 60_000, true)).toBe("low-space");
    expect(cleanDue(NOW, NOW - 61 * 60_000, false)).toBeNull();
    expect(cleanDue(NOW, NOW - 5 * 60_000, false, true)).toBe("batch");
  });
});

/** The real git test needs git. It uses no global or system git settings. */
const hasGit = ((): boolean => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)("a real git repository", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "headroom-wt-")));
  const empty = join(base, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }));

  it("removes a clean tree with nested node_modules, and refuses a tree with changes", async () => {
    const root = join(base, "git");
    mkdirSync(root);
    git(base, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(base, "clone", "-q", join(base, "origin.git"), join(root, "app"));
    const app = join(root, "app");
    writeFileSync(join(app, ".gitignore"), "node_modules\n");
    writeFileSync(join(app, "a.txt"), "a\n");
    git(app, "add", ".");
    git(app, "commit", "-q", "-m", "first");
    git(app, "push", "-q", "origin", "HEAD:main");
    const clean = join(root, "app-wt", "clean");
    const dirty = join(root, "app-wt", "dirty");
    git(app, "worktree", "add", "-q", "-b", "clean", clean);
    git(app, "worktree", "add", "-q", "-b", "dirty", dirty);
    mkdirSync(join(clean, "packages", "one", "node_modules", "x"), { recursive: true });
    writeFileSync(join(clean, "packages", "one", "node_modules", "x", "index.js"), "");
    mkdirSync(join(clean, "node_modules"));
    writeFileSync(join(dirty, "a.txt"), "changed\n");
    const old = new Date(OLD);
    for (const path of [clean, dirty]) for (const name of ["a.txt", ".gitignore", ".git", "packages"]) if (existsSync(join(path, name))) utimesSync(join(path, name), old, old);
    const runner = nodeRunner({ env });
    const scan = await scanWorktrees({ roots: [root], runner, now: Date.now() + 2 * 86_400_000 });
    const states = Object.fromEntries(scan.trees.map((tree) => [pathKey(tree.path).split("/").pop(), tree.state]));
    expect(states).toEqual({ clean: "removable", dirty: "keep" });
    const context = { roots: [root], mains: scan.mains, runner, main: app };
    expect((await removeWorktree(dirty, context)).refused).toMatch(/changes that are not committed/);
    const result = await removeWorktree(clean, context);
    expect(result.ok).toBe(true);
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(join(dirty, "a.txt"))).toBe(true);
    expect(git(app, "branch", "--list", "clean").trim()).toMatch(/clean/);
  });
});

describe("trimEndSlashes", () => {
  it("removes the slashes and backslashes at the end, and keeps the others", () => {
    expect(trimEndSlashes("a/b//")).toBe("a/b");
    expect(trimEndSlashes(String.raw`C:\x\y\/\ `.trimEnd())).toBe(String.raw`C:\x\y`);
    expect(trimEndSlashes("a//b")).toBe("a//b");
    expect(trimEndSlashes("///")).toBe("");
    expect(trimEndSlashes("")).toBe("");
  });

  it("gives the same key as before for a path with a slash at the end", () => {
    expect(pathKey(String.raw`D:\git\x\ `.trimEnd(), "win32")).toBe("d:/git/x");
    expect(pathKey("/home/x//", "linux")).toBe("/home/x");
  });

  // CodeQL js/polynomial-redos: the expression `/[\\/]+$/` takes a time of the square of the length on this input.
  it("ends on many slashes that are not at the end", () => {
    const path = `${"/".repeat(200_000)}x`;
    expect(trimEndSlashes(path)).toBe(path);
  });
});
