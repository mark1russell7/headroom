/**
 * The timeline of the leases. Each lease has one lane on a window of the simulated clock. The lane shows the wait in the
 * queue and the time under the lease.
 */

import type { Row, View } from "./sim.ts";
import { escapeAttribute as escape } from "@mark1russell7/text";

/** The length of the window of the timeline, in simulated seconds. */
export const WINDOW_SECONDS = 180;

/** The most lanes that the timeline shows. The newest leases stay. */
export const MAX_LANES = 12;

/** One segment of a lane, in percent of the window. */
export interface Segment {
  readonly kind: "wait" | "run";
  readonly left: number;
  readonly width: number;
}

/** This function gives the window of a time: its start and its end, in seconds. The window starts at 0 until the clock passes its length. */
export function windowOf(now: number): { readonly start: number; readonly end: number } {
  const end = Math.max(WINDOW_SECONDS, now);
  return { start: end - WINDOW_SECONDS, end };
}

/** This function gives the segments of one lease in a window. A part outside the window is cut off. */
export function segmentsOf(row: Row, now: number, start: number, end: number): Segment[] {
  const span = end - start;
  const at = (seconds: number): number => ((Math.min(end, Math.max(start, seconds)) - start) / span) * 100;
  const segments: Segment[] = [];
  const waitEnd = row.grantedAt ?? row.endedAt ?? now;
  if (waitEnd > row.requestedAt) segments.push({ kind: "wait", left: at(row.requestedAt), width: at(waitEnd) - at(row.requestedAt) });
  if (row.grantedAt !== null) {
    const runEnd = row.endedAt ?? now;
    segments.push({ kind: "run", left: at(row.grantedAt), width: Math.max(0.6, at(runEnd) - at(row.grantedAt)) });
  }
  return segments.filter((segment) => segment.width > 0);
}

/** This function gives the lanes of a view: the leases that touch the window, the newest last. */
export function lanesOf(view: View): Row[] {
  const { start } = windowOf(view.now);
  return view.all.filter((row) => (row.endedAt ?? view.now) >= start).slice(-MAX_LANES);
}

/** This function gives the HTML of the timeline of a view. */
export function timelineOf(view: View): string {
  const { start, end } = windowOf(view.now);
  const lanes = lanesOf(view);
  if (lanes.length === 0) return `<p class="empty">The timeline shows each lease after its request.</p>`;
  const ticks: string[] = [];
  const first = Math.ceil(start / 30) * 30;
  for (let t = first; t <= end; t += 30) {
    const left = ((t - start) / (end - start)) * 100;
    // A label near the right edge would go past the edge of the page, so the axis leaves it out.
    if (left > 92) continue;
    ticks.push(`<span class="tick${left < 4 ? " first" : ""}" style="left:${left.toFixed(2)}%">${t} s</span>`);
  }
  const nowLeft = (((view.now - start) / (end - start)) * 100).toFixed(2);
  const rows = lanes.map((row) => {
    const bars = segmentsOf(row, view.now, start, end)
      .map((segment) => {
        const stopped = segment.kind === "run" && row.outcome === "stopped" ? " stopped" : "";
        const what = segment.kind === "wait" ? "waited in the queue" : "ran under its lease";
        return `<span class="bar ${segment.kind}${stopped} c${row.color}" style="left:${segment.left.toFixed(2)}%;width:${segment.width.toFixed(2)}%" title="${escape(row.job)} (${escape(row.holder)}) ${what}"></span>`;
      })
      .join("");
    const mark = row.outcome === "stopped" ? "Stopped" : row.outcome === "cancelled" ? "Cancelled" : row.outcome === "done" ? "Done" : row.state === "waiting" ? "Waits" : "Runs";
    return `<div class="lane ${row.state}"><span class="lane-name"><span class="sw c${row.color}" aria-hidden="true"></span>${escape(row.job)} <span class="holder">${escape(row.holder)}</span><span class="lane-state">${mark}</span></span><span class="lane-track">${bars}<span class="now" style="left:${nowLeft}%"></span></span></div>`;
  });
  return `${rows.join("")}<div class="lane axis"><span class="lane-name"></span><span class="lane-track">${ticks.join("")}</span></div>`;
}
