/**
 * The daemon of headroom: the `resources.*` procedures, the host and the client.
 */

export { answers, connect, connectTo, isNetworkError } from "./client.ts";
export type { Connection } from "./client.ts";
export { DEFAULT_PORT, fileLog, serve } from "./daemon.ts";
export type { ServeOptions } from "./daemon.ts";
export { parseMemory, parseTime } from "./parse.ts";
export { databasePath, discoveryPath, headroomHome, logPath, readDiscovery } from "./paths.ts";
export type { Discovery } from "./paths.ts";
export { resourceProcedures } from "./procedures.ts";
export {
  install as installService,
  SERVICE_NAME,
  serviceCommand,
  status as serviceStatus,
  systemdArg,
  systemdUnit,
  uninstall as uninstallService,
  windowsArg,
  windowsTaskXml,
} from "./service.ts";
export type { ServiceCommand } from "./service.ts";
