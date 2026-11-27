/** Releases, the daily check for a newer one, and the `update` command (chapter 7). */
export { checkForRelease, type ReleaseCheck, type ReleaseCheckOptions } from './check.js';
export { execCommand, failureText, type CommandResult, type CommandRunner } from './command.js';
export {
  copyRootFolder,
  pruneRootCopies,
  restoreRootFolder,
  runUpdate,
  UPDATE_COPIES_KEPT,
  updateCopiesDir,
  UpdateError,
  type UpdateDeps,
} from './update.js';
export {
  compareVersions,
  formatVersion,
  isReleaseTag,
  newestReleaseTag,
  parseVersion,
  tagsOfLsRemote,
  type Version,
} from './version.js';
