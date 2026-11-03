/**
 * The site of headroom: a lease simulator that runs the lease broker of `@headroom/core` in the browser.
 */

export { BURST, KINDS, kindOf, MACHINES, machineOf, START, type JobKind, type Machine } from "./catalog.ts";
export { memoryAt, RESERVE_MB, Simulation, type Outcome, type Row, type SimEvent, type View } from "./sim.ts";
