import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalClaudeCommand } from '../run/index.js';
import { MODEL_API_KEY, TELEGRAM_BOT_TOKEN } from '../secrets/index.js';
import { textUpdate, USER } from '../surfaces/telegram/test-helpers.js';
import { SYS_GENERAL } from '../types.js';
import { COMMON_JS } from './assets/common.js';
import { DASHBOARD_JS } from './assets/dashboard.js';
import { SETUP_JS } from './assets/setup.js';
import { qrEncode } from './qr.js';
import { pagesRig, runPageScript, until, type PagesRig, type RigOptions } from './test-helpers.js';

/**
 * Runs the real page scripts against a real harness, in a small fake DOM. There is no browser here:
 * this checks that the scripts run, call the right routes and show the answers as text.
 */

let rigs: PagesRig[] = [];
afterEach(async () => {
  for (const r of rigs) await r.stop();
  rigs = [];
});

async function rig(options: RigOptions = {}): Promise<PagesRig> {
  const r = await pagesRig(options);
  rigs.push(r);
  return r;
}

const API_KEY = 'sk-ant-api03-browser-test-value-42';
const BOT_TOKEN = '123456789:fake-bot-token-for-tests-only-000000';
/** Waits for a step of the first setup: its caption and its title. */
async function waitForStep(page: Awaited<ReturnType<typeof runPageScript>>, n: number, title: string): Promise<void> {
  await page.waitForText(`Step ${n} of 6`);
  expect(page.find((x) => x.tagName === 'H2' && x.textContent === title), title).toBeDefined();
}

/** The texts of the banners on the page. */
function banners(page: Awaited<ReturnType<typeof runPageScript>>): string[] {
  return page.app
    .all()
    .filter((n) => typeof n.className === 'string' && n.className.split(' ').includes('banner'))
    .map((n) => n.textContent);
}

/** A link of the page by its text. */
function link(page: Awaited<ReturnType<typeof runPageScript>>, text: string) {
  const n = page.find((x) => x.tagName === 'A' && x.textContent === text);
  if (n === undefined) throw new Error(`No link "${text}". The page says: ${page.text().slice(0, 800)}`);
  return n;
}

/** Every attribute value and text on the page, to check that a secret is in none of them. */
function everything(page: Awaited<ReturnType<typeof runPageScript>>): string {
  return page.app
    .all()
    .flatMap((n) => [n.textContent, ...n.attributes.values(), typeof n.value === 'string' ? n.value : ''])
    .join('\n');
}

const HOSTILE = '<img src=x onerror=alert(1)></script><script>alert(1)</script> "q" \'s\'';

