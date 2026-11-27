import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { EFFORTS } from '../config/index.js';
import type { Harness } from '../harness/index.js';
import { terminalClaudeCommand, type LoginCheck } from '../run/index.js';
import { isCredentialId, MODEL_API_KEY, TELEGRAM_BOT_TOKEN } from '../secrets/index.js';
import type { RouteHandler } from '../server/index.js';
import { installService, ServiceError, servicePlan, serviceStatus, type ServiceOptions } from '../service/index.js';
import { StoppedError } from '../surfaces/telegram/index.js';
import { applyConfigPatch, readConfigView, readTexts, writeTexts } from './config-edit.js';
import { bodyObject, errorText, fail } from './http.js';
import { qrEncode } from './qr.js';
import { shellQuote } from '../shell.js';
import { GROUP_TITLES, runSystemChecks, type SystemCheck, type SystemCheckDeps } from '../system/index.js';

/**
 * The routes of the setup page (chapter 5, §J.1). Every changing route is a POST with a JSON body.
 * A credential value comes in one POST, goes to the secret store through the harness, and is
 * never sent back, logged or written to a file (§J.3). Answers say only whether a value is present.
 */

export interface PageRoute {
  method: 'GET' | 'POST';
  path: string;
  handler: RouteHandler;
}

export interface SetupOptions {
  /** How the service step installs the LaunchAgent. The root is always the harness's own. */
  service: Omit<ServiceOptions, 'root'>;
  /** How long the pairing waits for the code. Default 10 minutes. */
  pairTimeoutMs?: number;
  /** Replaces parts of the checks of the computer, such as the runner of `pmset`. For tests. */
  system?: Pick<SystemCheckDeps, 'run' | 'user' | 'home'>;
  /** Opens a place in System Settings. Default: the macOS `open` command. */
  openUrl?: (url: string) => Promise<void>;
  log: (text: string) => void;
}

function openWithMacOs(url: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // An argument array and no shell: the address is passed as one argument.
    execFile('/usr/bin/open', [url], { timeout: 15_000 }, (e) => (e === null ? resolvePromise() : reject(e)));
  });
}

/** The longest credential value the page accepts. */
const MAX_SECRET_CHARS = 16 * 1024;
const DEFAULT_PAIR_MS = 10 * 60_000;

type Pairing =
  | { state: 'idle' }
  | { state: 'waiting'; code: string; expiresAt: string }
  | { state: 'paired'; userId: number }
  | { state: 'failed' | 'cancelled'; reason: string };

export { shellQuote };

/**
 * The link that opens the bot in Telegram with the pairing code. Pressing Start there sends
 * "/start <code>" to the bot. Undefined unless the user name has the form Telegram gives and the
 * code has six digits. The link holds no secret: the bot token is never part of it.
 */
export function pairLink(username: string, code: string): string | undefined {
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username) || !/^[0-9]{6}$/.test(code)) return undefined;
  return `https://t.me/${username}?start=${code}`;
}

/**
 * The sign-in command of §A.5 with the real path, for a terminal. The page shows it and never runs it.
 * `program` is `claude` when it is on the PATH, else the path of the Claude Code program of the SDK.
 */
export function signInCommand(sdkConfigDir: string, program: string = terminalClaudeCommand()): string {
  return `CLAUDE_CONFIG_DIR=${shellQuote(sdkConfigDir)} ${program} auth login`;
}

