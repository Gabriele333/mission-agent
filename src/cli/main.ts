import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { ConfigError, defaultConfig, initRootFolder, loadConfig, writeConfig } from '../config/index.js';
import { openStoreReadOnly } from '../db/index.js';
import {
  createHarness,
  HarnessAlreadyRunningError,
  pauseReason,
  readPause,
  SECRETS_REFRESH_PATH,
  SECRETS_REQUIRED_PATH,
  STATUS_PATH,
  type Harness,
  type HarnessOptions,
  type HarnessStatus,
} from '../harness/index.js';
import { findLibraryMission, LibraryMissingError, readLibrary } from '../library/index.js';
import {
  createMissionRegistry,
  ManifestValidationError,
  MISSION_ADMIN_MANIFEST,
  MissionNotFoundError,
  SystemMissionError,
} from '../manifest/index.js';
import { attachPages, DASHBOARD_PATH, SETUP_PATH } from '../pages/index.js';
import { DEFAULT_ROOT, pathsFor, type Paths } from '../paths.js';
import { libraryDir, programDir, programVersion } from '../program.js';
import { loginHelp } from '../run/index.js';
import {
  createKeychainStore,
  InvalidCredentialIdError,
  KeychainUnavailableError,
  MODEL_API_KEY,
  secretDelete,
  secretList,
  secretSet,
  TELEGRAM_BOT_TOKEN,
  terminalIo,
  type TerminalInput,
} from '../secrets/index.js';
import { isServerAlive, pageUrl, readServerFile, serverUrl, type ServerInfo } from '../server/index.js';
import {
  installService,
  otherServiceFiles,
  ServiceError,
  servicePlan,
  serviceStatus,
  stableNodePath,
  uninstallService,
  type ServiceOptions,
  type ServicePlan,
} from '../service/index.js';
import { shellQuote } from '../shell.js';
import { GROUP_TITLES, openChecks, runSystemChecks, type CheckGroup, type SystemCheck } from '../system/index.js';
import { ChatClientError, runChatClient } from '../surfaces/terminal/index.js';
import type { AgentConfig, SecretStore } from '../types.js';
import { checkForRelease, execCommand, runUpdate, UpdateError, type CommandRunner, type ReleaseCheck } from '../update/index.js';
import { codeCatalog, readMissionsFromFiles, requiredFromFiles } from './offline.js';

/** The `mission-agent` program (§A.5, §J.3). `main` returns the exit code. */

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: TerminalInput;
  /** Default: the Keychain store. */
  secretStore?: () => SecretStore;
  /** Default: `createHarness`. */
  createHarness?: (options: HarnessOptions) => Harness;
  /** Resolves with the name of the signal that ends `start`. Default: SIGINT or SIGTERM. */
  waitForSignal?: () => Promise<string>;
  /** Opens an address in the browser. Default: the macOS `open` command. */
  openUrl?: (url: string) => Promise<void>;
  /** Replaces parts of the service options, such as the launchctl runner. For tests. */
  serviceOptions?: Omit<ServiceOptions, 'root'>;
  /** The folder of the installed program. Default: the one that holds this module. */
  programDir?: string;
  /** The folder of the mission library. Default: `mission-library/` in the program folder. */
  libraryDir?: string;
  /** Runs `git`, `npm` and `node` for the release check and the update. Default: the real programs. */
  runCommand?: CommandRunner;
  /** Looks for a newer release once a day while `start` runs. Default: `checkForRelease`. */
  releaseCheck?: () => Promise<ReleaseCheck>;
}

/** An expected error: its message is printed without a stack trace. */
class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const USAGE = `Usage: mission-agent <command> [options]

Commands:
  start                       Run the harness in the foreground until Ctrl+C.
  init --name <agent name>    Create the root folder and a first agent.yaml.
       [--surface terminal|telegram] [--telegram-user-id <id>] [--login subscription|api_key]
                              --login is the model login. Default: subscription, your own Claude plan.
  chat                        Chat with the running harness in this terminal.
  status                      Show whether the harness runs, whether it is paused, and the missions.
  secret set <id>             Store a credential. The value is asked with hidden input.
  secret delete <id>          Remove a credential.
  secret list                 Show each required credential and whether it has a value.
  login-help                  Show how to sign in with a Claude plan, or how to use an API key.
  setup [--no-open]           Open the setup page of the running harness in the browser.
  dashboard [--no-open]       Open the dashboard of the running harness in the browser.
                              With --no-open, print the address instead.
  service install             Install the harness as a macOS service (a LaunchAgent) that starts
                              at login. Needs --root. It shows what it writes before it writes it.
  service uninstall           Stop and remove the service. Needs --root.
  service status              Show whether the service is installed and running. Needs --root.
  check [--unattended] [--guide]
                              Check the settings of this computer that the agent depends on, such as
                              the service, the Keychain and sleep. It only reads. With --unattended,
                              a setting that a computer with nobody at it needs counts as a problem.
                              With --guide, it goes through each problem with you and checks again.
  library list                Show the missions of the mission library that comes with the program.
  library add <name> [--yes]  Copy one mission of the library into this agent. It shows the mission
                              and asks before it copies. With --yes, it does not ask.
  update [--yes]              Install the newest release of the program. Needs --root. It stops the
                              harness, copies the root folder, installs the release and starts the
                              harness again. With --yes, it does not ask.

Options:
  --root <path>   The agent's root folder. Default: ~/mission-agent. The service commands need it.
  --version       Show the version of the program.
  -h, --help      Show this help.`;