describe('the setup page script', () => {
  it('shows the checks of the computer, opens System Settings, and checks again', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    r.commandAnswers.defaults = { code: 1, stdout: '', stderr: 'The domain/default pair of (x, autoLoginUser) does not exist' };
    r.commandAnswers.pmset = { code: 0, stdout: 'AC Power:\n sleep                10\n autorestart          1\n', stderr: '' };
    const page = await runPageScript(r, [COMMON_JS, SETUP_JS]);
    await page.waitForText('What every agent needs');

    // The service is not installed, which every agent needs: the top of the page says so.
    expect(page.text()).toContain('This computer needs a change. Not in order: Service.');
    const service = page.byId('check-service').textContent;
    expect(service).toContain('problem');
    expect(service).toContain(`mission-agent service install --root ${r.root}`);
    // A setting for a computer with nobody at it is shown as a choice, not as a fault.
    const login = page.byId('check-auto-login').textContent;
    expect(login).toContain('not set');
    expect(login).not.toContain('problem');
    expect(page.byId('check-keychain').textContent).toContain('in order');
    expect(page.text()).toContain('On a computer that you sit at, they are your choice.');

    const sleep = page.byId('check-sleep');
    expect(sleep.textContent).toContain('sudo pmset -c sleep 0');
    const open = sleep.all().find((n) => n.tagName === 'BUTTON' && n.textContent === 'Open System Settings there');
    await open?.fire('click');
    expect(r.opened).toEqual(['x-apple.systempreferences:com.apple.Energy-Settings.extension']);

    // The user changes the setting, and the page reads it again.
    r.commandAnswers.pmset = { code: 0, stdout: 'AC Power:\n sleep                0\n autorestart          1\n', stderr: '' };
    await page.button('Check the computer again').fire('click');
    await until(() => page.byId('check-sleep').textContent.includes('in order'), 'the sleep check to be in order');
    expect(page.byId('check-sleep').textContent).not.toContain('sudo pmset');
  });

  it('goes through the six steps of the first setup', async () => {
    const r = await rig({ account: { apiKeySource: 'ANTHROPIC_API_KEY' } as AccountInfo });
    const page = await runPageScript(r, [COMMON_JS, SETUP_JS]);
    await waitForStep(page, 1, 'The agent name');
    expect(page.text()).toContain('The agent is paused.');

    page.byId('f-agent-name').value = 'Ada';
    await page.byId('f-agent-name').parent?.parent?.fire('submit');
    await waitForStep(page, 2, 'The model login');
    expect(r.harness.config()?.config.agentName).toBe('Ada');

    // The plan is the default choice. The user chooses the API key card instead.
    expect(page.byId('login-subscription').checked).toBe(true);
    expect(page.byId('login-subscription').type).toBe('radio');
    page.byId('login-api-key').checked = true;
    await page.byId('login-api-key').fire('change');
    await until(() => page.find((n) => n.id === 'secret-credential-model-api-key') !== undefined, 'the API key field');
    expect(r.harness.config()?.config.modelLogin).toBe('api_key');
    expect(r.signIns).toHaveLength(0);

    const key = page.byId('secret-credential-model-api-key');
    key.value = API_KEY;
    await key.parent?.fire('submit');
    await page.waitForText('The login is ready.');
    expect(await r.secrets.get(MODEL_API_KEY)).toBe(API_KEY);
    expect(page.text()).not.toContain(API_KEY);
    expect(page.byId('secret-credential-model-api-key').value).toBe('');
    expect(page.text()).toContain('The agent is running.');

    await page.button('Continue').fire('click');
    await waitForStep(page, 3, 'Telegram');
    await page.button('Skip for now').fire('click');
    await waitForStep(page, 4, 'The limits and the models');
    page.byId('f-run-limits-max-steps').value = '20';
    await page.byId('f-run-limits-max-steps').parent?.parent?.fire('submit');
    await waitForStep(page, 5, 'The service');
    expect(r.harness.config()?.config.runLimits.maxSteps).toBe(20);
    await page.waitForText('What the install writes');
    expect(page.text()).toContain(r.launchAgentsDir);

    // The last step shows the checks of the computer. Sleep is a choice until the user says nobody sits at it.
    r.commandAnswers.pmset = { code: 0, stdout: 'AC Power:\n sleep                10\n autorestart          1\n', stderr: '' };
    await page.button('Continue').fire('click');
    await waitForStep(page, 6, 'The computer');
    await page.button('Check the computer again').fire('click');
    await until(() => page.byId('check-sleep').textContent.includes('not set'), 'the sleep check to be not set');
    expect(page.byId('check-service').textContent).toContain('problem');
    expect(page.byId('check-sleep').textContent).not.toContain('problem');
    expect(page.text()).toContain('Still open: Service.');

    const box = page.byId('unattended');
    expect(box.checked).toBe(false);
    box.checked = true;
    await box.fire('change');
    expect(page.byId('check-sleep').textContent).toContain('problem');
    expect(page.text()).toContain('Still open: Service, Sleep.');

    // The user changes the setting, and the page reads it again. The choice of the box stays.
    r.commandAnswers.pmset = { code: 0, stdout: 'AC Power:\n sleep                0\n autorestart          1\n', stderr: '' };
    await page.button('Check the computer again').fire('click');
    await until(() => page.byId('check-sleep').textContent.includes('in order'), 'the sleep check to be in order');
    expect(page.byId('unattended').checked).toBe(true);
    expect(page.text()).toContain('Still open: Service.');

    // The user can finish with a problem still open.
    await page.button('Finish').fire('click');
    await page.waitForText('The first setup is done.');
    expect(page.text()).toContain('This computer needs a change. Not in order: Service.');
    for (const part of ['Reach the agent', 'Agent', 'Models', 'Limits', 'Telegram', 'Credentials', 'Service', 'Computer']) {
      expect(page.find((n) => n.tagName === 'H2' && n.textContent === part), part).toBeDefined();
    }
    expect(page.text()).toContain('mission-agent chat --root');
  });

  it('shows the errors of the configuration module next to the field', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    const page = await runPageScript(r, [COMMON_JS, SETUP_JS]);
    await page.waitForText('Save limits');
    const field = page.byId('f-triage-switch-confidence');
    field.value = '3';
    await field.parent?.parent?.fire('submit');
    await until(() => page.byId('f-triage-switch-confidence-error').textContent !== '', 'the error');
    expect(page.byId('f-triage-switch-confidence-error').textContent).toBe('triage_switch_confidence must be at most 1.');
    expect(page.byId('f-triage-switch-confidence').getAttribute('aria-invalid')).toBe('true');
  });

  it('shows the error of an invalid agent.yaml, and the sign-in command for a Claude plan', async () => {
    // No sign-in exists yet, so the page offers the sign-in and the terminal command.
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n', account: {} });
    writeFileSync(join(r.root, 'agent.yaml'), 'agent_name: Ada\nmodel_login: subscription\nmax_steps_typo: 3\n');
    await until(() => r.harness.configError() !== undefined, 'the harness to see the invalid file');
    const page = await runPageScript(r, [COMMON_JS, SETUP_JS]);
    await page.waitForText('agent.yaml is invalid.');
    expect(page.text()).toContain('Unknown key "max_steps_typo".');
    expect(page.text()).toContain('The harness keeps the last valid values');
    expect(page.text()).toContain(`CLAUDE_CONFIG_DIR=${join(r.root, 'state', 'claude')} ${terminalClaudeCommand()} auth login`);
  });

  it('starts the sign-in when the user chooses the plan, shows that it waits, and moves on when it ends well', async () => {
    const account: AccountInfo = {};
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: api_key\n', account });
    const page = await runPageScript(r, [COMMON_JS, SETUP_JS]);
    await waitForStep(page, 2, 'The model login');
    expect(page.byId('login-api-key').checked).toBe(true);

    page.byId('login-subscription').checked = true;
    await page.byId('login-subscription').fire('change');
    await page.waitForText('Waiting for you to sign in');
    expect(r.harness.config()?.config.modelLogin).toBe('subscription');
    expect(r.signIns).toHaveLength(1);
    expect(page.text()).toContain("Anthropic's sign-in page opened in the browser of this computer. Approve the sign-in there.");
    expect(page.find((n) => n.tagName === 'SUMMARY' && n.textContent === 'Sign in from a terminal instead')).toBeDefined();
    expect(page.button('Stop waiting')).toBeDefined();
    expect(page.button('Continue').disabled).toBe(true);

    // The user approves on Anthropic's page. The program ends well, and the page moves to the next step.
    account.email = 'user@example.com';
    account.subscriptionType = 'pro';
    r.signIns[0]!.exit(0);
    await waitForStep(page, 3, 'Telegram');
    expect(r.harness.status().paused).toBe(false);
    expect(page.text()).not.toContain('secret-oauth-value');
    // Step 3 says in one small line that the sign-in worked. No banner of step 2 shows on it.
    const line = page.find((n) => n.className === 'carried');
    expect(line?.textContent).toContain('Step 2 is done. You are signed in with your Claude plan.');
    expect(banners(page)).toEqual([]);
    expect(page.text()).not.toContain('The login is ready.');

    // The line belongs to step 3 only.
    await page.button('Skip for now').fire('click');
    await waitForStep(page, 4, 'The limits and the models');
    expect(page.text()).not.toContain('Step 2 is done');
    expect(banners(page)).toEqual([]);
  });

  it('starts the sign-in with its button, and stops waiting when asked', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\n', account: {} });
    const page = await runPageScript(r, [COMMON_JS, SETUP_JS]);
    await waitForStep(page, 2, 'The model login');
    // The plan is already chosen, so arriving at the step starts nothing.
    expect(r.signIns).toHaveLength(0);
    expect(page.text()).toContain("You sign in on Anthropic's own page, in the browser of this computer. The agent never sees your login.");

    await page.button('Sign in with my Claude plan').fire('click');
    await page.waitForText('Waiting for you to sign in');
    expect(r.signIns).toHaveLength(1);
    await page.button('Stop waiting').fire('click');
    await page.waitForText('The sign-in was stopped.', 6000);
    expect(r.signIns[0]!.signals).toEqual(['SIGTERM']);
    expect(page.button('Sign in with my Claude plan')).toBeDefined();
  });

  it('does not start the sign-in when the user chooses the plan and the login is already ready', async () => {
    // Claude Code already holds a sign-in with a plan, but agent.yaml asks for an API key that has no value.
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: api_key\n', account: { email: 'user@example.com', subscriptionType: 'pro' } });
    const page = await runPageScript(r, [COMMON_JS, SETUP_JS]);
    await waitForStep(page, 2, 'The model login');
    page.byId('login-subscription').checked = true;
    await page.byId('login-subscription').fire('change');
    await page.waitForText('The login is ready.');
    expect(r.signIns).toHaveLength(0);
  });
});

