import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pathsFor } from '../paths.js';
import { pageUrl, readServerFile } from '../server/server-file.js';
import { errorText, type Maint } from './context.js';
import { folderVersion, MaintenanceError } from './files.js';
import { runInstall, type InstallOptions } from './install.js';
import { readJournal } from './journal.js';
import { defaultHome, homeProblem, layoutFor } from './layout.js';
import { realMaint } from './real.js';
import { REPAIR_PARTS, runRepair } from './repair.js';
import { startProgressServer } from './serve.js';
import { runUninstall } from './uninstall.js';
import { runUpdate, UPDATE_PARTS } from './update.js';

/**
 * The maintenance program (chapter 7.5): install, uninstall, update and repair. It lives outside
 * the program folder, in `maintenance/`, so it runs when the program is broken. It uses only the
 * builtins of Node.js and files of this repository, and it loads every module at its start.
 */

/** The line that `self-test` prints first. The install script checks for it. */
export const SELF_TEST_LINE = 'The mission-agent maintenance program runs.';

const USAGE = `Usage: mission-agent <command> [options]

The commands of the maintenance program:
  install     Install the program, the command and the service. The install script runs it.
              [--root <path>] [--version <vX.Y.Z>] [--no-service] [--no-link] [--no-open] [--reinstall] [--yes]
  uninstall   Remove the program, the maintenance program and the services. The agent's data is kept.
              [--wipe-data] [--yes] [--root <path>]
              With --wipe-data, it also deletes the agent's root folders and its secrets in the Keychain.
              It asks twice, and needs a person to answer. --yes does not cover it.
  update      Install a newer release. Needs --root. [--yes] [--version <vX.Y.Z>]
              It builds and tests the release before it stops the agent, and goes back when a step fails.
  repair      Find what is wrong with the installed program and fix it, with your consent. [--yes] [--root <path>]
              It asks you each time before it puts a copy of the root folder back. --yes does not cover that.
  self-test   Check that the maintenance program runs.

Options:
  --home <path>   The folder of the program. Default: MISSION_AGENT_HOME, else ~/.mission-agent.
  -h, --help      Show this help.`;

