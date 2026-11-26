import { openStoreReadOnly } from '../db/index.js';
import type { Harness } from '../harness/index.js';
import type { RouteHandler } from '../server/index.js';
import { COMMON_JS } from './assets/common.js';
import { DASHBOARD_JS } from './assets/dashboard.js';
import { DASHBOARD_HTML, SETUP_HTML } from './assets/html.js';
import { SETUP_JS } from './assets/setup.js';
import { STYLE_CSS } from './assets/style.js';
import {
  approvalsView,
  codeView,
  costView,
  harnessView,
  memoryView,
  missionsView,
  runsView,
  type DashboardSource,
} from './dashboard-data.js';
import { fail, sendPageFile } from './http.js';
import { setupRoutes, type PageRoute, type SetupOptions } from './setup-routes.js';

/**
 * The two local pages of the harness (§J): the setup page and the dashboard. Every route is added
 * to the harness's local server, so every request goes through its token check (§J.3).
 */

export { PAGE_CSP } from './http.js';
export { type PageRoute } from './setup-routes.js';

export const SETUP_PATH = '/setup';
export const DASHBOARD_PATH = '/dashboard';

export interface PagesOptions {
  /** How the setup page installs the service. The root is always the harness's own. */
  service?: SetupOptions['service'];
  /** How long the Telegram pairing waits for the code. */
  pairTimeoutMs?: number;
  now?: () => Date;
  log?: (text: string) => void;
}

export interface AttachedPages {
  /** Every route the pages added, with its method. */
  routes: { method: 'GET' | 'POST'; path: string; page: 'setup' | 'dashboard' | 'file' }[];
}

function fileRoutes(): PageRoute[] {
  const file = (path: string, type: string, body: string): PageRoute => ({
    method: 'GET',
    path,
    handler: (_req, res) => sendPageFile(res, type, body),
  });
  return [
    file(SETUP_PATH, 'text/html; charset=utf-8', SETUP_HTML),
    file(DASHBOARD_PATH, 'text/html; charset=utf-8', DASHBOARD_HTML),
    file('/pages/style.css', 'text/css; charset=utf-8', STYLE_CSS),
    file('/pages/common.js', 'text/javascript; charset=utf-8', COMMON_JS),
    file('/pages/setup.js', 'text/javascript; charset=utf-8', SETUP_JS),
    file('/pages/dashboard.js', 'text/javascript; charset=utf-8', DASHBOARD_JS),
  ];
}

/** The dashboard's routes. All are GET: the dashboard only reads (§J.2). */
function dashboardRoutes(src: DashboardSource): PageRoute[] {
  const get = (path: string, handler: RouteHandler): PageRoute => ({ method: 'GET', path, handler });
  const safely =
    (fn: (req: Parameters<RouteHandler>[0]) => unknown): RouteHandler =>
    async (req, res) => {
      try {
        res.json(await fn(req));
      } catch (err) {
        fail(res, 500, `The dashboard could not read this part: ${src.harness.redact(err instanceof Error ? err.message : String(err))}`);
      }
    };
  return [
    get('/api/dashboard/harness', safely(() => harnessView(src))),
    get('/api/dashboard/missions', safely(() => missionsView(src))),
    get(
      '/api/dashboard/runs',
      safely((req) => {
        const limit = Number(req.query.get('limit') ?? '');
        const mission = req.query.get('mission');
        return runsView(src, {
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          ...(mission !== null && mission !== '' ? { missionId: mission } : {}),
        });
      }),
    ),
    get('/api/dashboard/cost', safely(() => costView(src))),
    get('/api/dashboard/approvals', safely(() => approvalsView(src))),
    get('/api/dashboard/memory', safely(() => memoryView(src))),
    get('/api/dashboard/code', safely(() => codeView(src))),
  ];
}

/** Adds the routes of both pages to the harness's local server. Call it before or after `start()`. */
export function attachPages(harness: Harness, options: PagesOptions = {}): AttachedPages {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const src: DashboardSource = { harness, now, openStore: () => openStoreReadOnly(harness.paths.dbFile) };
  const setupOptions: SetupOptions = { service: options.service ?? {}, log };
  if (options.pairTimeoutMs !== undefined) setupOptions.pairTimeoutMs = options.pairTimeoutMs;

  const groups: [AttachedPages['routes'][number]['page'], PageRoute[]][] = [
    ['file', fileRoutes()],
    ['setup', setupRoutes(harness, setupOptions)],
    ['dashboard', dashboardRoutes(src)],
  ];
  const routes: AttachedPages['routes'] = [];
  for (const [page, list] of groups) {
    for (const r of list) {
      harness.server.route(r.method, r.path, r.handler);
      routes.push({ method: r.method, path: r.path, page });
    }
  }
  return { routes };
}
