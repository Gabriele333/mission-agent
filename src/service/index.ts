/** The macOS service that keeps the harness running (§H). */
export { buildPlist, SERVICE_LABEL_PREFIX, serviceLabel, serviceLogPaths, xmlEscape, type PlistInput } from './plist.js';
export {
  builtCliPath,
  execLaunchctl,
  installedProgram,
  installService,
  otherServiceFiles,
  ServiceError,
  servicePlan,
  sessionState,
  serviceStatus,
  stableNodePath,
  uninstallService,
  type InstallResult,
  type LaunchctlResult,
  type LaunchctlRunner,
  type ServiceOptions,
  type ServicePlan,
  type ServiceStatus,
  type SessionState,
  type UninstallResult,
} from './service.js';
