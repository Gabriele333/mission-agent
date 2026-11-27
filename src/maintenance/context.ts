import type { LaunchctlRunner } from '../service/service.js';
import type { CommandRunner } from '../update/command.js';
import type { Layout } from './layout.js';

/**
 * What the maintenance program works with. Every outside effect goes through here, so the tests
 * replace git, npm, node, launchctl, the harness and the person who answers.
 */

/** The steps where a test can make the operation fail or stop. Each one is a hook point. */
export type Checkpoint = (step: string) => Promise<void>;

/** Asks a person. */
export interface Asker {
  /** True when a person can answer. */
  canAsk(): boolean;
  /** Prints the question and reads one line. Undefined when the input ended. */
  line(question: string): Promise<string | undefined>;
}

/** What the progress page shows. */
export interface Reporter {
  step(id: string, title: string, state: StepState): void;
}
export type StepState = 'running' | 'done' | 'failed' | 'skipped';

export interface HarnessFound {
  pid: number;
  version?: string;
}

export interface Maint {
  layout: Layout;
  /** The repository to install from when `install.json` names none. */
  repo: string;
  /** The folder of the service files. */
  launchAgents: string;
  keychainService: string;
  /** The user's home folder. */
  userHome: string;
  uid: number;
  /** The node program that runs the program's own commands. */
  nodePath: string;
  /** The PATH that the maintenance program got, for the link to the command. */
  envPath: string;
  /** Runs git, npm and node. Their output goes to the log. */
  run: CommandRunner;
  /** Runs a command of the program with this terminal, for the questions it asks. Returns its exit code. */
  runAttached(program: string, args: string[]): Promise<number>;
  launchctl: LaunchctlRunner;
  /** The harness that answers for a root folder, with the version it reports. */
  findHarness(root: string): Promise<HarnessFound | undefined>;
  /** Runs `/usr/bin/security`. */
  security(args: string[]): Promise<{ code: number }>;
  ask: Asker;
  out(line: string): void;
  /** Appends a line to the log only. */
  log(line: string): void;
  report?: Reporter;
  now(): Date;
  sleep(ms: number): Promise<void>;
  pid: number;
  alive(pid: number): boolean;
  checkpoint: Checkpoint;
  env: Record<string, string | undefined>;
  waits: { stopMs: number; startMs: number; pollMs: number };
}

/** Asks a yes or no question. `defaultYes` is the answer to an empty line. Undefined when nobody can be asked. */
export async function yesNo(m: Maint, question: string, defaultYes: boolean): Promise<boolean | undefined> {
  if (!m.ask.canAsk()) return undefined;
  const answer = await m.ask.line(question);
  if (answer === undefined) return false;
  const a = answer.trim();
  // As the install script did: with a default of yes, only a no is a no. With a default of no, only a yes is a yes.
  return defaultYes ? !/^(n|no)$/i.test(a) : /^(y|yes)$/i.test(a);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
