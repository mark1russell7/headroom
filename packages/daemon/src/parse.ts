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

/** This function reads a time: `30s`, `10m`, `2h` or a count of milliseconds. It gives milliseconds. */
export function parseTime(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(text.trim());
  if (!match?.[1]) throw new Error(`Not a time: ${text}. Use for example 30s, 10m or 2h.`);
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(Number(match[1]) * (units[(match[2] ?? "ms").toLowerCase()] ?? 1));
}
