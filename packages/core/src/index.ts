/**
 * The core of headroom: the sampler, the owners of memory, the lease broker, the store and the engine.
 * It uses no package of the client, so other programs can embed it.
 */

export { DEFAULT_ALERT_RULES, detect, diskLevel, diskSize } from "./alerts.ts";
export type { Alert, AlertInput, AlertKind, AlertRules, AlertSeverity, DiskInput } from "./alerts.ts";
export { counterDelta, CounterTracker, TRAIL_MS } from "./counters.ts";
export type { Counter, CounterRow, OwnerCores, OwnerWrites } from "./counters.ts";
export {
  accountingCpuMs,
  applyCpuControl,
  coresOfRate,
  coresText,
  CPU_AUTO_DEFAULT,
  CPU_RATE_CONTROL_ENABLE,
  CPU_RATE_CONTROL_HARD_CAP,
  CPU_RATE_CONTROL_WEIGHT_BASED,
  CPU_RATE_INFO_SIZE,
  CPU_RESERVE_DEFAULT,
  CPU_WEIGHT_DEFAULT,
  cpuControlOf,
  cpuGroups,
  cpuLine,
  cpuRateInfo,
  cpuRateOf,
  heldMs,
  JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION,
  LEASE_GROUP,
  suggestCores,
  TREE_GROUP,
} from "./cpu.ts";
export type { CpuControl, CpuRateBinding, TrailPoint, TreeUse } from "./cpu.ts";
export { largeFileDirs, largeFiles } from "./disks.ts";
export type { LargeFile } from "./disks.ts";
export { Broker, isActive, processIsAlive } from "./broker.ts";
export type { BrokerOptions, Capacity, JobExit, Lease, LeaseMeasures, LeaseRequest, LeaseState } from "./broker.ts";
export {
  averageRate,
  BROWSER_SLOT,
  isBrowserLease,
  isSpawnHeavy,
  isSpawnWait,
  learnSpawn,
  leaseRate,
  percentile90,
  promote,
  SPAWN_HEAVY_DEFAULT,
  SPAWN_RUNS,
  SPAWN_WAIT_END,
  SPAWN_WINDOW_MS,
  spawnClassText,
  spawnConflict,
  spawnLine,
  startsSumConflict,
  SUM_WAIT_START,
  windowRate,
} from "./spawn.ts";
export type { SpawnClass, SpawnSource } from "./spawn.ts";
export {
  BATTERY_FLOOR_DEFAULT,
  checksOf,
  ConditionError,
  conditionOf,
  CONDITIONS,
  conditionsText,
  conditionWait,
  defaultUsageFile,
  HEAVY_MEMORY_MB,
  heavyWhy,
  isConditionWait,
  knownConditionsText,
  leaseConditions,
  localClock,
  nextUnmet,
  parseCondition,
  parseUsage,
  parseWhen,
  PLANNED_CONDITIONS,
  readUsage,
  TIMING_CONDITIONS,
  TIMING_REASON,
  unmetCheck,
  unmetText,
  USAGE_CACHE_MS,
  USAGE_FRESH_MS,
  UsageReader,
  waitsForRoom,
} from "./conditions.ts";
export type {
  CheckSource,
  Condition,
  ConditionCheck,
  ConditionFacts,
  ConditionOp,
  ConditionSpec,
  ConditionValue,
  LeaseConditions,
  UnmetCondition,
  UsageFacts,
} from "./conditions.ts";
export { ALL_JOBS_MS, findJobs, jobState, MIN_ID_PREFIX } from "./job-state.ts";
export type { JobPhase, JobQuery, JobState } from "./job-state.ts";
export { Engine } from "./engine.ts";
export type { Alerts, ConfigChange, DiskStatus, EndedAlert, EngineOptions, History, PoolTagRow, PoolTags, ResourcePoint, Status, Suggestion } from "./engine.ts";
export { attribute, childrenOf, DEFAULT_RULES, fileTimeMs, isParent, parentOf, programName, readSessions, sessionsDir, treeMb } from "./owners.ts";
export type { Attribution, OwnerRule } from "./owners.ts";
export { isLoopback, parseRoles, PEER_MAX_DEPTH, PeerError, PeerResolver, RoleBook, roleOf, rolesFile } from "./peer.ts";
export type { FleetRole, Peer, PeerErrorCode, PeerInput, PeerSources } from "./peer.ts";
export {
  DEFAULT_DYNAMIC_PORTS,
  dynamicUse,
  inRange,
  ipv6Text,
  listeningPorts,
  netFlows,
  parseDynamicPorts,
  parseIfTable,
  parseNetDev,
  parsePortRange,
  parseProcTcp,
  parseTcpEndpoints,
  parseTcpTable,
  tcpByOwner,
  tcpSummary,
} from "./network.ts";
export type { Flow, Flows, ListeningPort, OwnerConnections, TcpPorts, TcpSummary } from "./network.ts";
export { createJob, startOutsideJob } from "./enforce.ts";
export type { Job, JobLimits, StartedProcess } from "./enforce.ts";
export {
  fitTrend,
  forecast,
  FORECAST_GAP_MS,
  FORECAST_MAX_MS,
  FORECAST_MIN_CONFIDENCE,
  FORECAST_MIN_POINTS,
  FORECAST_MIN_SPAN_MS,
  FORECAST_WINDOW_MS,
  forecastFrom,
  forecastLine,
  forecastPhrase,
  forecastText,
  rateText,
  spanText,
} from "./forecast.ts";
export type { FitOptions, Forecast, ForecastEntry, ForecastTarget, Part, TargetName, Trend } from "./forecast.ts";
export {
  DRAIN_ALERT,
  DRAIN_ENDED_ALERT,
  DRAIN_READY_ALERT,
  drainAlerts,
  drainLine,
  drainReason,
  drainStatus,
  drainWait,
  isDrainActive,
  nextClock,
  parseDrain,
  REBOOT_HORIZON_MINUTES,
  REBOOT_KEYS,
  rebootAdvice,
  rebootBudget,
  rebootLines,
  windowsReboot,
} from "./reboot.ts";
export type {
  AdviceOptions,
  BudgetInput,
  Drain,
  DrainJob,
  DrainStatus,
  KeyState,
  PoolBudget,
  PoolId,
  RebootAdvice,
  RebootBudget,
  RebootKey,
  RebootLevel,
  ResumePlanFile,
  WindowsReboot,
} from "./reboot.ts";
export {
  batteryForecast,
  batteryLevel,
  fitsHistory,
  forecastsOf,
  forecastTargets,
  healthLevel,
  kindOf,
  leasesOf,
  limitOf,
  measure,
  reserveOf,
  RESOURCES,
  resourceOf,
  roomOf,
  rooms,
  sustainedLevel,
  treeAbove,
  withKinds,
} from "./resources.ts";
export type {
  Admit,
  AlertPart,
  AlertText,
  Attribute,
  Change,
  CheckRule,
  CpuTimes,
  Enforce,
  ForecastPart,
  GrowthRule,
  HealthRule,
  InstanceFacts,
  JobSetup,
  JobUsage,
  Level,
  LevelRule,
  Limit,
  Measure,
  Measurement,
  OutlierRule,
  Owners,
  OwnerUse,
  ProcessFacts,
  Readings,
  Resource,
  ResourceId,
  ResourceKind,
  ResourceOwner,
  ResourceStatus,
  Room,
  Rule,
  RuleBase,
  Unit,
} from "./resources.ts";
export {
  batteryParts,
  batteryState,
  cpuWatts,
  EcoTracker,
  guidBytes,
  guidText,
  keepAwakeReason,
  minutesText,
  modeEvent,
  NO_POWER,
  ownersWattsText,
  parseBatteryState,
  parseMeters,
  POWER_MODES,
  POWER_SETTINGS,
  powerLine,
  powerOwners,
  settingEvent,
  suspendEvent,
  systemWatts,
  wattsText,
} from "./power.ts";
export type { BatteryState, OwnerWatts, PowerEvent, PowerMode, PowerStatus } from "./power.ts";
export { createSampler, MB, takeSample } from "./sampler.ts";
export {
  CHECK_EVERY_MS,
  CHECK_TIMEOUT_MS,
  checkHealth,
  DEFAULT_HEALTH,
  errorText,
  HEALTH_NAME,
  nextHealth,
  ServiceMonitor,
  SLOW_MS,
} from "./services.ts";
export type { ServiceCheck, ServiceHealth, ServiceMonitorOptions, ServiceProbe, ServiceState, ServiceType } from "./services.ts";
export type { Sampler } from "./sampler.ts";
export { countText, isNewProcess, NO_STARTS, ownerStartsText, StartTracker, RECENT_STARTS_MS, startsLine, STARTS_WINDOW_MS, topStartsText } from "./starts.ts";
export type { JobStarts, OwnerStarts, ProcessStarts } from "./starts.ts";
export { Store } from "./store.ts";
export type { Config, MemoryRow, OwnerRow, PoolTagSnapshot, ResourceRow, Sleep } from "./store.ts";
export {
  checkJobTemp,
  folderSizeMb,
  isDirectlyUnder,
  isLeaseId,
  jobTempFolder,
  jobTempSetup,
  KEEP_MARK,
  keepJobTemp,
  removeJobTemp,
  sweepJobTemp,
} from "./temp.ts";
export { MEMORY } from "./types.ts";
export type {
  Amounts,
  BatteryRead,
  DiskSpace,
  McpServerSpec,
  NetAdapter,
  NetRead,
  OwnerKind,
  OwnerUsage,
  PoolTag,
  PortRange,
  PowerMeters,
  ProcessInfo,
  ProcessLink,
  Sample,
  SessionInfo,
  SessionLoad,
  SystemMemory,
  TcpConnection,
  TcpEndpoints,
  TcpState,
  TcpTable,
} from "./types.ts";