const OPTIONS = {
  home: { type: 'string' },
  root: { type: 'string' },
  version: { type: 'string' },
  staged: { type: 'string' },
  'no-service': { type: 'boolean' },
  'no-link': { type: 'boolean' },
  'no-open': { type: 'boolean' },
  reinstall: { type: 'boolean' },
  'wipe-data': { type: 'boolean' },
  yes: { type: 'boolean' },
  serve: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Key = keyof typeof OPTIONS;

const ALLOWED: Record<string, Key[]> = {
  install: ['root', 'version', 'staged', 'no-service', 'no-link', 'no-open', 'reinstall', 'yes'],
  uninstall: ['wipe-data', 'yes', 'root'],
  update: ['root', 'yes', 'version', 'serve'],
  repair: ['yes', 'root'],
  'self-test': [],
};

/** The version of the maintenance program: the `package.json` two folders above `dist/maintenance/`. */
export function maintenanceVersion(): string {
  return folderVersion(dirname(dirname(dirname(fileURLToPath(import.meta.url))))) ?? 'unknown';
}

function expandRoot(raw: string): string {
  const home = process.env.HOME ?? '';
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return resolve(raw);
}

export async function maintenanceMain(argv: string[]): Promise<number> {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  const err = (line: string) => process.stderr.write(`${line}\n`);
  let values: Partial<Record<Key, string | boolean>>;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    values = parsed.values as Partial<Record<Key, string | boolean>>;
    positionals = parsed.positionals;
  } catch (e) {
    err(errorText(e));
    err('Run "mission-agent repair --help" to see the commands of the maintenance program.');
    return 2;
  }
  const command = positionals[0];
  if (values.help === true || command === undefined) {
    say(USAGE);
    return command === undefined && values.help !== true ? 2 : 0;
  }
  const allowed = ALLOWED[command];
  if (allowed === undefined) {
    err(`The maintenance program has no command "${command}". Its commands are install, uninstall, update, repair and self-test.`);
    return 2;
  }
  if (positionals.length > 1) {
    err(`The ${command} command takes no argument "${positionals[1]}".`);
    return 2;
  }
  for (const key of Object.keys(values) as Key[]) {
    if (key !== 'home' && key !== 'help' && !allowed.includes(key)) {
      err(`The option --${key} is not used by the ${command} command.`);
      return 2;
    }
  }
  if (command === 'self-test') {
    say(SELF_TEST_LINE);
    say(maintenanceVersion());
    return 0;
  }

  const home = resolve(typeof values.home === 'string' && values.home !== '' ? values.home : defaultHome());
  const problem = homeProblem(home);
  if (problem !== undefined) {
    err(problem);
    return 1;
  }
  const root = typeof values.root === 'string' && values.root !== '' ? expandRoot(values.root) : undefined;
  const version = typeof values.version === 'string' ? values.version : undefined;
  const yes = values.yes === true;

  try {
    if (command === 'install') {
      const o: InstallOptions = {
        service: values['no-service'] === true ? 'no' : 'ask',
        link: values['no-link'] !== true,
        open: values['no-open'] !== true,
        reinstall: values.reinstall === true,
        yes,
        ...(root !== undefined ? { root } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(typeof values.staged === 'string' ? { staged: values.staged } : {}),
      };
      return await runInstall(realMaint({ home, out: say }), o);
    }
    if (command === 'uninstall') {
      return await runUninstall(realMaint({ home, out: say }), { wipeData: values['wipe-data'] === true, yes, ...(root !== undefined ? { root } : {}) });
    }
    if (command === 'repair') {
      mkdirSync(home, { recursive: true });
      return await runRepair(realMaint({ home, out: say }), { yes, ...(root !== undefined ? { root } : {}) });
    }
    // update
    if (root === undefined) {
      err("update needs the agent's root folder: mission-agent update --root <path>");
      return 2;
    }
    if (values.serve === true) {
      if (!yes) {
        err('--serve needs --yes: the progress page asks no question before the update.');
        return 2;
      }
      return await serveUpdate(home, root, version);
    }
    return await runUpdate(realMaint({ home, out: say }), { root, yes, ...(version !== undefined ? { version } : {}) });
  } catch (e) {
    err(e instanceof MaintenanceError ? e.message : `The maintenance program failed: ${errorText(e)}`);
    return 1;
  }
}

/** The dashboard of the harness that answers for the root folder now, with its access token. */
async function dashboardOf(m: Maint, root: string): Promise<string | null> {
  if ((await m.findHarness(root)) === undefined) return null;
  const info = readServerFile(pathsFor(root));
  return info === undefined ? null : pageUrl(info, '/dashboard');
}

/**
 * The update that the dashboard starts: it runs with --yes, shows its progress on its own page,
 * and offers a repair on that page when going back failed.
 */
async function serveUpdate(home: string, root: string, version: string | undefined): Promise<number> {
  const layout = layoutFor(home);
  mkdirSync(home, { recursive: true });
  const server = await startProgressServer(layout);
  const lines: string[] = [];
  const m = realMaint({
    home,
    out: (line) => {
      lines.push(line);
      server.line(line);
    },
    asker: server.asker,
  });
  m.report = server.reporter;
  m.log(`The progress page answers at http://127.0.0.1:${new URL(server.url).port}/ (process ${process.pid}).`);

  server.begin('update', `Update of the agent in ${root}`, UPDATE_PARTS);
  let code: number;
  try {
    code = await runUpdate(m, { root, yes: true, ...(version !== undefined ? { version } : {}) });
  } catch (e) {
    m.out(`The update failed: ${errorText(e)}`);
    code = 1;
  }
  const h = await m.findHarness(root);
  const j = readJournal(layout);
  const failure = lines.find((l) => l.startsWith('The update failed:')) ?? [...lines].reverse().find((l) => l.trim() !== '') ?? '';
  const refused = server.state.steps.find((s) => s.id === 'check')?.state === 'failed';
  if (code === 0) {
    const ran = server.state.steps.find((s) => s.id === 'build')?.state === 'done';
    server.end({
      state: ran ? 'done' : 'refused',
      result: ran ? `Version ${h?.version ?? 'unknown'} is installed${h !== undefined ? ' and runs' : ''}.` : failure,
      oldRuns: null,
      canRepair: false,
      dashboard: await dashboardOf(m, root),
    });
  } else {
    server.end({
      state: refused ? 'refused' : j?.stage === 'needs-repair' ? 'needs-repair' : 'failed',
      result: failure,
      oldRuns: refused ? null : h !== undefined && j?.stage !== 'finishing',
      canRepair: !refused && j !== undefined,
      dashboard: await dashboardOf(m, root),
    });
  }

  server.onRepair(() => {
    lines.length = 0;
    server.begin('repair', `Repair of the agent in ${root}`, REPAIR_PARTS);
    runRepair(m, { yes: true, root })
      .catch((e: unknown) => {
        m.out(`The repair failed: ${errorText(e)}`);
        return 1;
      })
      .then(async (repaired) => {
        const still = lines.findIndex((l) => l === 'Still wrong:');
        server.end({
          state: repaired === 0 ? 'done' : 'failed',
          result: repaired === 0 ? 'Everything is in order.' : still === -1 ? (lines[lines.length - 1] ?? '') : lines.slice(still + 1).join(' ').trim(),
          oldRuns: null,
          canRepair: false,
          dashboard: await dashboardOf(m, root),
        });
      })
      .catch(() => undefined);
  });

  await server.stopped;
  return code;
}