const OPTIONS = {
  root: { type: 'string' },
  name: { type: 'string' },
  surface: { type: 'string' },
  login: { type: 'string' },
  'telegram-user-id': { type: 'string' },
  'no-open': { type: 'boolean' },
  yes: { type: 'boolean' },
  unattended: { type: 'boolean' },
  guide: { type: 'boolean' },
  version: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = {
  root?: string | undefined;
  name?: string | undefined;
  surface?: string | undefined;
  login?: string | undefined;
  'telegram-user-id'?: string | undefined;
  'no-open'?: boolean | undefined;
  yes?: boolean | undefined;
  unattended?: boolean | undefined;
  guide?: boolean | undefined;
  version?: boolean | undefined;
  help?: boolean | undefined;
};

/** The options each command accepts, besides --root and --help. */
const COMMAND_OPTIONS: Record<string, (keyof Values)[]> = {
  start: [],
  init: ['name', 'surface', 'login', 'telegram-user-id'],
  chat: [],
  status: [],
  secret: [],
  'login-help': [],
  setup: ['no-open'],
  dashboard: ['no-open'],
  service: [],
  library: ['yes'],
  update: ['yes'],
  check: ['unattended', 'guide'],
};

function expandRoot(raw: string | undefined): string {
  if (raw === undefined || raw === '') return DEFAULT_ROOT;
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return resolve(raw);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  const out = (line: string) => io.stdout.write(`${line}\n`);
  const err = (line: string) => io.stderr.write(`${line}\n`);

  let values: Values;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    err(`${errorText(e)}`);
    err('Run "mission-agent --help" to see the commands and options.');
    return 2;
  }

  const command = positionals[0];
  if (values.version === true && values.help !== true) {
    out(programVersion(io.programDir ?? programDir()) ?? 'unknown');
    return 0;
  }
  if (values.help === true || command === undefined || command === 'help') {
    out(USAGE);
    return command === undefined && values.help !== true ? 2 : 0;
  }
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) {
    err(`Unknown command "${command}". Run "mission-agent --help" to see the commands.`);
    return 2;
  }
  for (const key of ['name', 'surface', 'login', 'telegram-user-id', 'no-open', 'yes', 'unattended', 'guide'] as const) {
    if (values[key] !== undefined && !allowed.includes(key)) {
      err(`The option --${key} is not used by the ${command} command.`);
      return 2;
    }
  }

  const root = expandRoot(values.root);
  const paths = pathsFor(root);
  const rootFlag = values.root === undefined ? '' : ` --root "${root}"`;

  try {
    switch (command) {
      case 'start':
        expectArgs(positionals, 1, 'start');
        return await startCommand(paths, rootFlag, io, out, err);
      case 'init':
        expectArgs(positionals, 1, 'init');
        return initCommand(paths, values, rootFlag, out);
      case 'chat':
        expectArgs(positionals, 1, 'chat');
        return await chatCommand(paths, io);
      case 'status':
        expectArgs(positionals, 1, 'status');
        return await statusCommand(paths, rootFlag, out);
      case 'secret':
        return await secretCommand(paths, positionals, io, out);
      case 'login-help':
        expectArgs(positionals, 1, 'login-help');
        return loginHelpCommand(paths, rootFlag, out);
      case 'setup':
      case 'dashboard':
        expectArgs(positionals, 1, command);
        return await pageCommand(paths, rootFlag, command, values['no-open'] === true, io, out);
      case 'service':
        return await serviceCommand(paths, positionals, values.root !== undefined, io, out);
      case 'library':
        return await libraryCommand(paths, positionals, rootFlag, values.yes === true, io, out);
      case 'check':
        expectArgs(positionals, 1, 'check');
        return await checkCommand(paths, values.unattended === true, values.guide === true, io, out);
      case 'update':
        expectArgs(positionals, 1, 'update');
        return await updateCommand(paths, values.root !== undefined, values.yes === true, io, out);
      default:
        return 2;
    }
  } catch (e) {
    if (e instanceof CliError) {
      err(e.message);
      return e.exitCode;
    }
    // Errors that the modules raise for a wrong input or a missing Keychain are expected too.
    if (
      e instanceof InvalidCredentialIdError ||
      e instanceof KeychainUnavailableError ||
      e instanceof ConfigError ||
      e instanceof ServiceError ||
      e instanceof UpdateError ||
      e instanceof LibraryMissingError ||
      e instanceof ManifestValidationError ||
      e instanceof MissionNotFoundError ||
      e instanceof SystemMissionError
    ) {
      err(e.message);
      return 1;
    }
    err(`The command failed: ${errorText(e)}`);
    return 1;
  }
}

