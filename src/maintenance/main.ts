import { maintenanceMain } from './cli.js';

/**
 * The entry of the maintenance program (chapter 7.5): `maintenance/dist/maintenance/main.js`.
 * Every module it needs is imported here at the start, so the files of the running program can be
 * replaced while it runs.
 */
process.exitCode = await maintenanceMain(process.argv.slice(2));
