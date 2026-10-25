/**
 * The walk of a folder for the disk report and the cleanup (H21).
 *
 * - The walk reads each folder with `opendir` and each file with `lstat`. It does not follow a symbolic link, a junction or
 *   another reparse point. Thus it counts no file two times, and it cannot go in a loop.
 * - A file with more than one hard link counts one time for each set of walks that share `seen`.
 * - The walk stops at its deadline. Then its result is partial, and its sizes are lower limits.
 * - A `Walker` can continue a partial walk later from the same entry. Thus the report gives the time that is left to the large places.
 */

import { lstat, opendir } from "node:fs/promises";
import type { BigIntStats, Dir } from "node:fs";
import { join } from "node:path";

/** The count of folders that a walk reads at the same time. The thread pool of Node has 4 threads. */
const PARALLEL = 4;

/** The options of a walker. */
export interface WalkerOptions {
  /** The keys of the files with more than one link that a walk already counted. Walks that share it count each file one time. */
  readonly seen?: Set<string> | undefined;
  /** The depth of the folders whose sizes the walk keeps, for the deep report. 0 keeps none. */
  readonly depth?: number | undefined;
  /** The clock. The tests replace it. */
  readonly now?: (() => number) | undefined;
  /** The count of folders that the walk reads at the same time. */
  readonly parallel?: number | undefined;
}

/** The options of one walk. */
export interface WalkOptions extends WalkerOptions {
  /** The time in ms since the epoch at which the walk stops. */
  readonly deadline: number;
}

/** The result of a walk. */
export interface WalkResult {
  readonly path: string;
  /** False when the path does not exist, or when it is a link. */
  readonly exists: boolean;
  readonly bytes: number;
  readonly files: number;
  readonly folders: number;
  /** The links, the junctions and the other reparse points that the walk did not follow. */
  readonly links: number;
  /** The folders and the files that the walk could not read. */
  readonly errors: number;
  /** True when the deadline came before the end. Then each size is a lower limit. */
  readonly partial: boolean;
  /** The newest time of change of a file or a folder, in ms since the epoch. It is 0 for nothing. */
  readonly newestMs: number;
  /** The bytes of the files with one link. The pnpm store counts these files as unused. */
  readonly oneLinkBytes: number;
  /** The size of each folder to the depth of the options, in bytes. */
  readonly folderBytes: ReadonlyMap<string, number>;
}

/** One folder that waits for the walk. `owners` are the folders to the depth of the options that contain it. */
interface Item {
  readonly path: string;
  readonly depth: number;
  readonly owners: readonly string[];
}

/** One folder that the walk reads. A folder that the deadline stopped keeps its open handle, so the next run continues it. */
interface Task {
  readonly item: Item;
  readonly dir: Dir | null;
}

/** This function gives the data of a path without a link that it follows, or `null` when the path cannot be read. */
async function lstatOf(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch {
    return null;
  }
}

/** This function closes a folder handle. A handle that is already closed is not an error. */
async function closeDir(dir: Dir): Promise<void> {
  try {
    await dir.close();
  } catch {
    // The handle is already closed.
  }
}

/**
 * A walk of one folder that can stop at a deadline and continue later. `run()` continues the walk until the next deadline.
 * `close()` closes the handles of the folders that a deadline stopped.
 */
export class Walker {
  readonly #root: string;
  readonly #seen: Set<string>;
  readonly #depth: number;
  readonly #parallel: number;
  readonly #now: () => number;
  #started = false;
  #done = false;
  #exists = false;
  #queue: Item[] = [];
  #paused: Task[] = [];
  #bytes = 0;
  #files = 0;
  #folders = 0;
  #links = 0;
  #errors = 0;
  #newest = 0;
  #oneLink = 0;
  readonly #folderBytes = new Map<string, number>();

  constructor(root: string, options: WalkerOptions = {}) {
    this.#root = root;
    this.#seen = options.seen ?? new Set<string>();
    this.#depth = options.depth ?? 0;
    this.#parallel = Math.max(1, options.parallel ?? PARALLEL);
    this.#now = options.now ?? Date.now;
  }

  /** True when the walk read each entry. */
  get done(): boolean {
    return this.#done;
  }

