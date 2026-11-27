/** The macOS service that keeps the harness running (§H). */
export { buildPlist, SERVICE_LABEL_PREFIX, serviceLabel, serviceLogPaths, xmlEscape, type PlistInput } from './plist.js';
export {
  builtCliPath,
  execLaunchctl,
  installService,
  otherServiceFiles,
  ServiceError,
  servicePlan,
  serviceStatus,
  stableNodePath,
  uninstallService,
  type InstallResult,
  type LaunchctlResult,
  type LaunchctlRunner,
  type ServiceOptions,
  type ServicePlan,
  type ServiceStatus,
  type UninstallResult,
} from './service.js';
