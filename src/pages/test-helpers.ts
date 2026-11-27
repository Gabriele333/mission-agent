import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, type Harness } from '../harness/index.js';
import { fakeSurface, scriptedQuery, simpleAnswers, TELEGRAM, type FakeSurface } from '../harness/test-helpers.js';
import { fakeSignInSpawn, type FakeSignInChild } from '../run/test-helpers.js';
import { createMemorySecretStore } from '../secrets/index.js';
import { readServerFile } from '../server/index.js';
import type { LaunchctlResult } from '../service/index.js';
import { fakeTelegram, type FakeTelegram } from '../surfaces/telegram/test-helpers.js';
import type { SecretStore } from '../types.js';
import type { ReleaseCheck } from '../update/index.js';
import { attachPages, type AttachedPages, type UpdateRoutesOptions } from './index.js';

/** A real harness with the pages, in a temporary root, with fakes for the SDK, the secrets, Telegram and launchctl. */
export interface PagesRig {
  harness: Harness;
  pages: AttachedPages;
  root: string;
  tmp: string;
  secrets: SecretStore;
  telegram: FakeTelegram;
  surface: FakeSurface;
  logs: string[];
  launchctlCalls: string[][];
  /** What the fake launchctl answers to `print`. */
  printAnswer: LaunchctlResult;
  launchAgentsDir: string;
  /** Each sign-in program that the harness started. None is real. */
  signIns: FakeSignInChild[];
  /**
   * What the fake `defaults`, `pmset`, `sysadminctl`, `fdesetup` and `git` answer, by the name of
   * the program. The checks of the computer never read the real settings in a test.
   */
  commandAnswers: Record<string, { code: number; stdout: string; stderr: string }>;
  /** The places in System Settings that the page asked to open. */
  opened: string[];
  base: string;
  token: string;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  json<T = Record<string, unknown>>(res: Response): Promise<T>;
  stop(): Promise<void>;
}

export interface RigOptions {
  agentYaml?: string;
  secrets?: Record<string, string>;
  /** The account the login check sees. Default: a Claude plan. */
  account?: AccountInfo;
  /** Runs before the harness starts, with the root folder. */
  before?: (root: string) => void;
  pairTimeoutMs?: number;
  /** The sign-in program the harness finds. Null: none is found. Default: a fake path. */
  signInProgram?: string | null;
  signInTimeoutMs?: number;
  /** The release check of the harness. Default: none. */
  releaseCheck?: () => Promise<ReleaseCheck>;
  /** The options of the Version part. Default: a development copy. */
  update?: UpdateRoutesOptions;
}

