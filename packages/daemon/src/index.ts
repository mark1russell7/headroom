/**
 * The daemon of headroom: the `resources.*` procedures, the host and the client.
 */

export { connect } from "./client.ts";
export type { Connection } from "./client.ts";
export { DEFAULT_PORT, serve } from "./daemon.ts";
export type { ServeOptions } from "./daemon.ts";
export { parseMemory, parseTime } from "./parse.ts";
export { databasePath, discoveryPath, headroomHome, readDiscovery } from "./paths.ts";
export type { Discovery } from "./paths.ts";
export { resourceProcedures } from "./procedures.ts";
