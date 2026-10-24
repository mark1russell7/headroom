/**
 * The parsers of the `headroom` command line.
 */

/** This function reads a memory amount: `2g`, `1500m` or `1500` (MB). It gives MB. */
export function parseMemory(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([gm]?)b?$/i.exec(text.trim());
  if (!match?.[1]) throw new Error(`Not a memory amount: ${text}. Use for example 2g or 1500m.`);
  const value = Number(match[1]);
  return Math.round(match[2]?.toLowerCase() === "g" ? value * 1024 : value);
}

/** A disk amount of `headroom run --disk`: the drive, or `null` for the drive of the current folder, and the MB. */
export interface DiskAmount {
  readonly mount: string | null;
  readonly mb: number;
}

/** This function writes a Windows drive in one form: `d`, `d:` and `D:\` give `D:`. A Linux mount point stays as it is. */
export function normalizeMount(text: string): string {
  const drive = /^([a-z]):?[\\/]?$/i.exec(text.trim());
  return drive?.[1] ? `${drive[1].toUpperCase()}:` : text.trim();
}

/** This function reads a disk amount: `5g` for the drive of the current folder, or `D:=5g` for a named drive. */
export function parseDisk(text: string): DiskAmount {
  const at = text.lastIndexOf("=");
  const size = at < 0 ? text : text.slice(at + 1);
  const mount = at < 0 ? null : normalizeMount(text.slice(0, at));
  if (mount === "" || !/^\s*\d+(?:\.\d+)?\s*[gm]?b?\s*$/i.test(size)) {
    throw new Error(`Not a disk amount: ${text}. Use for example 5g, or D:=5g for the drive D:.`);
  }
  return { mount, mb: parseMemory(size) };
}

/**
 * This function gives the drive of a path. On Windows, it is the drive letter, for example `D:`. On Linux, it is the
 * longest mount point that contains the path. It gives `null` when no drive contains the path, for example a network path.
 */
export function mountOf(path: string, mounts: readonly string[], platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") {
    const drive = /^([a-z]):/i.exec(path);
    return drive?.[1] ? `${drive[1].toUpperCase()}:` : null;
  }
  const inside = mounts.filter((mount) => mount === "/" || path === mount || path.startsWith(`${mount}/`));
  return inside.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** This function reads a time: `30s`, `10m`, `2h` or a count of milliseconds. It gives milliseconds. */
export function parseTime(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(text.trim());
  if (!match?.[1]) throw new Error(`Not a time: ${text}. Use for example 30s, 10m or 2h.`);
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(Number(match[1]) * (units[(match[2] ?? "ms").toLowerCase()] ?? 1));
}
