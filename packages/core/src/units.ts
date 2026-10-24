/**
 * The text of the amounts in the messages of headroom.
 */

/** This function gives an amount in MB as GB with one decimal, for example "15.6 GB". */
export function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** This function gives a size of a drive as text: "512 MB" below 1 GB, "4.2 GB" below 100 GB, and "952 GB" above. */
export function diskSize(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gigabytes = mb / 1024;
  return gigabytes < 100 ? `${Number(gigabytes.toFixed(1))} GB` : `${Math.round(gigabytes)} GB`;
}