  /** This function continues the walk until the deadline or the end, and gives the result so far. */
  async run(deadline: number): Promise<WalkResult> {
    if (!this.#started) await this.#start();
    if (!this.#done) await this.#pump(deadline);
    return this.result();
  }

  /** This function gives the result so far. */
  result(): WalkResult {
    return {
      path: this.#root,
      exists: this.#exists,
      bytes: this.#bytes,
      files: this.#files,
      folders: this.#folders,
      links: this.#links,
      errors: this.#errors,
      partial: !this.#done,
      newestMs: this.#newest,
      oneLinkBytes: this.#oneLink,
      folderBytes: this.#folderBytes,
    };
  }

  /** This function closes the handles of the folders that a deadline stopped. The walk then cannot continue. */
  async close(): Promise<void> {
    const paused = this.#paused;
    this.#paused = [];
    for (const task of paused) if (task.dir !== null) await closeDir(task.dir);
  }

  #touch(stats: BigIntStats): void {
    const changed = Number(stats.mtimeMs);
    if (changed > this.#newest) this.#newest = changed;
  }

  #count(stats: BigIntStats, owners: readonly string[]): void {
    this.#touch(stats);
    this.#files++;
    const size = Number(stats.size);
    if (stats.nlink > 1n) {
      const key = `${stats.dev}:${stats.ino}`;
      if (this.#seen.has(key)) return;
      this.#seen.add(key);
    } else {
      this.#oneLink += size;
    }
    this.#bytes += size;
    for (const owner of owners) this.#folderBytes.set(owner, (this.#folderBytes.get(owner) ?? 0) + size);
  }

  async #start(): Promise<void> {
    this.#started = true;
    const stats = await lstatOf(this.#root);
    if (stats === null || stats.isSymbolicLink()) {
      if (stats !== null) this.#links = 1;
      this.#done = true;
      return;
    }
    this.#exists = true;
    if (!stats.isDirectory()) {
      if (stats.isFile()) this.#count(stats, []);
      this.#done = true;
      return;
    }
    this.#touch(stats);
    this.#folders = 1;
    this.#queue.push({ path: this.#root, depth: 0, owners: [] });
  }

  async #pump(deadline: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let active = 0;
      const next = (): Task | undefined => {
        const paused = this.#paused.shift();
        if (paused !== undefined) return paused;
        const item = this.#queue.pop();
        return item === undefined ? undefined : { item, dir: null };
      };
      const pump = (): void => {
        while (active < this.#parallel && this.#now() < deadline) {
          const task = next();
          if (task === undefined) break;
          active++;
          void this.#read(task, deadline).finally(() => {
            active--;
            pump();
          });
        }
        if (active === 0) resolve();
      };
      pump();
    });
    if (this.#queue.length === 0 && this.#paused.length === 0) this.#done = true;
  }

  /** This function reads one folder until its end or the deadline. At the deadline, the folder waits with its open handle. */
  async #read(task: Task, deadline: number): Promise<void> {
    const { item } = task;
    let dir = task.dir;
    if (dir === null) {
      if (item.depth > 0) {
        // The folder can change to a junction after the read of its parent.
        const stats = await lstatOf(item.path);
        if (stats === null) {
          this.#errors++;
          return;
        }
        if (stats.isSymbolicLink()) {
          this.#links++;
          return;
        }
        this.#touch(stats);
      }
      try {
        dir = await opendir(item.path, { bufferSize: 64 });
      } catch {
        this.#errors++;
        return;
      }
    }
    try {
      for (;;) {
        if (this.#now() >= deadline) {
          this.#paused.push({ item, dir });
          return;
        }
        const entry = await dir.read();
        if (entry === null) break;
        const path = join(item.path, entry.name);
        // On Windows, each reparse point is a link here: a symbolic link, a junction or a placeholder of a cloud file.
        if (entry.isSymbolicLink()) {
          this.#links++;
          continue;
        }
        if (entry.isDirectory()) {
          this.#folders++;
          const depth = item.depth + 1;
          this.#queue.push({ path, depth, owners: depth <= this.#depth ? [...item.owners, path] : item.owners });
          continue;
        }
        if (!entry.isFile()) continue;
        const stats = await lstatOf(path);
        if (stats === null) this.#errors++;
        else if (stats.isSymbolicLink()) this.#links++;
        else if (stats.isFile()) this.#count(stats, item.owners);
      }
    } catch {
      this.#errors++;
    }
    await closeDir(dir);
  }
}

/** This function walks a folder, or sizes one file, until the deadline of the options. */
export async function walk(root: string, options: WalkOptions): Promise<WalkResult> {
  const walker = new Walker(root, options);
  try {
    return await walker.run(options.deadline);
  } finally {
    await walker.close();
  }
}
