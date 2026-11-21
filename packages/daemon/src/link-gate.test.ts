import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { deleteTargets, installFolder, LinkGate } from "./link-gate.ts";
import { commandParts } from "./native-paths.ts";

const home = resolve("/home/u");
const here = resolve("/r/app-wt/t");

describe("the commands that the gate of links reads (H223)", () => {
  const installs = (command: string, cwd: string | null = here): (string | null | undefined)[] => commandParts(command, cwd, home).map(installFolder);
  const deletes = (command: string, cwd: string | null = here) => commandParts(command, cwd, home).map((part) => deleteTargets(part, home));

  it("finds the folder of each install of pnpm, npm, yarn and bun, also with a folder option or a wrapper", () => {
    expect(installs("pnpm install")).toEqual([here]);
    expect(installs("pnpm -C sub i --frozen-lockfile")).toEqual([resolve(here, "sub")]);
    expect(installs("pnpm --filter app add zod")).toEqual([here]);
    expect(installs("npm ci --prefix=/r/other")).toEqual([resolve("/r/other")]);
    expect(installs("npm -w pkg install")).toEqual([here]);
    expect(installs("npx pnpm@9.1.0 install")).toEqual([here]);
    expect(installs("corepack pnpm add left-pad")).toEqual([here]);
    expect(installs("yarn")).toEqual([here]);
    expect(installs("yarn --cwd ../x add y")).toEqual([resolve(here, "../x")]);
    expect(installs("bun install")).toEqual([here]);
    expect(installs("cd sub && pnpm install")).toEqual([resolve(here, "sub")]);
    expect(installs('bash -c "cd ../m && pnpm i"')).toEqual([resolve(here, "../m")]);
    expect(installs("pnpm install", null)).toEqual([null]);
  });

  it("does not take a run, an exec, a global install or the bare command of pnpm as an install", () => {
    expect(installs("pnpm run build")).toEqual([undefined]);
    expect(installs("pnpm exec vitest run")).toEqual([undefined]);
    expect(installs("pnpm")).toEqual([undefined]);
    expect(installs("npm install -g npm")).toEqual([undefined]);
    expect(installs("pnpm add --global tsx")).toEqual([undefined]);
    expect(installs("node scripts/install.ts")).toEqual([undefined]);
    expect(installs("git status")).toEqual([undefined]);
  });

  it("finds the folders of git worktree remove and of each recursive delete", () => {
    expect(deletes("git worktree remove ../u")).toEqual([{ kind: "worktree", paths: [resolve(here, "../u")] }]);
    expect(deletes("git -C /r/app worktree remove --force ../app-wt/t")).toEqual([{ kind: "worktree", paths: [resolve("/r/app", "../app-wt/t")] }]);
    expect(deletes("rm -rf node_modules dist")).toEqual([{ kind: "shell", paths: [resolve(here, "node_modules"), resolve(here, "dist")] }]);
    expect(deletes("rm -r -- build")).toEqual([{ kind: "shell", paths: [resolve(here, "build")] }]);
    expect(deletes("Remove-Item -Recurse -Force node_modules")).toEqual([{ kind: "shell", paths: [resolve(here, "node_modules")] }]);
    expect(deletes("Remove-Item -Path a,b -Recurse -Include *.js")).toEqual([{ kind: "shell", paths: [resolve(here, "a"), resolve(here, "b")] }]);
    expect(deletes("ri x -r")).toEqual([{ kind: "shell", paths: [resolve(here, "x")] }]);
    expect(deletes('cmd /c "rmdir /s /q node_modules"')).toEqual([{ kind: "cmd", paths: [resolve(here, "node_modules")] }]);
    expect(deletes("npx rimraf dist")).toEqual([{ kind: "shell", paths: [resolve(here, "dist")] }]);
    expect(deletes("rm -rf build/*")).toEqual([{ kind: "shell", paths: [] }]);
  });

  it("does not take a delete of a file, a delete with no recursion, or another git command as a delete of a folder", () => {
    expect(deletes("rm notes.txt")).toEqual([undefined]);
    expect(deletes("rm -f notes.txt")).toEqual([undefined]);
    expect(deletes("Remove-Item -Force notes.txt")).toEqual([undefined]);
    expect(deletes("rmdir empty")).toEqual([undefined]);
    expect(deletes("git worktree list")).toEqual([undefined]);
    expect(deletes("git rm -r src/old")).toEqual([undefined]);
  });
});

