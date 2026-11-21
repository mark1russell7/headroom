/**
 * The options of `headroom run`, as `parseArgs` of `node:util` reads them. The command line tool and the guard of
 * foreground runs in the hook (H208) read a run with this one table. Thus the two readings of a run agree.
 */

/** The options of `headroom run`. */
export const RUN_OPTIONS = {
  mem: { type: "string" },
  cpu: { type: "string" },
  slot: { type: "string", multiple: true },
  holder: { type: "string" },
  job: { type: "string" },
  priority: { type: "string" },
  wait: { type: "string" },
  disk: { type: "string", multiple: true },
  limit: { type: "boolean" },
  keep: { type: "boolean" },
  "keep-temp": { type: "boolean" },
  "no-auto-slot": { type: "boolean" },
  "force-disk": { type: "boolean" },
  "no-eco": { type: "boolean" },
  log: { type: "string" },
  "spawn-heavy": { type: "boolean" },
  "no-spawn-heavy": { type: "boolean" },
  when: { type: "string", multiple: true },
  timing: { type: "boolean" },
  "battery-ok": { type: "boolean" },
  "during-drain": { type: "boolean" },
  "ignore-presence": { type: "boolean" },
  detach: { type: "boolean" },
  "detached-client": { type: "boolean" },
  adopt: { type: "string" },
  "below-peak": { type: "string" },
  // H219: the time limit of a loan of the unused hold of a long lease.
  loan: { type: "string" },
} as const;

/** The longest wait of `headroom run` for its grant when the run gives no `--wait`. */
export const RUN_WAIT_DEFAULT = "30m";
