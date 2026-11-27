/** Releases, the daily check for a newer one, and the copies of the root folder that an update makes (chapter 7). */
export { checkForRelease, type ReleaseCheck, type ReleaseCheckOptions } from './check.js';
export { execCommand, failureText, type CommandResult, type CommandRunner } from './command.js';
export { copyRootFolder, pruneRootCopies, restoreRootFolder, UPDATE_COPIES_KEPT, updateCopiesDir } from './update.js';
export {
  compareVersions,
  formatVersion,
  isReleaseTag,
  newestReleaseTag,
  parseVersion,
  tagsOfLsRemote,
  type Version,
} from './version.js';
