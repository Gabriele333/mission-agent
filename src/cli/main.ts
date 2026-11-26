import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { DEFAULT_ROOT, pathsFor, type Paths } from '../paths.js';
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
import { isServerAlive, readServerFile, serverUrl, type ServerInfo } from '../server/index.js';
import { ChatClientError, runChatClient } from '../surfaces/terminal/index.js';
import type { AgentConfig, SecretStore } from '../types.js';
import { readMissionsFromFiles, requiredFromFiles } from './offline.js';

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
       [--surface terminal|telegram] [--telegram-user-id <id>] [--login api_key|subscription]
  chat                        Chat with the running harness in this terminal.
  status                      Show whether the harness runs, whether it is paused, and the missions.
  secret set <id>             Store a credential. The value is asked with hidden input.
  secret delete <id>          Remove a credential.
  secret list                 Show each required credential and whether it has a value.
  login-help                  Show how to sign in with a Claude plan, or how to use an API key.
  setup                       Open the setup page (not part of this version yet).
  dashboard                   Open the dashboard (not part of this version yet).

Options:
  --root <path>   The agent's root folder. Default: ~/mission-agent
  -h, --help      Show this help.`;

const OPTIONS = {
  root: { type: 'string' },
  name: { type: 'string' },
  surface: { type: 'string' },
  login: { type: 'string' },
  'telegram-user-id': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = {
  root?: string | undefined;
  name?: string | undefined;
  surface?: string | undefined;
  login?: string | undefined;
  'telegram-user-id'?: string | undefined;
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
  setup: [],
  dashboard: [],
};

/**
 * The two local pages. Another developer builds them next and replaces these two handlers.
 * Each one gets the root folder and prints to `out`.
 */
const PAGE_COMMANDS: Record<'setup' | 'dashboard', (paths: Paths, out: (line: string) => void) => Promise<number>> = {
  async setup(_paths, out) {
    out('The setup page is not part of this version yet. Use "mission-agent init" to create agent.yaml.');
    return 1;
  },
  async dashboard(_paths, out) {
    out('The dashboard is not part of this version yet. Use "mission-agent status" to see the harness and its missions.');
    return 1;
  },
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
  if (values.help === true || command === undefined || command === 'help') {
    out(USAGE);
    return command === undefined && values.help !== true ? 2 : 0;
  }
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) {
    err(`Unknown command "${command}". Run "mission-agent --help" to see the commands.`);
    return 2;
  }
  for (const key of ['name', 'surface', 'login', 'telegram-user-id'] as const) {
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
        return await PAGE_COMMANDS[command](paths, out);
      default:
        return 2;
    }
  } catch (e) {
    if (e instanceof CliError) {
      err(e.message);
      return e.exitCode;
    }
    // Errors that the modules raise for a wrong input or a missing Keychain are expected too.
    if (e instanceof InvalidCredentialIdError || e instanceof KeychainUnavailableError || e instanceof ConfigError) {
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
  const harness = make({ root: paths.root, log });
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
  out(`The harness is running for ${paths.root} (process ${st.pid}).`);
  out(st.paused ? `It started paused. ${st.pauseReason}` : 'It is not paused.');
  out(`Chat with it from another terminal: mission-agent chat${rootFlag}`);
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
  const login = values.login ?? 'api_key';
  if (login !== 'api_key' && login !== 'subscription') {
    throw new CliError(`--login must be api_key or subscription, not "${login}".`, 2);
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
  out('To use your own Claude plan, set "model_login: subscription" in agent.yaml.');
  out(`${loginHelp('subscription', paths.sdkConfigDir)}`);
  out('The sign-in belongs to this agent only. Run the command again when the sign-in ends.');
  out('');
  out('To use an API key from the Claude Console instead, set "model_login: api_key" in agent.yaml.');
  out(`Then store the key: mission-agent secret set ${MODEL_API_KEY}${rootFlag}`);
  return 0;
}