export function setupRoutes(h: Harness, options: SetupOptions): PageRoute[] {
  const paths = h.paths;
  let pairing: Pairing = { state: 'idle' };
  let pairAbort: AbortController | undefined;
  let lastLoginCheck: LoginCheck | undefined;
  // The end time of the last sign-in that the page saw finish well.
  let signInSeen: string | undefined;
  let bot: { username: string; topicsEnabled: boolean } | undefined;
  const serviceOptions = (): ServiceOptions => ({ ...options.service, root: paths.root });
  // The QR code of the last pairing link, made once per link.
  let qrOf: { link: string; rows: string[] } | undefined;

  /** The link and its QR code while a pairing waits and the bot's user name is known. */
  function pairingLink(): { link: string | null; qr: string[] | null } {
    if (pairing.state !== 'waiting' || bot === undefined) return { link: null, qr: null };
    const link = pairLink(bot.username, pairing.code);
    if (link === undefined) return { link: null, qr: null };
    if (qrOf?.link !== link) {
      try {
        qrOf = { link, rows: qrEncode(link).rows };
      } catch (err) {
        // The page still shows the link and the code.
        options.log(`The QR code of the pairing link could not be made: ${errorText(err)}`);
        return { link, qr: null };
      }
    }
    return { link, qr: qrOf.rows };
  }

  /** The state of the sign-in. A sign-in that ended well counts as a login check that passed. */
  function signInState() {
    const s = h.signIn.state();
    if (s.state === 'done' && s.endedAt !== signInSeen) {
      signInSeen = s.endedAt;
      lastLoginCheck = { ok: true };
    }
    return s;
  }

  function loginState(): { state: 'ready' | 'not_ready' | 'unknown'; reason: string } {
    signInState();
    if (h.config() === undefined) return { state: 'unknown', reason: 'The agent has no valid configuration yet.' };
    const blocker = h.status().pause.blocker;
    if (blocker?.kind === 'login') return { state: 'not_ready', reason: blocker.reason };
    if (blocker === undefined) return { state: 'ready', reason: '' };
    // Another blocker came first, so the harness did not check the login. The last check of the page tells.
    if (lastLoginCheck === undefined) return { state: 'unknown', reason: 'The login was not checked yet.' };
    return lastLoginCheck.ok ? { state: 'ready', reason: '' } : { state: 'not_ready', reason: lastLoginCheck.reason };
  }

  async function credentialList(ids: string[]): Promise<{ id: string; present: boolean }[]> {
    const out: { id: string; present: boolean }[] = [];
    for (const id of ids) out.push({ id, present: await h.secrets.has(id) });
    return out;
  }

  async function state() {
    const st = h.status();
    const cfg = h.config()?.config;
    const required = h.requiredCredentials();
    const link = pairingLink();
    return {
      root: paths.root,
      agentName: st.agentName ?? null,
      harness: {
        paused: st.paused,
        pauseReason: st.pauseReason,
        blockerKind: st.pause.blocker?.kind ?? null,
        holdKind: st.pause.hold?.kind ?? null,
        // The harness keeps the last valid values while agent.yaml is invalid (§H).
        usesLastValidValues: st.configError !== undefined && cfg !== undefined,
      },
      config: readConfigView(paths),
      texts: readTexts(paths),
      efforts: EFFORTS,
      login: {
        modelLogin: cfg?.modelLogin ?? null,
        ...loginState(),
        apiKeyId: MODEL_API_KEY,
        apiKeyPresent: await h.secrets.has(MODEL_API_KEY),
        signInCommand: signInCommand(paths.sdkConfigDir),
        signIn: signInState(),
        signInAvailable: h.signIn.available(),
      },
      telegram: {
        tokenId: TELEGRAM_BOT_TOKEN,
        tokenPresent: await h.secrets.has(TELEGRAM_BOT_TOKEN),
        userId: cfg?.telegramUserId ?? null,
        surfaceRunning: h.telegram.running(),
        bot: bot ?? null,
        pairing,
        pairLink: link.link,
        pairQr: link.qr,
      },
      credentials: await credentialList(required),
      commands: { chat: `mission-agent chat --root ${shellQuote(paths.root)}` },
    };
  }

  // ------------------------------------------------------------ configuration

  const getState: RouteHandler = async (_req, res) => res.json(await state());

  const postConfig: RouteHandler = async (req, res) => {
    const values = bodyObject(bodyObject(req.body)?.values);
    if (values === undefined) return fail(res, 400, 'The body must be {"values": {...}}.');
    const result = applyConfigPatch(paths, values);
    if (!result.ok) {
      return fail(res, 400, 'The configuration was not saved.', {
        fieldErrors: result.fieldErrors,
        generalErrors: result.generalErrors,
      });
    }
    await h.reloadConfig();
    res.json({ ok: true });
  };

  const postTexts: RouteHandler = async (req, res) => {
    const body = bodyObject(req.body);
    if (body === undefined) return fail(res, 400, 'The body must be {"corePrompt": "...", "noteParagraph": "..."}.');
    const texts: { corePrompt?: unknown; noteParagraph?: unknown } = {};
    if ('corePrompt' in body) texts.corePrompt = body.corePrompt;
    if ('noteParagraph' in body) texts.noteParagraph = body.noteParagraph;
    const error = writeTexts(paths, texts);
    if (error !== undefined) return fail(res, 400, error);
    await h.reloadConfig();
    res.json({ ok: true });
  };

  // ------------------------------------------------------------ model login

  const postLoginCheck: RouteHandler = async (_req, res) => {
    if (h.config() === undefined) return fail(res, 409, 'Save the agent name first.');
    lastLoginCheck = await h.checkLogin();
    res.json(lastLoginCheck.ok ? { ok: true } : { ok: false, error: lastLoginCheck.reason });
  };

  // The page starts Anthropic's own sign-in program and only watches whether it ended well.
  // Nothing that the program prints reaches the page, and the page sends nothing to it.

  const postSignInStart: RouteHandler = (_req, res) => {
    const cfg = h.config()?.config;
    if (cfg === undefined) return fail(res, 409, 'Save the agent name first.');
    if (cfg.modelLogin !== 'subscription') return fail(res, 409, 'Choose "My own Claude plan" as the model login first.');
    res.json({ ok: true, signIn: h.signIn.start() });
  };

  const getSignIn: RouteHandler = (_req, res) => res.json({ ok: true, signIn: signInState() });

  const postSignInCancel: RouteHandler = (_req, res) => {
    h.signIn.cancel();
    res.json({ ok: true, signIn: signInState() });
  };

  // ------------------------------------------------------------ credentials

  const postSecret: RouteHandler = async (req, res) => {
    const body = bodyObject(req.body);
    const id = body?.id;
    const value = body?.value;
    if (!isCredentialId(id)) return fail(res, 400, 'The credential id is not valid. It has the form credential:<owner>.<name>.');
    if (typeof value !== 'string' || value.trim() === '') return fail(res, 400, 'The value is empty. Nothing was stored.');
    if (value.length > MAX_SECRET_CHARS) return fail(res, 400, `The value is longer than ${MAX_SECRET_CHARS} characters. Nothing was stored.`);
    try {
      await h.secrets.set(id, value);
    } catch (err) {
      // The text of an error never holds the value, but it is removed in case it does.
      const text = errorText(err).split(value).join('[value]');
      return fail(res, 500, `The value of ${id} could not be stored: ${text}`, { id, present: await h.secrets.has(id).catch(() => false) });
    }
    if (id === TELEGRAM_BOT_TOKEN) bot = undefined;
    res.json({ ok: true, id, present: await h.secrets.has(id) });
  };

  const postSecretDelete: RouteHandler = async (req, res) => {
    const id = bodyObject(req.body)?.id;
    if (!isCredentialId(id)) return fail(res, 400, 'The credential id is not valid. It has the form credential:<owner>.<name>.');
    try {
      await h.secrets.delete(id);
    } catch (err) {
      return fail(res, 500, `The value of ${id} could not be deleted: ${errorText(err)}`);
    }
    if (id === TELEGRAM_BOT_TOKEN) bot = undefined;
    res.json({ ok: true, id, present: await h.secrets.has(id) });
  };

  // ------------------------------------------------------------ Telegram (§5.1 step 3)

  const postTelegramCheck: RouteHandler = async (_req, res) => {
    const check = await h.telegram.check();
    if (!check.ok) {
      bot = undefined;
      return res.json({ ok: false, error: h.redact(check.reason) });
    }
    bot = { username: check.username, topicsEnabled: check.topicsEnabled };
    res.json({ ok: true, ...bot });
  };

  function finishPairing(next: Pairing): void {
    pairing = next;
    pairAbort = undefined;
  }

  async function runPairing(code: string, timeoutMs: number, abort: AbortController): Promise<void> {
    try {
      // Telegram answers only one reader of the bot's messages, so the surface stops during the pairing.
      await h.telegram.stop();
      const userId = await h.telegram.pair({ code, timeoutMs, signal: abort.signal });
      // With Telegram set, Telegram is the default surface (§A.1). The agent part can change it.
      const saved = applyConfigPatch(paths, { telegram_user_id: userId, default_surface: 'telegram' });
      if (!saved.ok) {
        const problems = [...saved.generalErrors, ...Object.values(saved.fieldErrors).flat()];
        return finishPairing({ state: 'failed', reason: `The account was found, but agent.yaml could not be saved: ${problems.join(' ')}` });
      }
      await h.reloadConfig();
      finishPairing({ state: 'paired', userId });
    } catch (err) {
      if (err instanceof StoppedError || abort.signal.aborted) finishPairing({ state: 'cancelled', reason: 'The pairing was stopped.' });
      else finishPairing({ state: 'failed', reason: h.redact(errorText(err)) });
    } finally {
      try {
        await h.telegram.start();
      } catch (err) {
        options.log(`The Telegram surface did not start again after the pairing: ${h.redact(errorText(err))}`);
      }
    }
  }

  const postPair: RouteHandler = async (_req, res) => {
    if (pairing.state === 'waiting') return res.json({ ok: true, pairing });
    if (!(await h.secrets.has(TELEGRAM_BOT_TOKEN))) return fail(res, 409, 'Enter the bot token first.');
    // Six digits are easy to type on a phone. Only a private message to this bot counts, with exactly
    // the code, or "/start" and the code, which Telegram sends when the user opens the page's link.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const timeoutMs = options.pairTimeoutMs ?? DEFAULT_PAIR_MS;
    pairing = { state: 'waiting', code, expiresAt: new Date(Date.now() + timeoutMs).toISOString() };
    const abort = new AbortController();
    pairAbort = abort;
    void runPairing(code, timeoutMs, abort);
    res.json({ ok: true, pairing });
  };

  const getPair: RouteHandler = (_req, res) => res.json({ ok: true, pairing });

  const postPairCancel: RouteHandler = (_req, res) => {
    pairAbort?.abort();
    res.json({ ok: true });
  };

  const postTelegramForget: RouteHandler = async (_req, res) => {
    const saved = applyConfigPatch(paths, { telegram_user_id: null, default_surface: 'terminal' });
    if (!saved.ok) {
      return fail(res, 400, 'The Telegram account was not removed.', {
        fieldErrors: saved.fieldErrors,
        generalErrors: saved.generalErrors,
      });
    }
    await h.reloadConfig();
    if (pairing.state !== 'waiting') pairing = { state: 'idle' };
    res.json({ ok: true });
  };

  // ------------------------------------------------------------ the service (§5.1 step 5, §H)

  const getService: RouteHandler = async (_req, res) => {
    let plan;
    try {
      plan = servicePlan(serviceOptions());
    } catch (err) {
      return res.json({ ok: false, error: errorText(err) });
    }
    let status = null;
    let statusError: string | null = null;
    try {
      status = await serviceStatus(serviceOptions());
    } catch (err) {
      statusError = errorText(err);
    }
    res.json({
      ok: true,
      plan,
      cliFound: existsSync(plan.programArguments[1] as string),
      status,
      statusError,
      isThisHarness: status?.pid !== undefined && status.pid === process.pid,
    });
  };

  const postServiceInstall: RouteHandler = async (_req, res) => {
    try {
      const result = await installService({ ...serviceOptions(), callerPid: process.pid });
      options.log(`The service ${result.plan.label} was installed: ${result.plan.plistPath}`);
      res.json({
        ok: true,
        plistPath: result.plan.plistPath,
        label: result.plan.label,
        handover: result.handover,
        replaced: result.replaced,
        heldBack: result.heldBack,
      });
    } catch (err) {
      if (err instanceof ServiceError) return fail(res, 400, err.message);
      fail(res, 500, `The service could not be installed: ${errorText(err)}`);
    }
  };

  // ------------------------------------------------------------ the computer (§H)

  let lastChecks: SystemCheck[] = [];

  const getSystem: RouteHandler = async (_req, res) => {
    try {
      lastChecks = await runSystemChecks({
        ...options.system,
        paths,
        service: serviceOptions(),
        // Asking whether one credential has a value shows that the Keychain answers. No value is read.
        keychain: () => h.secrets.has(MODEL_API_KEY),
      });
      res.json({ ok: true, checkedAt: new Date().toISOString(), groups: GROUP_TITLES, checks: lastChecks });
    } catch (err) {
      fail(res, 500, `The computer could not be checked: ${errorText(err)}`);
    }
  };

  const postSystemOpen: RouteHandler = async (req, res) => {
    const id = bodyObject(req.body)?.id;
    // The address is the one that the check itself gave. The request only names the check.
    const check = lastChecks.find((c) => c.id === id);
    if (check?.settings === undefined) return fail(res, 400, 'This check has no place in System Settings.');
    try {
      await (options.openUrl ?? openWithMacOs)(check.settings);
      res.json({ ok: true });
    } catch (err) {
      fail(res, 500, `System Settings could not be opened: ${errorText(err)}`);
    }
  };

  return [
    { method: 'GET', path: '/api/setup/system', handler: getSystem },
    { method: 'POST', path: '/api/setup/system/open', handler: postSystemOpen },
    { method: 'GET', path: '/api/setup/state', handler: getState },
    { method: 'POST', path: '/api/setup/config', handler: postConfig },
    { method: 'POST', path: '/api/setup/texts', handler: postTexts },
    { method: 'POST', path: '/api/setup/login/check', handler: postLoginCheck },
    { method: 'POST', path: '/api/setup/login/start', handler: postSignInStart },
    { method: 'GET', path: '/api/setup/login/sign-in', handler: getSignIn },
    { method: 'POST', path: '/api/setup/login/cancel', handler: postSignInCancel },
    { method: 'POST', path: '/api/setup/secret', handler: postSecret },
    { method: 'POST', path: '/api/setup/secret/delete', handler: postSecretDelete },
    { method: 'POST', path: '/api/setup/telegram/check', handler: postTelegramCheck },
    { method: 'GET', path: '/api/setup/telegram/pair', handler: getPair },
    { method: 'POST', path: '/api/setup/telegram/pair', handler: postPair },
    { method: 'POST', path: '/api/setup/telegram/pair/cancel', handler: postPairCancel },
    { method: 'POST', path: '/api/setup/telegram/forget', handler: postTelegramForget },
    { method: 'GET', path: '/api/setup/service', handler: getService },
    { method: 'POST', path: '/api/setup/service/install', handler: postServiceInstall },
  ];
}