describe('the Telegram part of the setup page script', () => {
  it('stores the token, checks the bot by itself, opens the bot with the code, and reports the pairing', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    const page = await runPageScript(r, [COMMON_JS, SETUP_JS]);
    await page.waitForText('Create the bot');

    // Stage 1: BotFather, in a new tab, and what to send to it.
    const botFather = link(page, 'Open BotFather in Telegram');
    expect(botFather.getAttribute('href')).toBe('https://t.me/BotFather');
    expect(botFather.getAttribute('target')).toBe('_blank');
    expect(botFather.getAttribute('rel')).toBe('noopener noreferrer');
    expect(page.text()).toContain('Send /newbot.');
    expect(page.text()).toContain('Send a user name that ends in bot');
    expect(page.find((n) => n.id === 'secret-credential-telegram-bot-token')).toBeUndefined();
    expect(page.text()).not.toContain('Connect your account'.concat('Telegram opens'));

    // Stage 2: one field, with no credential id and no badge.
    await page.button('I have the token').fire('click');
    const token = page.byId('secret-credential-telegram-bot-token');
    expect(token.type).toBe('password');
    expect(page.text()).not.toContain('credential:telegram.bot_token');
    expect(page.text()).not.toContain('no value');
    expect(page.text()).toContain('The token is stored in the macOS Keychain. The page never shows it again.');
    expect(page.find((n) => n.tagName === 'A' && n.textContent === 'Open BotFather in Telegram')).toBeUndefined();
    token.value = BOT_TOKEN;
    await token.parent?.fire('submit');
    // Saving the token checks the bot with no other click.
    await page.waitForText('Bot @ada_bot connected');
    expect(r.telegram.calls('getMe')).toHaveLength(1);
    expect(await r.secrets.get(TELEGRAM_BOT_TOKEN)).toBe(BOT_TOKEN);
    expect(page.text()).not.toContain('Threaded Mode');

    // Stage 3: the pairing starts by itself, and the link opens the bot with the code.
    await page.waitForText('Waiting for you to press Start in Telegram');
    const code = page.find((n) => n.className === 'pair-code')?.textContent ?? '';
    expect(code).toMatch(/^\d{6}$/);
    const open = link(page, 'Open your bot in Telegram');
    expect(open.getAttribute('href')).toBe(`https://t.me/ada_bot?start=${code}`);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
    expect(page.text()).toContain(`Or send this code to @ada_bot: ${code}`);
    expect(page.text()).toContain('Scan it with the camera of your phone, then press Start in Telegram.');

    // The QR code holds the same link: the page draws the matrix of the harness, with a quiet zone.
    const svg = page.find((n) => n.tagName === 'svg');
    const expected = qrEncode(`https://t.me/ada_bot?start=${code}`).rows;
    expect(svg?.getAttribute('viewBox')).toBe(`0 0 ${expected.length + 8} ${expected.length + 8}`);
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toContain('The button "Open your bot in Telegram" does the same.');
    const dark = svg?.children.find((n) => n.tagName === 'path')?.getAttribute('d') ?? '';
    expect(dark.split('M').length - 1).toBe(expected.join('').split('').filter((c) => c === '1').length);
    expect(dark.startsWith(`M${expected[0]!.indexOf('1') + 4} 4h1v1h-1z`)).toBe(true);
    expect(everything(page)).not.toContain(BOT_TOKEN);

    // In Telegram the user presses Start, which sends /start and the code.
    await until(() => r.telegram.calls('getUpdates').length > 0, 'the pairing to poll');
    r.telegram.push(textUpdate(r.telegram, `/start ${code}`));
    await page.waitForText('Your Telegram account is paired.', 6000);
    expect(page.text()).toContain(`Paired with the account ${USER}`);
    expect(page.button('Pair another account')).toBeDefined();
    expect(page.button('Stop using Telegram')).toBeDefined();
    expect(everything(page)).not.toContain(BOT_TOKEN);
  });

  it('says when Threaded Mode is off, holds the pairing back, and checks again', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n', secrets: { [TELEGRAM_BOT_TOKEN]: BOT_TOKEN } });
    r.telegram.script('getMe', () => ({ ok: true, result: { id: 1, is_bot: true, first_name: 'A', username: 'ada_bot' } }));
    const page = await runPageScript(r, [COMMON_JS, SETUP_JS]);
    // The token is stored already, so the page checks the bot by itself.
    await page.waitForText('Turn on Threaded Mode for @ada_bot.');
    expect(page.text()).toContain('Bot @ada_bot connected');
    expect(page.text()).toContain('Without it, the agent cannot create its threads, so it cannot answer you or ask for approvals in Telegram.');
    expect(page.text()).toContain('Choose @ada_bot, open Bot Settings, and turn on Threaded Mode.');
    expect(page.text()).toContain('This comes after Threaded Mode is on.');
    expect(r.telegram.calls('getUpdates')).toHaveLength(0);
    expect(link(page, 'Open BotFather').getAttribute('href')).toBe('https://t.me/BotFather');

    // The user turns it on in BotFather and checks again. The pairing then starts by itself.
    const note = page.find((n) => typeof n.className === 'string' && n.className.includes('topic-note'));
    const again = note?.all().find((n) => n.tagName === 'BUTTON' && n.textContent === 'Check again');
    await again?.fire('click');
    await page.waitForText('Waiting for you to press Start in Telegram');
    expect(page.text()).not.toContain('Threaded Mode');
    expect(r.telegram.calls('getMe')).toHaveLength(2);
  });

  it('shows an error of Telegram in plain words, and keeps the token stage open', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    r.telegram.script('getMe', () => ({ ok: false, error_code: 401, description: 'Unauthorized' }));
    const page = await runPageScript(r, [COMMON_JS, SETUP_JS]);
    await page.waitForText('Create the bot');
    await page.button('I have the token').fire('click');
    const token = page.byId('secret-credential-telegram-bot-token');
    token.value = BOT_TOKEN;
    await token.parent?.fire('submit');
    await page.waitForText('Telegram refused the bot token. Copy the token from BotFather again.');
    expect(page.byId('secret-credential-telegram-bot-token').value).toBe('');
    expect(page.text()).not.toContain('connected');
    expect(r.telegram.calls('getUpdates')).toHaveLength(0);
  });

  it('in the first setup, pairs the account and moves on to the next step by itself', async () => {
    const account: AccountInfo = {};
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n', account });
    const page = await runPageScript(r, [COMMON_JS, SETUP_JS]);
    await waitForStep(page, 2, 'The model login');
    await page.button('Sign in with my Claude plan').fire('click');
    await page.waitForText('Waiting for you to sign in');
    account.email = 'user@example.com';
    account.subscriptionType = 'pro';
    r.signIns[0]!.exit(0);
    await waitForStep(page, 3, 'Telegram');
    expect(page.text()).toContain('Chat with your agent from your phone, in Telegram. This is optional.');
    expect(page.text()).toContain('Without it, you chat with the agent in a terminal on this computer.');
    expect(page.button('Skip for now')).toBeDefined();
    expect(page.text()).not.toContain('default surface');

    await page.button('I have the token').fire('click');
    const token = page.byId('secret-credential-telegram-bot-token');
    token.value = BOT_TOKEN;
    await token.parent?.fire('submit');
    await page.waitForText('Waiting for you to press Start in Telegram');
    // Stage 1 and 2 are one line each now.
    expect(page.text()).toContain('Done: Bot created in BotFather');
    expect(page.text()).toContain('Done: Bot @ada_bot connected');
    expect(page.find((n) => n.id === 'secret-credential-telegram-bot-token')).toBeUndefined();
    const code = page.find((n) => n.className === 'pair-code')?.textContent ?? '';
    await until(() => r.telegram.calls('getUpdates').length > 0, 'the pairing to poll');
    r.telegram.push(textUpdate(r.telegram, `/start ${code}`));

    await waitForStep(page, 4, 'The limits and the models');
    expect(page.find((n) => n.className === 'carried')?.textContent).toContain('Step 3 is done. Your Telegram account is paired with @ada_bot.');
    expect(banners(page)).toEqual([]);
    expect(r.harness.config()?.config.telegramUserId).toBe(USER);
  });
});