describe("the gate of links between checkouts (H223)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "headroom-link-gate-")));
  afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 3 }));

  /** This function makes a main checkout and one linked worktree, with the files of git that the gate reads. */
  const repo = (name: string): { main: string; tree: string } => {
    const main = join(base, name);
    const tree = join(base, `${name}-wt`, "t");
    const gitDir = join(main, ".git", "worktrees", "t");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "gitdir"), `${join(tree, ".git")}\n`);
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    mkdirSync(join(main, "node_modules"), { recursive: true });
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, ".git"), `gitdir: ${gitDir}\n`);
    return { main, tree };
  };
  const junction = (target: string, path: string): void => {
    mkdirSync(target, { recursive: true });
    symlinkSync(target, path, "junction");
  };

  it("refuses an install in a worktree whose node_modules is a link to the node_modules of the main checkout", async () => {
    const { main, tree } = repo("install");
    junction(join(main, "node_modules"), join(tree, "node_modules"));
    const gate = new LinkGate({ home });
    const refused = await gate.refusal("pnpm install --frozen-lockfile", tree);
    expect(refused).toContain(`The folder ${join(tree, "node_modules")} is a link to`);
    expect(refused).toContain(`in the checkout ${main}.`);
    expect(refused).toMatch(/Remove only the link/);
    expect(await gate.refusal(`pnpm -C ${tree} add zod`, main)).toContain("is a link to");
    expect(await gate.refusal("pnpm install", main)).toBeNull();
    expect(await gate.refusal("pnpm run build", tree)).toBeNull();
  });

  it("refuses the removal of a worktree and the delete of its node_modules while a link of the main checkout points into them", async () => {
    const { main, tree } = repo("remove");
    junction(join(tree, "node_modules", ".pnpm", "pkg@1", "node_modules", "pkg"), join(main, "node_modules", "pkg"));
    mkdirSync(join(tree, "dist"), { recursive: true });
    const gate = new LinkGate({ home });
    const refused = await gate.refusal(`git worktree remove ${tree}`, main);
    expect(refused).toContain(`The link ${join(main, "node_modules", "pkg")} in the checkout ${main} points to`);
    expect(refused).toContain(`A delete of ${tree} breaks it.`);
    expect(await gate.refusal("rm -rf node_modules", tree)).toContain("points to");
    expect(await gate.refusal(`Remove-Item -Recurse -Force ${tree}`, main)).toContain("points to");
    expect(await gate.refusal("rm -rf dist", tree)).toBeNull();
    expect(await gate.refusal("rm -rf src", tree)).toBeNull();
  });

  it("lets the removal of a worktree go on when no link of another checkout points into it", async () => {
    const { main, tree } = repo("clean");
    junction(join(main, "node_modules", ".pnpm", "pkg@1", "node_modules", "pkg"), join(main, "node_modules", "pkg"));
    junction(join(tree, "node_modules", ".pnpm", "pkg@1", "node_modules", "pkg"), join(tree, "node_modules", "pkg"));
    const gate = new LinkGate({ home });
    expect(await gate.refusal(`git worktree remove ${tree}`, main)).toBeNull();
    expect(await gate.refusal(`rm -rf ${tree}`, main)).toBeNull();
    const loose = join(base, "loose", "node_modules");
    mkdirSync(loose, { recursive: true });
    expect(await gate.refusal(`rm -rf ${loose}`, base)).toBeNull();
  });

  it("refuses a recursive delete of a link into another checkout, and gives the delete of only the link", async () => {
    const { main, tree } = repo("link");
    junction(join(main, "node_modules"), join(tree, "node_modules"));
    const gate = new LinkGate({ home });
    const refused = await gate.refusal("Remove-Item -Recurse -Force node_modules", tree);
    expect(refused).toContain(`${join(tree, "node_modules")} is a link to`);
    expect(refused).toContain(`cmd /c rmdir "${join(tree, "node_modules")}", with no /s`);
    expect(await gate.refusal('cmd /c "rmdir /s /q node_modules"', tree)).toContain("is a link to");
  });

  it("refuses when the read of the links passes its time, reads on in the daemon, and then answers from the cache", async () => {
    const { main, tree } = repo("budget");
    junction(join(tree, "node_modules", ".pnpm", "pkg"), join(main, "node_modules", "pkg"));
    let tick = 0;
    const gate = new LinkGate({ home, budgetMs: 0, now: () => (tick += 1) });
    expect(await gate.refusal(`git worktree remove ${tree}`, main)).toMatch(/did not read the links of 1 of the 1 other checkouts .* in time/);
    for (let turn = 0; turn < 100 && gate.reading(main); turn++) await new Promise((done) => setImmediate(done));
    expect(gate.reading(main)).toBe(false);
    expect(await gate.refusal(`git worktree remove ${tree}`, main)).toContain(`The link ${join(main, "node_modules", "pkg")} in the checkout ${main} points to`);
  });
});