export async function pagesRig(options: RigOptions = {}): Promise<PagesRig> {
  const tmp = mkdtempSync(join(tmpdir(), 'mission-agent-pages-'));
  const root = join(tmp, 'root');
  mkdirSync(root);
  if (options.agentYaml !== undefined) writeFileSync(join(root, 'agent.yaml'), options.agentYaml);
  options.before?.(root);
  const secrets = createMemorySecretStore(options.secrets ?? {});
  const telegram = fakeTelegram();
  const surface = fakeSurface(TELEGRAM, true);
  const logs: string[] = [];
  const { queryFn } = scriptedQuery(simpleAnswers(), options.account);
  const signIn = fakeSignInSpawn();
  const program = options.signInProgram === undefined ? '/fake/claude' : options.signInProgram;
  const harness = createHarness({
    root,
    secretStore: secrets,
    queryFn,
    log: (t) => logs.push(t),
    stopWaitMs: 2000,
    configDebounceMs: 50,
    createTelegramSurface: () => surface,
    telegramFetch: telegram.fetchFn,
    ...(options.releaseCheck !== undefined ? { releaseCheck: options.releaseCheck } : {}),
    signIn: {
      spawn: signIn.spawn,
      program: () => program ?? undefined,
      hostEnv: () => ({ PATH: '/usr/local/bin:/bin', HOME: '/Users/ada', USER: 'ada' }),
      ...(options.signInTimeoutMs !== undefined ? { timeoutMs: options.signInTimeoutMs } : {}),
    },
  });

  const cliPath = join(tmp, 'dist', 'cli.js');
  mkdirSync(join(tmp, 'dist'));
  writeFileSync(cliPath, '// the built program\n');
  const launchAgentsDir = join(tmp, 'LaunchAgents');

  const rig = {
    harness,
    root,
    tmp,
    secrets,
    telegram,
    surface,
    logs,
    launchctlCalls: [] as string[][],
    printAnswer: { code: 113, stdout: '', stderr: 'Could not find service' } as LaunchctlResult,
    launchAgentsDir,
    signIns: signIn.children,
    commandAnswers: {
      defaults: { code: 0, stdout: 'ada\n', stderr: '' },
      pmset: { code: 0, stdout: 'AC Power:\n sleep                0\n autorestart          1\n', stderr: '' },
      sysadminctl: { code: 0, stdout: '', stderr: 'screenLock delay is immediate\n' },
      fdesetup: { code: 0, stdout: 'FileVault is Off.\n', stderr: '' },
      git: { code: 0, stdout: 'git version 2.0.0\n', stderr: '' },
    } as PagesRig['commandAnswers'],
    opened: [] as string[],
  } as PagesRig;

  rig.pages = attachPages(harness, {
    log: (t) => logs.push(t),
    pairTimeoutMs: options.pairTimeoutMs ?? 5000,
    system: {
      user: 'ada',
      home: join(tmp, 'home'),
      run: async (program) => rig.commandAnswers[program.split('/').pop() as string] ?? { code: 127, stdout: '', stderr: 'not found' },
    },
    openUrl: async (url) => void rig.opened.push(url),
    update: options.update ?? { programDir: tmp, home: null },
    service: {
      cliPath,
      uid: 501,
      envPath: '/usr/bin:/bin',
      launchAgentsDir,
      launchctl: async (args) => {
        rig.launchctlCalls.push(args);
        if (args[0] === 'print') return rig.printAnswer;
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  await harness.start();
  const info = readServerFile(harness.paths);
  if (info === undefined) throw new Error('no server file');
  rig.base = `http://127.0.0.1:${info.port}`;
  rig.token = info.token;
  const auth = { authorization: `Bearer ${info.token}` };
  rig.get = (path) => fetch(`${rig.base}${path}`, { headers: auth });
  rig.post = (path, body) =>
    fetch(`${rig.base}${path}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  rig.json = async <T>(res: Response) => (await res.json()) as T;
  rig.stop = async () => {
    await harness.stop();
    rmSync(tmp, { recursive: true, force: true });
  };
  return rig;
}

/** Polls until the check passes, or fails after the time limit. */
export async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------- a small fake DOM, to run the page scripts in a test

type Listener = (ev: { preventDefault(): void; target: FakeNode }) => unknown;

/**
 * Just enough of the DOM for the scripts of the pages: createElement, createTextNode, appendChild,
 * removeChild, textContent, attributes and listeners. It has no HTML parser, like the scripts need none.
 */
export class FakeNode {
  readonly children: FakeNode[] = [];
  parent: FakeNode | null = null;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  [prop: string]: unknown;
  private ownText = '';
  private ownValue = '';
  selected = false;

  constructor(
    readonly tagName: string,
    readonly nodeType = 1,
  ) {}

  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  appendChild(child: FakeNode): FakeNode {
    // A browser refuses anything that is not a node.
    if (!(child instanceof FakeNode)) throw new TypeError('appendChild: the argument is not a node');
    child.parent?.removeChild(child);
    this.children.push(child);
    child.parent = this;
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parent = null;
    return child;
  }
  get textContent(): string {
    return this.nodeType === 3 ? this.ownText : this.children.map((c) => c.textContent).join('');
  }
  set textContent(text: string) {
    if (this.nodeType === 3) {
      this.ownText = text;
      return;
    }
    for (const c of [...this.children]) this.removeChild(c);
    if (text !== '') this.appendChild(textNode(text));
  }
  get value(): string {
    if (this.tagName === 'SELECT') {
      const options = this.children.filter((c) => c.tagName === 'OPTION');
      return String((options.find((o) => o.selected) ?? options[0])?.value ?? '');
    }
    return this.ownValue;
  }
  set value(v: string) {
    if (this.tagName === 'SELECT') for (const o of this.children) o.selected = o.value === v;
    else this.ownValue = String(v);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Calls the listeners of an event and waits for what they return. */
  async fire(type: string): Promise<void> {
    for (const fn of this.listeners.get(type) ?? []) await fn({ preventDefault() {}, target: this });
  }
  /** Every node below this one, depth first. */
  all(): FakeNode[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

function textNode(text: string): FakeNode {
  const n = new FakeNode('#text', 3);
  n.textContent = text;
  return n;
}

export interface PageRun {
  app: FakeNode;
  document: { title: string; hidden: boolean };
  text(): string;
  find(test: (n: FakeNode) => boolean): FakeNode | undefined;
  byId(id: string): FakeNode;
  button(label: string): FakeNode;
  waitForText(part: string, timeoutMs?: number): Promise<void>;
  /** Every tag name the scripts created. */
  tags: Set<string>;
}

/** Runs common.js and one page script in a fresh context, with fetch going to the rig's harness. */
export async function runPageScript(r: Pick<PagesRig, 'base' | 'token'>, scripts: string[], extra: Record<string, unknown> = {}): Promise<PageRun> {
  const { createContext, Script } = await import('node:vm');
  const tags = new Set<string>();
  const app = new FakeNode('MAIN');
  const document = {
    title: '',
    hidden: false,
    createElement(tag: string) {
      tags.add(tag.toLowerCase());
      return new FakeNode(tag.toUpperCase());
    },
    createElementNS(_ns: string, tag: string) {
      tags.add(tag.toLowerCase());
      return new FakeNode(tag.toLowerCase());
    },
    createTextNode: textNode,
    getElementById: (id: string) => (id === 'app' ? app : null),
    addEventListener() {},
  };
  const ctx: Record<string, unknown> = {
    document,
    console,
    navigator: { clipboard: { writeText: async () => undefined } },
    confirm: () => true,
    setTimeout,
    clearTimeout,
    // The dashboard refreshes on a timer. The test refreshes by hand instead.
    setInterval: () => 0,
    fetch: (path: string, init: RequestInit = {}) =>
      fetch(`${r.base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${r.token}` } }),
    URL,
    location: { assign: () => undefined, href: '' },
    ...extra,
  };
  ctx.window = ctx;
  createContext(ctx);
  for (const code of scripts) new Script(code).runInContext(ctx);
  const run: PageRun = {
    app,
    document,
    tags,
    text: () => app.textContent,
    find: (test) => app.all().find(test),
    byId(id) {
      const n = app.all().find((x) => x.id === id);
      if (n === undefined) throw new Error(`No node with id ${id}. The page says: ${app.textContent.slice(0, 500)}`);
      return n;
    },
    button(label) {
      const n = app.all().find((x) => x.tagName === 'BUTTON' && x.textContent === label);
      if (n === undefined) throw new Error(`No button "${label}". The page says: ${app.textContent.slice(0, 800)}`);
      return n;
    },
    async waitForText(part, timeoutMs = 4000) {
      try {
        await until(() => app.textContent.includes(part), `the text "${part}"`, timeoutMs);
      } catch (err) {
        throw new Error(`${(err as Error).message} The page says: ${app.textContent.slice(0, 1500)}`);
      }
    },
  };
  return run;
}
