import { createLocalServer, type LocalServer } from '../../server/index.js';
import { tempPaths } from '../../server/test-helpers.js';
import type { Paths } from '../../paths.js';
import type { ApprovalAnswer, ApprovalRequest, IncomingMessage, Store, SurfaceHost } from '../../types.js';
import type { ChatHelloEvent } from './events.js';
import { createTerminalSurface, type TerminalSurface } from './surface.js';

export interface FakeHost extends SurfaceHost {
  incomingCalls: IncomingMessage[];
  answers: Array<{ id: string; answer: ApprovalAnswer }>;
  /** Ids of the requests that still wait. */
  waitingIds: Set<string>;
  /** Called for each incoming message, for example to send a reply. */
  onIncoming?: (msg: IncomingMessage) => Promise<void> | void;
}

/** A host that records what the surface gives it. An answer closes the request on the surface, as the queue does. */
export function fakeHost(surface: () => TerminalSurface): FakeHost {
  const host: FakeHost = {
    incomingCalls: [],
    answers: [],
    waitingIds: new Set(),
    async incoming(msg) {
      host.incomingCalls.push(msg);
      await host.onIncoming?.(msg);
    },
    answerApproval(id, answer) {
      host.answers.push({ id, answer });
      if (!host.waitingIds.delete(id)) return false;
      const outcome = answer.kind === 'rejected' && answer.reason ? `rejected: ${answer.reason}` : answer.kind;
      void surface().closeApproval(id, outcome);
      return true;
    },
    label: (missionId) => (missionId === null ? 'Ada' : `Ada · ${missionId}`),
    store: {} as Store,
  };
  return host;
}

export function approvalRequest(id: string, extra: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id,
    missionId: 'm_k7q3zp2xw9ha',
    action: 'action:email.send',
    toolName: 'mcp__gmail__send',
    input: { to: 'bob@example.com', subject: `Reply ${id}` },
    createdAt: '2026-11-25T10:00:00.000Z',
    expiresAt: '2026-11-26T10:00:00.000Z',
    ...extra,
  };
}

export interface Harness {
  paths: Paths & { remove(): void };
  server: LocalServer;
  surface: TerminalSurface;
  host: FakeHost;
  port: number;
  token: string;
  base: string;
  /** The state that the hello event gives a chat that connects. A test can change it. */
  state: ChatHelloEvent;
  stop(): Promise<void>;
}

/** A started local server with a started terminal surface and a fake host. */
export async function startHarness(paths = tempPaths()): Promise<Harness> {
  const server = createLocalServer({ paths });
  const state: ChatHelloEvent = {
    agentName: 'Ada',
    setUp: true,
    paused: false,
    pauseReason: '',
    resumeHint: '',
    setupCommand: `mission-agent setup --root ${paths.root}`,
  };
  const surface = createTerminalSurface({ server, hello: () => ({ ...state }) });
  const host = fakeHost(() => surface);
  await surface.start(host);
  const { port, token } = await server.start();
  return {
    paths,
    server,
    surface,
    host,
    port,
    token,
    base: `http://127.0.0.1:${port}`,
    state,
    async stop() {
      await surface.stop();
      await server.stop();
    },
  };
}