function expectArgs(positionals: string[], count: number, command: string): void {
  if (positionals.length > count) {
    throw new CliError(`The ${command} command takes no argument "${positionals[count]}".`, 2);
  }
}

// ---------------------------------------------------------------- connection to a running harness

async function runningHarness(paths: Paths): Promise<ServerInfo | undefined> {
  const info = readServerFile(paths);
  if (info === undefined) return undefined;
  return (await isServerAlive(info)) ? info : undefined;
}

async function askHarness(info: ServerInfo, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${info.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    signal: AbortSignal.timeout(30_000),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${serverUrl(info)}${path}`, init);
  if (!res.ok) throw new Error((await res.text()) || `status ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- start

function waitForSignalDefault(): Promise<string> {
  return new Promise((resolveSignal) => {
    const onSignal = (signal: NodeJS.Signals) => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolveSignal(signal);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

async function startCommand(
  paths: Paths,
  rootFlag: string,
  io: CliIo,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const other = await runningHarness(paths);
  if (other !== undefined) {
    err(`Another harness is already running for ${paths.root} (process ${other.pid}). Stop it first.`);
    return 1;
  }
  const make = io.createHarness ?? createHarness;
  const log = (text: string) => io.stderr.write(`${new Date().toISOString()} ${text}\n`);
  const dir = io.programDir ?? programDir();
  const releaseCheck = io.releaseCheck ?? (() => checkForRelease({ programDir: dir, ...(io.runCommand ? { run: io.runCommand } : {}) }));
  const harness = make({ root: paths.root, log, releaseCheck });
  // The setup page and the dashboard are served by this harness (§J).
  attachPages(harness, {
    log,
    ...(io.serviceOptions !== undefined ? { service: io.serviceOptions } : {}),
    ...(io.runCommand !== undefined ? { system: { run: io.runCommand } } : {}),
    ...(io.openUrl !== undefined ? { openUrl: io.openUrl } : {}),
  });
  try {
    await harness.start();
  } catch (e) {
    if (e instanceof HarnessAlreadyRunningError) {
      err(`${e.message} Stop it first.`);
      return 1;
    }
    err(`The harness could not start: ${errorText(e)}`);
    return 1;
  }
  const st = harness.status();
  out(`The harness is running for ${paths.root} (process ${st.pid}${st.version !== undefined ? `, version ${st.version}` : ''}).`);
  out(st.paused ? `It started paused. ${st.pauseReason}` : 'It is not paused.');
  out(`Chat with it from another terminal: mission-agent chat${rootFlag}`);
  out(`Open the setup page: mission-agent setup${rootFlag}    The dashboard: mission-agent dashboard${rootFlag}`);
  if (st.defaultSurface === 'telegram') out('You can also write to the Telegram bot.');
  out('Press Ctrl+C to stop it.');
  const signal = await (io.waitForSignal ?? waitForSignalDefault)();
  out(`Stopping (${signal}).`);
  await harness.stop();
  out('The harness has stopped.');
  return 0;
}

// ---------------------------------------------------------------- init

function initCommand(paths: Paths, values: Values, rootFlag: string, out: (line: string) => void): number {
  const name = values.name?.trim();
  if (name === undefined || name === '') throw new CliError('init needs the agent name: mission-agent init --name <agent name>', 2);
  const surface = values.surface ?? 'terminal';
  if (surface !== 'terminal' && surface !== 'telegram') {
    throw new CliError(`--surface must be terminal or telegram, not "${surface}".`, 2);
  }
  const login = values.login ?? 'subscription';
  if (login !== 'api_key' && login !== 'subscription') {
    throw new CliError(`--login must be subscription or api_key, not "${login}".`, 2);
  }
  let telegramUserId: number | undefined;
  const rawUser = values['telegram-user-id'];
  if (rawUser !== undefined) {
    telegramUserId = Number(rawUser);
    if (!/^\d+$/.test(rawUser) || !Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) {
      throw new CliError(`--telegram-user-id must be the numeric id of your Telegram account, not "${rawUser}".`, 2);
    }
  }
  if (surface === 'telegram' && telegramUserId === undefined) {
    throw new CliError(
      'Telegram as the default surface needs the numeric id of your Telegram account: add --telegram-user-id <id>.',
      2,
    );
  }
  if (existsSync(paths.agentYaml)) {
    throw new CliError(`${paths.agentYaml} already exists. Nothing was changed. Edit the file by hand to change it.`);
  }

  initRootFolder(paths);
  const config: AgentConfig = { ...defaultConfig(name), defaultSurface: surface, modelLogin: login };
  if (telegramUserId !== undefined) config.telegramUserId = telegramUserId;
  writeConfig(paths, config);

  out(`Created ${paths.agentYaml} for the agent "${name}".`);
  out('Next steps:');
  if (login === 'api_key') out(`- Store a key from the Claude Console: mission-agent secret set ${MODEL_API_KEY}${rootFlag}`);
  else out(`- ${loginHelp('subscription', paths.sdkConfigDir)}`);
  if (telegramUserId !== undefined) out(`- Store the Telegram bot token: mission-agent secret set ${TELEGRAM_BOT_TOKEN}${rootFlag}`);
  out(`- Start the harness: mission-agent start${rootFlag}`);
  return 0;
}

// ---------------------------------------------------------------- chat

async function chatCommand(paths: Paths, io: CliIo): Promise<number> {
  try {
    await runChatClient({ paths, ...(io.stdin ? { input: io.stdin } : {}), output: io.stdout });
    return 0;
  } catch (e) {
    // The chat program has already printed why it could not start.
    if (e instanceof ChatClientError) return e.exitCode;
    throw e;
  }
}

// ---------------------------------------------------------------- status

async function statusCommand(paths: Paths, rootFlag: string, out: (line: string) => void): Promise<number> {
  const info = await runningHarness(paths);
  if (info !== undefined) {
    const st = (await askHarness(info, 'GET', STATUS_PATH)) as HarnessStatus;
    out(`The harness is running for ${paths.root} (process ${st.pid}, started at ${st.startedAt ?? 'an unknown time'}).`);
    if (st.version !== undefined) out(`It is version ${st.version} of the program.`);
    out(st.paused ? `It is paused. ${st.pauseReason}` : 'It is not paused.');
    if (st.configError !== undefined) out(`agent.yaml has a problem: ${st.configError}`);
    printMissions(
      st.missions.map((m) => ({ ...m, note: m.running ? 'run in progress' : '' })),
      st.manifestErrors.map((e) => `${e.source}: ${e.message}`),
      out,
    );
    return 0;
  }

  out(`The harness is not running for ${paths.root}. Start it with: mission-agent start${rootFlag}`);
  if (existsSync(paths.dbFile)) {
    try {
      const store = openStoreReadOnly(paths.dbFile);
      try {
        const hold = readPause(store).hold;
        if (hold !== undefined) out(`It was paused when it stopped, and it starts paused. ${pauseReason({ hold })}`);
      } finally {
        store.close();
      }
    } catch (e) {
      out(`The database could not be read: ${errorText(e)}`);
    }
  }
  if (!existsSync(paths.agentYaml)) {
    out(`agent.yaml does not exist. Create it with: mission-agent init --name <agent name>${rootFlag}`);
  } else {
    try {
      loadConfig(paths);
    } catch (e) {
      out(errorText(e));
    }
  }
  const files = readMissionsFromFiles(paths);
  printMissions(
    files.manifests.map((m) => ({ id: m.id, name: m.name, status: m.status, version: m.version, note: '' })),
    files.problems,
    out,
  );
  return 0;
}

function printMissions(
  missions: { id: string; name: string; status: string; version: number; note: string }[],
  problems: string[],
  out: (line: string) => void,
): void {
  out('Missions:');
  const width = Math.max(...missions.map((m) => m.name.length), 4);
  for (const m of missions) {
    const note = m.note === '' ? '' : `  ${m.note}`;
    out(`  ${m.name.padEnd(width)}  ${m.status.padEnd(6)}  version ${m.version}  ${m.id}${note}`);
  }
  if (problems.length > 0) {
    out('Manifests that are not loaded:');
    for (const p of problems) out(`  ${p}`);
  }
}

// ---------------------------------------------------------------- secret

async function secretCommand(paths: Paths, positionals: string[], io: CliIo, out: (line: string) => void): Promise<number> {
  const sub = positionals[1];
  const store = (io.secretStore ?? (() => createKeychainStore()))();
  const secretIo = terminalIo({ ...(io.stdin ? { input: io.stdin } : {}), output: io.stdout, prompt: io.stderr });

  if (sub === 'list') {
    expectArgs(positionals, 2, 'secret list');
    const info = await runningHarness(paths);
    let ids: string[];
    if (info !== undefined) {
      ids = ((await askHarness(info, 'GET', SECRETS_REQUIRED_PATH)) as { ids: string[] }).ids;
    } else {
      let config: AgentConfig;
      try {
        config = loadConfig(paths).config;
      } catch (e) {
        throw new CliError(`The required credentials depend on agent.yaml, which cannot be used: ${errorText(e)}`);
      }
      ids = requiredFromFiles(paths, config);
    }
    await secretList(store, ids, secretIo);
    return 0;
  }

  if (sub !== 'set' && sub !== 'delete') {
    throw new CliError('Use one of: mission-agent secret set <id>, secret delete <id>, secret list', 2);
  }
  const id = positionals[2];
  if (id === undefined) throw new CliError(`secret ${sub} needs a credential id, such as ${TELEGRAM_BOT_TOKEN}.`, 2);
  expectArgs(positionals, 3, `secret ${sub}`);
  if (sub === 'set') await secretSet(store, id, secretIo);
  else await secretDelete(store, id, secretIo);

  // A running harness keeps values in memory, so it is told to read this one again (§A.5).
  const info = await runningHarness(paths);
  if (info !== undefined) {
    try {
      await askHarness(info, 'POST', SECRETS_REFRESH_PATH, { id });
      out('The running harness has read the credential again.');
    } catch (e) {
      out(`The running harness could not read the credential again: ${errorText(e)} Restart it to use the new value.`);
      return 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------- login-help

function loginHelpCommand(paths: Paths, rootFlag: string, out: (line: string) => void): number {
  out('Your own Claude plan is the default login: "model_login: subscription" in agent.yaml.');
  out('The setup page can start the sign-in for you. It opens Anthropic\'s sign-in page in the browser.');
  out(`Or, in a terminal: ${loginHelp('subscription', paths.sdkConfigDir)}`);
  out('The sign-in belongs to this agent only. Sign in again when the sign-in ends.');
  out('');
  out('To use an API key from the Claude Console instead, set "model_login: api_key" in agent.yaml.');
  out(`Then store the key: mission-agent secret set ${MODEL_API_KEY}${rootFlag}`);
  return 0;
}

// ---------------------------------------------------------------- setup and dashboard

function openInBrowser(url: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // An argument array and no shell: the address is passed as one argument.
    execFile('/usr/bin/open', [url], { timeout: 15_000 }, (e) => (e === null ? resolvePromise() : reject(e)));
  });
}

async function pageCommand(
  paths: Paths,
  rootFlag: string,
  which: 'setup' | 'dashboard',
  noOpen: boolean,
  io: CliIo,
  out: (line: string) => void,
): Promise<number> {
  const name = which === 'setup' ? 'setup page' : 'dashboard';
  const info = await runningHarness(paths);
  if (info === undefined) {
    out(`The harness is not running for ${paths.root}, so the ${name} cannot open.`);
    out(`Start it first with: mission-agent start${rootFlag}`);
    if (which === 'setup') out('Without a configuration it starts paused, and it serves the setup page.');
    return 1;
  }
  const url = pageUrl(info, which === 'setup' ? SETUP_PATH : DASHBOARD_PATH);
  if (noOpen) {
    out(`Open this address in a browser on this computer: ${url}`);
    out('The address holds the access token of this start of the harness. Do not share it.');
    return 0;
  }
  try {
    await (io.openUrl ?? openInBrowser)(url);
  } catch (e) {
    throw new CliError(`The browser could not be opened: ${errorText(e)} Run "mission-agent ${which} --no-open${rootFlag}" to get the address.`);
  }
  out(`Opened the ${name} in the browser.`);
  return 0;
}

// ---------------------------------------------------------------- service

/** What a held back start means for the user. launchd's log calls the state "on-demand-only mode". */
const HELD_BACK_HELP = [
  'In this state of your login session, launchd starts no service by itself.',
  'So it does not start the harness again after a crash, until the state ends.',
  'If "mission-agent service status" still shows this later, log out of macOS and log in again, then check again.',
];

function printPlan(plan: ServicePlan, out: (line: string) => void): void {
  out(`The service for the root folder ${plan.root}:`);
  out(`  File:     ${plan.plistPath}`);
  out(`  Label:    ${plan.label}`);
  out(`  Command:  ${plan.programArguments.map(shellQuote).join(' ')}`);
  out(`  Logs:     ${plan.stdoutPath}`);
  out(`            ${plan.stderrPath}`);
  out(`  PATH:     ${plan.envPath}`);
  out('  It starts the harness at login, and again after a crash.');
}

async function serviceCommand(
  paths: Paths,
  positionals: string[],
  rootGiven: boolean,
  io: CliIo,
  out: (line: string) => void,
): Promise<number> {
  const sub = positionals[1];
  if (sub !== 'install' && sub !== 'uninstall' && sub !== 'status') {
    throw new CliError('Use one of: mission-agent service install, service uninstall, service status (each with --root <path>)', 2);
  }
  expectArgs(positionals, 2, `service ${sub}`);
  // The root folder is the user's choice. The service records it, so it is never assumed.
  if (!rootGiven) {
    throw new CliError(`service ${sub} needs the agent's root folder: mission-agent service ${sub} --root <path>`, 2);
  }
  const options: ServiceOptions = { ...io.serviceOptions, root: paths.root };

  if (sub === 'status') {
    const st = await serviceStatus(options);
    out(`Service ${st.label} for ${paths.root}:`);
    out(`  File:     ${st.plistPath} (${st.installed ? 'present' : 'not present'})`);
    if (!st.loaded) out('  launchd:  not loaded');
    else out(`  launchd:  loaded, ${st.state ?? 'state unknown'}${st.pid !== undefined ? `, process ${st.pid}` : ''}`);
    if (st.heldBack !== undefined) {
      out(`  launchd holds back the start of this service (it reports: pended nondemand spawn = ${st.heldBack}).`);
      for (const line of HELD_BACK_HELP) out(`  ${line}`);
      out(`  To start it now: launchctl kickstart gui/${process.getuid?.() ?? '<uid>'}/${st.label}`);
    }
    return 0;
  }

  const plan = servicePlan(options);
  if (sub === 'install') {
    printPlan(plan, out);
    out(`Writing ${plan.plistPath} and loading it with: launchctl bootstrap ${plan.domain} ${shellQuote(plan.plistPath)}`);
    const result = await installService(options);
    out(result.replaced ? 'The old service was removed, and the new one is installed and loaded.' : 'The service is installed and loaded.');
    out(`It starts the harness now and at each login. Check it with: mission-agent service status --root ${shellQuote(plan.root)}`);
    if (result.startError !== undefined) out(`launchctl could not start it now: ${result.startError}`);
    if (result.heldBack) {
      out('');
      out('Warning: launchd held back the start of the service, so this command started the harness itself.');
      for (const line of HELD_BACK_HELP) out(line);
    }
    return 0;
  }

  out(`Removing the service ${plan.label}: launchctl bootout ${plan.domain}/${plan.label}, then the file ${plan.plistPath}.`);
  const result = await uninstallService(options);
  if (!result.wasLoaded && !result.removedFile) out('The service was not installed. Nothing was changed.');
  else out(`The service is removed.${result.wasLoaded ? ' It stopped the harness it ran.' : ''}`);
  return 0;
}

// ---------------------------------------------------------------- questions

/** Asks a yes or no question and reads one line. Anything other than y or yes is a no. */
function askYesNo(question: string, io: CliIo): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: io.stdin ?? process.stdin, output: io.stderr, terminal: false });
    let answered = false;
    const done = (answer: string) => {
      if (answered) return;
      answered = true;
      rl.close();
      resolveAnswer(/^(y|yes)$/i.test(answer.trim()));
    };
    io.stderr.write(question);
    rl.once('line', done);
    // Input that ends without a line is a no.
    rl.once('close', () => done(''));
  });
}

// ---------------------------------------------------------------- library

async function libraryCommand(
  paths: Paths,
  positionals: string[],
  rootFlag: string,
  yes: boolean,
  io: CliIo,
  out: (line: string) => void,
): Promise<number> {
  const sub = positionals[1];
  if (sub !== 'list' && sub !== 'add') {
    throw new CliError('Use one of: mission-agent library list, library add <name>', 2);
  }
  const library = readLibrary(io.libraryDir ?? libraryDir(io.programDir ?? programDir()));

  if (sub === 'list') {
    expectArgs(positionals, 2, 'library list');
    if (yes) throw new CliError('The option --yes is not used by library list.', 2);
    if (library.missions.length === 0) out('The mission library holds no mission.');
    else {
      out('Missions of the library. "yes" means that this agent already has the mission.');
      const width = Math.max(...library.missions.map((m) => m.folder.length), 4);
      out(`  ${'Name'.padEnd(width)}  Here  What it is for`);
      for (const m of library.missions) {
        const here = existsSync(paths.missionDir(m.manifest.id)) ? 'yes ' : 'no  ';
        out(`  ${m.folder.padEnd(width)}  ${here}  ${m.manifest.description}`);
      }
      out(`Add one with: mission-agent library add <name>${rootFlag}`);
    }
    if (library.problems.length > 0) {
      out('Folders of the library that cannot be used:');
      for (const p of library.problems) out(`  ${p}`);
    }
    return 0;
  }

  const name = positionals[2];
  if (name === undefined) throw new CliError('library add needs the name of a mission: mission-agent library add <name>', 2);
  expectArgs(positionals, 3, 'library add');
  const found = findLibraryMission(library, name);
  if (found === undefined) {
    throw new CliError(`The mission library has no mission "${name}". See the missions with: mission-agent library list${rootFlag}`);
  }
  if (!existsSync(paths.missionsDir)) {
    throw new CliError(`${paths.root} is not the root folder of an agent yet. Start the agent once first: mission-agent start${rootFlag}`);
  }
  let config: AgentConfig;
  try {
    config = existsSync(paths.agentYaml) ? loadConfig(paths).config : defaultConfig('mission-agent');
  } catch (e) {
    throw new CliError(`A mission is checked against agent.yaml, which cannot be used: ${errorText(e)}`);
  }

  const m = found.manifest;
  out(`Mission ${m.name} (${m.id}): ${m.description}`);
  out(`  It runs on:   ${m.triggers.map((t) => JSON.stringify(t)).join(', ') || 'nothing'}`);
  out(`  Its tools:    ${m.tools.join(', ') || 'none besides the ones every mission has'}`);
  if (found.skills.length > 0) out(`  Its skills:   ${found.skills.join(', ')}`);
  out('  What the model is told on every run:');
  for (const line of m.context.instructions.trimEnd().split('\n')) out(`    ${line}`);
  out(`It is copied to ${paths.missionDir(m.id)}. After the copy it belongs to this agent.`);
  if (!yes && !(await askYesNo('Add this mission? [y/N] ', io))) {
    out('Nothing was changed.');
    return 0;
  }

  // The registry checks the manifest and copies the files. A running harness finds the new folder itself.
  const hashes = new Map<string, string>();
  const registry = createMissionRegistry({
    paths,
    catalog: codeCatalog(paths, config),
    config: () => config,
    codeManifests: [MISSION_ADMIN_MANIFEST],
    memory: { get: (k) => hashes.get(k), set: (k, v) => void hashes.set(k, v) },
  });
  const added = registry.install(found.dir);
  out(`Added the mission ${added.name}.`);
  const required = requiredFromFiles(paths, config);
  const store = (io.secretStore ?? (() => createKeychainStore()))();
  const missing: string[] = [];
  for (const id of required) {
    try {
      if (!(await store.has(id))) missing.push(id);
    } catch {
      // The Keychain could not be asked. `secret list` shows the same information.
      break;
    }
  }
  for (const id of missing) out(`A credential that this agent needs has no value yet: mission-agent secret set ${id}${rootFlag}`);
  out((await runningHarness(paths)) !== undefined ? 'The running harness loads it within a few seconds.' : 'The harness loads it at its next start.');
  return 0;
}

// ---------------------------------------------------------------- update

async function updateCommand(paths: Paths, rootGiven: boolean, yes: boolean, io: CliIo, out: (line: string) => void): Promise<number> {
  // The update copies the root folder and restarts its harness, so the folder is never assumed.
  if (!rootGiven) throw new CliError("update needs the agent's root folder: mission-agent update --root <path>", 2);
  const options: ServiceOptions = { ...io.serviceOptions, root: paths.root };
  return runUpdate({
    programDir: io.programDir ?? programDir(),
    paths,
    run: io.runCommand ?? execCommand,
    nodePath: io.serviceOptions?.nodePath ?? stableNodePath(),
    service: {
      status: () => serviceStatus(options),
      install: async () => void (await installService(options)),
      uninstall: async () => void (await uninstallService(options)),
      others: () => otherServiceFiles(options),
    },
    async findHarness() {
      const info = await runningHarness(paths);
      if (info === undefined) return undefined;
      try {
        const st = (await askHarness(info, 'GET', STATUS_PATH)) as HarnessStatus;
        return st.version === undefined ? { pid: info.pid } : { pid: info.pid, version: st.version };
      } catch {
        return { pid: info.pid };
      }
    },
    confirm: (question) => (yes ? Promise.resolve(true) : askYesNo(question, io)),
    out,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  });
}

// ---------------------------------------------------------------- check

/** Reads lines from standard input, one per question. `undefined` means that the input ended. */
function lineReader(io: CliIo): { ask(question: string): Promise<string | undefined>; close(): void } {
  const rl = createInterface({ input: io.stdin ?? process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question) {
      io.stderr.write(question);
      const next = await lines.next();
      return next.done === true ? undefined : next.value;
    },
    close: () => rl.close(),
  };
}

/** The mark in front of a check. A setting of the unattended group is a fault only when the user wants that. */
function checkMark(check: SystemCheck, unattended: boolean): string {
  if (check.state === 'ok') return 'ok';
  if (check.state === 'unknown') return 'unknown';
  return check.group === 'needed' || unattended ? 'PROBLEM' : 'not set';
}

function printCheck(check: SystemCheck, unattended: boolean, out: (line: string) => void): void {
  const indent = ' '.repeat(11);
  out(`  ${checkMark(check, unattended).padEnd(7)}  ${check.title}: ${check.detail}`);
  if (check.state !== 'not_ok') return;
  if (check.fix !== undefined) out(`${indent}What to do: ${check.fix}`);
  if (check.command !== undefined) out(`${indent}Command: ${check.command}`);
}

function printChecks(checks: SystemCheck[], unattended: boolean, out: (line: string) => void): void {
  for (const group of ['needed', 'unattended'] as CheckGroup[]) {
    const list = checks.filter((c) => c.group === group);
    if (list.length === 0) continue;
    out(`${GROUP_TITLES[group]}:`);
    for (const check of list) printCheck(check, unattended, out);
  }
}

async function checkCommand(paths: Paths, unattendedFlag: boolean, guide: boolean, io: CliIo, out: (line: string) => void): Promise<number> {
  const store = (io.secretStore ?? (() => createKeychainStore()))();
  const read = () =>
    runSystemChecks({
      paths,
      service: { ...io.serviceOptions, root: paths.root },
      keychain: () => store.has(MODEL_API_KEY),
      ...(io.runCommand !== undefined ? { run: io.runCommand } : {}),
    });

  let unattended = unattendedFlag;
  const reader = guide ? lineReader(io) : undefined;
  try {
    if (reader !== undefined && !unattended) {
      const answer = await reader.ask('Will this computer run the agent with nobody at it, such as a computer with no screen? [y/N] ');
      unattended = /^(y|yes)$/i.test((answer ?? '').trim());
    }
    let checks = await read();
    printChecks(checks, unattended, out);

    if (reader !== undefined) {
      const skipped = new Set<string>();
      let ended = false;
      for (;;) {
        const open = openChecks(checks, unattended).find((c) => !skipped.has(c.id));
        if (open === undefined || ended) break;
        out('');
        out(`${open.title}: ${open.detail}`);
        if (open.fix !== undefined) out(`What to do: ${open.fix}`);
        if (open.command !== undefined) out(`Command, for another terminal: ${open.command}`);
        const question =
          open.settings !== undefined
            ? 'Press Enter after the change to check again. Type o to open System Settings there, or s to skip: '
            : 'Press Enter after the change to check again, or type s to skip: ';
        // The same check is asked about until it is in order or skipped.
        for (;;) {
          const answer = (await reader.ask(question))?.trim().toLowerCase();
          if (answer === undefined) {
            ended = true;
            break;
          }
          if (answer === 's' || answer === 'skip') {
            skipped.add(open.id);
            break;
          }
          if (answer === 'o' && open.settings !== undefined) {
            try {
              await (io.openUrl ?? openInBrowser)(open.settings);
            } catch (e) {
              out(`System Settings could not be opened: ${errorText(e)}`);
            }
            continue;
          }
          checks = await read();
          const now = checks.find((c) => c.id === open.id);
          if (now === undefined || now.state === 'ok') {
            out(`${open.title}: in order now.`);
            break;
          }
          out(`${now.title}: ${now.detail}`);
        }
      }
    }

    const left = openChecks(checks, unattended);
    out('');
    if (left.length === 0) {
      out(unattended ? 'Every setting is in order for a computer that runs the agent with nobody at it.' : 'Everything that every agent needs is in order.');
      return 0;
    }
    out(`${left.length === 1 ? 'One setting is' : `${left.length} settings are`} not in order: ${left.map((c) => c.title).join(', ')}.`);
    return 1;
  } finally {
    reader?.close();
  }
}
