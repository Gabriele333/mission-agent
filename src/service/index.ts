/** The macOS service that keeps the harness running (§H). */
export { buildPlist, serviceLabel, serviceLogPaths, xmlEscape, type PlistInput } from './plist.js';
export {
  builtCliPath,
  execLaunchctl,
  installService,
  ServiceError,
  servicePlan,
  serviceStatus,
  uninstallService,
  type InstallResult,
  type LaunchctlResult,
  type LaunchctlRunner,
  type ServiceOptions,
  type ServicePlan,
  type ServiceStatus,
  type UninstallResult,
} from './service.js';
