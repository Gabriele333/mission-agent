import { randomBytes } from 'node:crypto';
import { pageUrl } from '../server/server-file.js';
import { createLocalServer, type LocalServer, type RouteHandler } from '../server/server.js';
import { COMMON_JS } from '../pages/assets/common.js';
import { PROGRESS_HTML } from '../pages/assets/html.js';
import { PROGRESS_JS } from '../pages/assets/progress.js';
import { STYLE_CSS } from '../pages/assets/style.js';
import { bodyObject, fail, sendPageFile } from '../pages/http.js';
import type { Asker, Reporter, StepState } from './context.js';
import type { Layout } from './layout.js';

/**
 * The progress page of the maintenance program (chapter 7.5). It answers on 127.0.0.1, on a port
 * that the system picks, with its own access token. It uses the local server of the harness, so it
 * checks the token, the Host and the Origin in the same way, and it sends the pages with the same
 * strict Content-Security-Policy. It writes where it answers to `maintenance.server`.
 */

/** How long the page keeps answering after the end. */
export const STOP_AFTER_MS = 5 * 60_000;
/** How long a question of the page waits for its answer. No answer is a no. */
const QUESTION_WAIT_MS = 30 * 60_000;
const MAX_LINES = 400;

export interface ProgressState {
  operation: 'update' | 'repair';
  title: string;
  steps: { id: string; title: string; state: StepState | 'waiting' }[];
  lines: string[];
  state: 'running' | 'done' | 'failed' | 'needs-repair' | 'refused';
  result: string;
  /** After a failure: whether the version from before the update runs again. */
  oldRuns: boolean | null;
  /** The dashboard of the harness that runs now, with its access token. */
  dashboard: string | null;
  canRepair: boolean;
  repairCommand: string | null;
  question: { id: string; text: string } | null;
  stopsAt: string | null;
}

export interface ProgressServer {
  url: string;
  state: ProgressState;
  reporter: Reporter;
  asker: Asker;
  line(text: string): void;
  /** Starts a new operation on the page, with the parts it shows. */
  begin(operation: ProgressState['operation'], title: string, parts: readonly (readonly [string, string])[]): void;
  /** Shows the result, and stops answering a few minutes later. */
  end(result: Pick<ProgressState, 'state' | 'result' | 'oldRuns' | 'canRepair' | 'dashboard'>): void;
  /** Called when the page asks for a repair. */
  onRepair(fn: () => void): void;
  stop(): Promise<void>;
  /** Resolves when the server stopped. */
  stopped: Promise<void>;
}

export async function startProgressServer(layout: Layout, options: { stopAfterMs?: number } = {}): Promise<ProgressServer> {
  const state: ProgressState = {
    operation: 'update',
    title: '',
    steps: [],
    lines: [],
    state: 'running',
    result: '',
    oldRuns: null,
    dashboard: null,
    canRepair: false,
    repairCommand: null,
    question: null,
    stopsAt: null,
  };
  let repair: (() => void) | undefined;
  let pending: { id: string; resolve: (answer: string) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((r) => (resolveStopped = r));

  const server: LocalServer = createLocalServer({ paths: { stateDir: layout.home, serverFile: layout.server } });
  const file = (path: string, type: string, body: string): [string, RouteHandler] => [path, (_req, res) => sendPageFile(res, type, body)];
  for (const [path, handler] of [
    file('/', 'text/html; charset=utf-8', PROGRESS_HTML),
    file('/pages/style.css', 'text/css; charset=utf-8', STYLE_CSS),
    file('/pages/common.js', 'text/javascript; charset=utf-8', COMMON_JS),
    file('/pages/progress.js', 'text/javascript; charset=utf-8', PROGRESS_JS),
  ]) {
    server.route('GET', path, handler);
  }
  server.route('GET', '/api/progress', (_req, res) => res.json(state));
  server.route('POST', '/api/repair', (_req, res) => {
    if (!state.canRepair || repair === undefined) return fail(res, 409, 'A repair can start only after an update that needs one.');
    state.canRepair = false;
    repair();
    res.json({ ok: true });
  });
  server.route('POST', '/api/answer', (req, res) => {
    const body = bodyObject(req.body);
    if (pending === undefined || body?.id !== pending.id) return fail(res, 409, 'This question is no longer asked.');
    if (body.answer !== 'yes' && body.answer !== 'no') return fail(res, 400, 'The answer must be "yes" or "no".');
    const p = pending;
    pending = undefined;
    clearTimeout(p.timer);
    state.question = null;
    p.resolve(body.answer);
    res.json({ ok: true });
  });

  const started = await server.start();
  const url = pageUrl(started, '/');

  const line = (text: string) => {
    for (const l of text.split('\n')) state.lines.push(l);
    if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
  };

  async function stop(): Promise<void> {
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    await server.stop();
    resolveStopped();
  }

  return {
    url,
    state,
    line,
    stopped,
    reporter: {
      step(id, title, s) {
        const found = state.steps.find((x) => x.id === id);
        if (found !== undefined) found.state = s;
        else state.steps.push({ id, title, state: s });
      },
    },
    asker: {
      canAsk: () => true,
      line(question) {
        return new Promise((resolve) => {
          const id = randomBytes(8).toString('hex');
          state.question = { id, text: question.replace(/\s*\[[yYnN]\/[yYnN]\]\s*$/, '') };
          const timer = setTimeout(() => {
            pending = undefined;
            state.question = null;
            resolve('no');
          }, QUESTION_WAIT_MS);
          timer.unref();
          pending = { id, resolve, timer };
        });
      },
    },
    begin(operation, title, parts) {
      if (stopTimer !== undefined) clearTimeout(stopTimer);
      state.operation = operation;
      state.title = title;
      state.steps = parts.map(([id, t]) => ({ id, title: t, state: 'waiting' }));
      state.state = 'running';
      state.result = '';
      state.oldRuns = null;
      state.canRepair = false;
      state.stopsAt = null;
      line('');
    },
    end(result) {
      Object.assign(state, result);
      state.repairCommand = result.state === 'needs-repair' || result.state === 'failed' ? 'mission-agent repair' : null;
      const after = options.stopAfterMs ?? STOP_AFTER_MS;
      state.stopsAt = new Date(Date.now() + after).toISOString();
      if (stopTimer !== undefined) clearTimeout(stopTimer);
      stopTimer = setTimeout(() => void stop(), after);
    },
    onRepair(fn) {
      repair = fn;
    },
    stop,
  };
}