describe('the dashboard script', () => {
  it('shows every part, with text from outside as text', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    const now = new Date().toISOString();
    r.harness.store.insertRun({
      missionId: SYS_GENERAL,
      manifestVersion: 1,
      startedAt: now,
      endedAt: now,
      input: HOSTILE,
      toolsCalled: [HOSTILE],
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.5,
      status: 'failed',
      error: HOSTILE,
      finalText: '',
    });
    void r.harness.approvals.request({ missionId: SYS_GENERAL, action: 'action:email.send', toolName: HOSTILE, input: {}, note: HOSTILE });
    const page = await runPageScript(r, [COMMON_JS, DASHBOARD_JS]);
    await page.waitForText('Updated at');
    for (const part of ['The harness', 'Approvals that wait', 'Missions', 'Runs', 'Cost', 'Memory', 'Tools and triggers']) {
      expect(page.find((n) => n.tagName === 'H2' && n.textContent === part), part).toBeDefined();
    }
    expect(page.text()).toContain('Running.');
    expect(page.text()).toContain('sys-mission-admin');
    expect(page.text()).toContain('tool:web_search');
    // The hostile text is in text nodes, and no element came from it.
    const holders = page.app.all().filter((n) => n.nodeType === 3 && n.textContent.includes('<img src=x onerror=alert(1)>'));
    expect(holders.length).toBeGreaterThanOrEqual(4);
    expect(page.tags.has('img')).toBe(false);
    expect(page.tags.has('script')).toBe(false);
    const failedRow = page.find((n) => n.tagName === 'TR' && n.className === 'failed');
    expect(failedRow?.textContent).toContain('failed');
    expect(page.document.title).toBe('Dashboard · Ada');
    r.harness.approvals.cancelAll('test');
  });
});
