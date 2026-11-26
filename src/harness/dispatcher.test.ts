import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../db/index.js';
import { NOT_LOGGED_IN } from '../run/index.js';
import { SYS_GENERAL, SYS_MISSION_ADMIN } from '../types.js';
import { STATE_KEYS } from './state.js';
import { dispatcherRig, TELEGRAM, TERMINAL, type DispatcherRig } from './test-helpers.js';

let rig: DispatcherRig;

beforeEach(() => {
  rig = dispatcherRig();
});

afterEach(() => {
  rig.dispatcher.close();
  rig.cleanUp();
});

const chat = (text: string, extra: { surface?: string; missionId?: string; files?: string[] } = {}) =>
  rig.dispatcher.incoming({ surface: extra.surface ?? TERMINAL, text, ...extra });

const runTexts = () => rig.engine.requests.map((r) => (r.input.kind === 'chat' ? r.input.text : r.input.events.map((e) => e.key).join(',')));

describe('one turn per mission', () => {
  it('runs one turn at a time and keeps queued chat messages in order', async () => {
    rig.engine.hold = true;
    await chat('first');
    await chat('second');
    await chat('third');
    expect(runTexts()).toEqual(['first']);
    rig.engine.held[0]?.finish();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(runTexts()).toEqual(['first', 'second']);
    rig.engine.hold = false;
    rig.engine.held[0]?.finish();
    await rig.dispatcher.idle();
    expect(runTexts()).toEqual(['first', 'second', 'third']);
    expect(rig.terminal.texts()).toEqual(['answer to: first', 'answer to: second', 'answer to: third']);
  });

  it('runs different missions in parallel', async () => {
    const news = rig.create({ name: 'news', triggers: [{ use: 'trigger:chat' }, { use: 'trigger:cron', at: '0 7 * * *' }] });
    rig.engine.hold = true;
    await chat('hello');
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'k1'));
    expect(rig.engine.running().sort()).toEqual([news, SYS_GENERAL].sort());
    for (const h of [...rig.engine.held]) h.finish();
    await rig.dispatcher.idle();
  });
});

describe('events (§B.2)', () => {
  it('groups the waiting events of the oldest trigger into one run, then the next trigger', async () => {
    const news = rig.create({ name: 'news', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    rig.engine.hold = true;
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'c0'));
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'c1'));
    rig.dispatcher.onEvent(news, rig.event('trigger:email.received', 'e1'));
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'c2'));
    expect(runTexts()).toEqual(['c0']);
    rig.engine.hold = false;
    rig.engine.held[0]?.finish();
    await rig.dispatcher.idle();
    expect(runTexts()).toEqual(['c0', 'c1,c2', 'e1']);
    // A trigger run's final text goes to the logbook only (§F.1).
    expect(rig.terminal.sent).toEqual([]);
    expect(rig.telegram.sent).toEqual([]);
  });

  it('drops an event whose key was already seen', async () => {
    const news = rig.create({ name: 'news', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'same'));
    await rig.dispatcher.idle();
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'same'));
    await rig.dispatcher.idle();
    expect(runTexts()).toEqual(['same']);
  });
});

describe('pause and resume (§B.1)', () => {
  it('starts no run while paused, answers chat with the reason, and runs the stored events after /resume', async () => {
    const news = rig.create({ name: 'news', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    await chat('/pause');
    expect(rig.terminal.texts().at(-1)).toContain('The agent is paused.');
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'k1'));
    await chat('are you there?');
    await rig.dispatcher.idle();
    expect(rig.engine.requests).toEqual([]);
    expect(rig.terminal.texts().at(-1)).toContain('The agent is paused, so this message was not passed on. The user sent /pause.');
    await chat('/resume');
    await rig.dispatcher.idle();
    expect(rig.terminal.texts()).toContain('The pause has ended. Waiting timer runs and events start now.');
    expect(runTexts()).toEqual(['k1']);
  });

  it('/pause stops the runs in progress', async () => {
    rig.engine.hold = true;
    await chat('long task');
    await chat('/pause');
    expect(rig.engine.stops).toEqual([SYS_GENERAL]);
    expect(rig.terminal.texts().at(-1)).toContain('Stopped the runs in progress of: sys-general.');
    await rig.dispatcher.idle();
  });

  it('keeps the pause after a restart', async () => {
    await chat('/pause');
    const again = rig.restart();
    expect(again.isPaused()).toBe(true);
    await again.incoming({ surface: TERMINAL, text: 'hello' });
    await again.idle();
    expect(rig.engine.requests).toEqual([]);
    expect(rig.terminal.texts().at(-1)).toContain('The agent is paused');
    again.close();
  });

  it('/resume refuses while a blocker remains', async () => {
    rig.dispatcher.setBlocker({ kind: 'config', reason: 'agent.yaml is missing.', since: '' });
    await chat('/resume');
    expect(rig.terminal.texts().at(-1)).toBe('The agent stays paused. agent.yaml is missing.');
    expect(rig.dispatcher.isPaused()).toBe(true);
  });
});

describe('daily cost limit (§D)', () => {
  it('holds timer runs until the next day, tells the user once, and still runs chat', async () => {
    const news = rig.create({ name: 'news', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    rig.store.insertRun({
      missionId: SYS_GENERAL,
      manifestVersion: 1,
      startedAt: rig.clock.now.toISOString(),
      endedAt: rig.clock.now.toISOString(),
      input: 'x',
      toolsCalled: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 25,
      status: 'success',
      finalText: '',
    });
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'k1'));
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'k2'));
    await rig.dispatcher.idle();
    expect(rig.engine.requests).toEqual([]);
    const notices = rig.terminal.texts().filter((t) => t.includes('daily cost limit'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Chat messages still start runs.');

    await chat('hello');
    await rig.dispatcher.idle();
    expect(runTexts()).toEqual(['hello']);
    expect(rig.terminal.texts().filter((t) => t.includes('daily cost limit'))).toHaveLength(1);

    // The next day the held events run.
    rig.clock.now = new Date(2026, 10, 26, 0, 0, 2);
    expect(rig.timers.length).toBeGreaterThan(0);
    rig.timers[0]?.fn();
    await rig.dispatcher.idle();
    expect(runTexts()).toEqual(['hello', 'k1,k2']);
  });
});

describe('waiting approvals (§G)', () => {
  it('a chat message cancels the waiting action and tells the mission', async () => {
    rig.engine.hold = true;
    await chat('first');
    rig.approval(SYS_GENERAL);
    await chat('second');
    expect(rig.cancelled).toEqual([{ missionId: SYS_GENERAL, reason: 'a new chat message arrived for the mission' }]);
    rig.engine.hold = false;
    rig.engine.held[0]?.finish();
    await rig.dispatcher.idle();
    const second = rig.engine.requests[1];
    expect(second?.notices.join(' ')).toContain('Your request for action:email.send was cancelled');
  });

  it('a timer event cancels the waiting action, another event does not', async () => {
    const news = rig.create({ name: 'news', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    rig.engine.hold = true;
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'c1'));
    rig.approval(news);
    rig.dispatcher.onEvent(news, rig.event('trigger:email.received', 'e1'));
    expect(rig.cancelled).toEqual([]);
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'c2'));
    expect(rig.cancelled).toEqual([{ missionId: news, reason: 'a timer run arrived for the mission' }]);
    rig.engine.hold = false;
    rig.engine.held[0]?.finish();
    await rig.dispatcher.idle();
  });
});

describe('where a message goes (§F.1)', () => {
  it('sends a chat reply to the surface of the message, in the mission thread on Telegram', async () => {
    const news = rig.create({ name: 'news' });
    await chat('in thread', { surface: TELEGRAM, missionId: news });
    await chat('in terminal');
    await rig.dispatcher.idle();
    expect(rig.telegram.sent).toEqual([{ missionId: news, label: 'Ada · news', text: 'answer to: in thread' }]);
    expect(rig.terminal.sent).toEqual([{ missionId: SYS_GENERAL, label: 'Ada · sys-general', text: 'answer to: in terminal' }]);
  });

  it('routes the message tool to the source surface of a chat run and to the default surface for a trigger run', async () => {
    rig.config.defaultSurface = 'telegram';
    const news = rig.create({ name: 'news', triggers: [{ use: 'trigger:chat' }, { use: 'trigger:cron', at: '0 7 * * *' }] });
    rig.engine.hold = true;
    await chat('hi');
    await rig.dispatcher.sendFromRun(SYS_GENERAL, 'progress from chat run');
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'c1'));
    await rig.dispatcher.sendFromRun(news, 'report from timer run');
    for (const h of [...rig.engine.held]) h.finish();
    await rig.dispatcher.idle();
    expect(rig.terminal.texts()).toEqual(['progress from chat run', 'answer to: hi']);
    expect(rig.telegram.texts()).toEqual(['report from timer run']);
  });

  it('in the general thread, triage can send the message to another mission and writes one line there', async () => {
    const news = rig.create({ name: 'news' });
    rig.classify = () => ({ missionId: news, confidence: 0.95 });
    const generalData = rig.paths.dataDir(SYS_GENERAL);
    mkdirSync(generalData, { recursive: true });
    const file = join(generalData, 'photo.jpg');
    writeFileSync(file, 'x');
    await chat('news about cats', { surface: TELEGRAM, files: [file] });
    await rig.dispatcher.idle();
    expect(rig.telegram.sent[0]).toEqual({
      missionId: null,
      label: 'Ada',
      text: "This message went to the mission news. Its answer appears in that mission's thread.",
    });
    expect(rig.telegram.sent[1]?.missionId).toBe(news);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(rig.paths.dataDir(news), 'photo.jpg'))).toBe(true);
    const req = rig.engine.requests[0];
    expect(req?.input.kind === 'chat' && req.input.text).toContain('- data/photo.jpg');
    // The general thread has no current mission (§B.3).
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBeUndefined();
  });

  it('in the terminal, triage switches the current mission only above the threshold', async () => {
    const news = rig.create({ name: 'news' });
    rig.classify = () => ({ missionId: news, confidence: 0.5 });
    await chat('maybe news');
    rig.classify = () => ({ missionId: news, confidence: 0.9 });
    await chat('surely news');
    rig.classify = () => ({ missionId: SYS_GENERAL, confidence: 0.5 });
    await chat('still news');
    await rig.dispatcher.idle();
    expect(rig.engine.requests.map((r) => r.missionId)).toEqual([SYS_GENERAL, news, news]);
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(news);
  });
});

describe('failures (§H)', () => {
  it('tells the user in the chat when a chat run fails, and on the default surface when a trigger run hits a limit', async () => {
    const news = rig.create({ name: 'news', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    rig.engine.respond = (req) =>
      req.input.kind === 'chat'
        ? { status: 'failed', retried: true, finalText: '', error: 'The run failed: overloaded' }
        : { status: 'limit', finalText: 'partial', error: 'The run reached its limit of 50 steps.' };
    await chat('hello');
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'c1'));
    await rig.dispatcher.idle();
    expect(rig.terminal.texts()).toEqual([
      'The run of sys-general failed, also when it was tried again. The run failed: overloaded',
      'The run of news that trigger:cron started stopped at a run limit and was not tried again. The run reached its limit of 50 steps.',
    ]);
  });

  it('says plainly when the model declined', async () => {
    rig.engine.respond = () => ({ status: 'declined', finalText: '', error: 'The model declined the request.' });
    await chat('something');
    await rig.dispatcher.idle();
    expect(rig.terminal.texts()).toEqual(['The run of sys-general ended because the model declined the request.']);
  });

  it('pauses the agent when the model login is missing', async () => {
    rig.engine.respond = () => ({ status: 'failed', finalText: '', error: `${NOT_LOGGED_IN}: sign in. Sign in with: claude auth login` });
    await chat('hello');
    await rig.dispatcher.idle();
    expect(rig.dispatcher.pauseRecord().blocker?.kind).toBe('login');
    expect(rig.terminal.texts()[0]).toContain('The agent is paused because the model login is not ready.');
  });

  it('records a run as in progress while it runs, and clears it after', async () => {
    rig.engine.hold = true;
    await chat('hello');
    expect(rig.store.getState(STATE_KEYS.runsInProgress)).toContain(SYS_GENERAL);
    rig.engine.held[0]?.finish();
    await rig.dispatcher.idle();
    expect(rig.store.getState(STATE_KEYS.runsInProgress)).toBeUndefined();
  });
});

describe('commands (§B.1)', () => {
  it('/mission switches the current mission in the terminal', async () => {
    await chat('/mission sys-mission-admin');
    expect(rig.terminal.texts().at(-1)).toBe('The current mission is now sys-mission-admin.');
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(SYS_MISSION_ADMIN);
    await chat('make me a mission');
    await rig.dispatcher.idle();
    expect(rig.engine.requests[0]?.missionId).toBe(SYS_MISSION_ADMIN);
  });

  it('/mission refuses an unknown name and a mission without trigger:chat, with the list of names', async () => {
    rig.create({ name: 'timer-only', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    await chat('/mission nope');
    expect(rig.terminal.texts().at(-1)).toBe(
      'There is no mission named "nope". Missions that take chat messages: sys-general, sys-mission-admin.',
    );
    await chat('/mission timer-only');
    expect(rig.terminal.texts().at(-1)).toBe(
      'The mission timer-only takes no chat messages: its manifest does not list trigger:chat. Missions that take chat messages: sys-general, sys-mission-admin.',
    );
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBeUndefined();
  });

  it('/mission works in the terminal only', async () => {
    await chat('/mission sys-general', { surface: TELEGRAM });
    expect(rig.telegram.texts()).toEqual(['The /mission command works in the terminal only. Here, write in the thread of the mission.']);
  });

  it('/stop stops the current mission in the terminal and the thread mission on Telegram', async () => {
    const news = rig.create({ name: 'news' });
    rig.engine.hold = true;
    await chat('/mission news');
    await chat('long job');
    await chat('/stop');
    expect(rig.engine.stops).toEqual([news]);
    expect(rig.cancelled).toContainEqual({ missionId: news, reason: 'the user sent /stop' });
    expect(rig.terminal.texts().at(-1)).toBe('Stopped the run of news. It is not continued and not tried again.');
    await chat('/stop', { surface: TELEGRAM });
    expect(rig.engine.stops).toEqual([news, SYS_GENERAL]);
    expect(rig.telegram.texts().at(-1)).toBe('The mission sys-general has no run in progress.');
    await rig.dispatcher.idle();
    // A stopped chat run sends no failure message: the user was told by /stop.
    expect(rig.terminal.texts().filter((t) => t.includes('failed'))).toEqual([]);
  });

  it('answers an unknown command and /improve, and starts no run', async () => {
    await chat('/frobnicate now');
    await chat('/improve');
    await rig.dispatcher.idle();
    expect(rig.terminal.texts()).toEqual([
      '"/frobnicate now" is not a command. The commands are /mission <name> (terminal only), /stop, /pause, /resume and /improve.',
      'Self-improvement is not part of this version, so /improve does nothing yet.',
    ]);
    expect(rig.engine.requests).toEqual([]);
  });
});

describe('missions that take no message (§F.1)', () => {
  it('answers that a mission without trigger:chat takes no messages', async () => {
    const timer = rig.create({ name: 'timer-only', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    await chat('hello', { surface: TELEGRAM, missionId: timer });
    await rig.dispatcher.idle();
    expect(rig.telegram.texts()).toEqual(['The mission timer-only takes no chat messages: its manifest does not list trigger:chat.']);
    expect(rig.engine.requests).toEqual([]);
  });

  it('answers that a frozen mission is frozen', async () => {
    const news = rig.create({ name: 'news' });
    rig.registry.setStatus(news, 'frozen');
    await chat('hello', { surface: TELEGRAM, missionId: news });
    expect(rig.telegram.texts()).toEqual(['The mission news is frozen, so it takes no messages.']);
    expect(rig.engine.requests).toEqual([]);
  });
});

it('a new store has no pause', () => {
  const store = createMemoryStore();
  const r = dispatcherRig({ store });
  expect(r.dispatcher.isPaused()).toBe(false);
  r.dispatcher.close();
  r.cleanUp();
});

describe('files from the user are saved only for an accepted message (§F.1)', () => {
  function withFiles(missionId?: string) {
    const calls: string[] = [];
    const msg = {
      surface: TELEGRAM,
      text: 'see the file',
      ...(missionId !== undefined ? { missionId } : {}),
      saveFiles: async (target: string) => {
        calls.push(target);
        return [join(rig.paths.dataDir(target), 'doc.pdf')];
      },
    };
    return { msg, calls };
  }

  it('saves nothing while the agent is paused', async () => {
    const news = rig.create({ name: 'news' });
    await chat('/pause');
    const { msg, calls } = withFiles(news);
    await rig.dispatcher.incoming(msg);
    await rig.dispatcher.idle();
    expect(calls).toEqual([]);
    expect(rig.telegram.texts().at(-1)).toContain('The agent is paused, so this message was not passed on.');
    expect(rig.engine.requests).toEqual([]);
  });

  it('saves nothing for a frozen mission, a mission without trigger:chat or a deleted mission', async () => {
    const frozen = rig.create({ name: 'news' });
    rig.registry.setStatus(frozen, 'frozen');
    const timer = rig.create({ name: 'timer-only', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    for (const id of [frozen, timer, 'm_aaaaaaaaaaaa']) {
      const { msg, calls } = withFiles(id);
      await rig.dispatcher.incoming(msg);
      expect(calls).toEqual([]);
    }
    await rig.dispatcher.idle();
    expect(rig.telegram.texts()).toEqual([
      'The mission news is frozen, so it takes no messages.',
      'The mission timer-only takes no chat messages: its manifest does not list trigger:chat.',
      'The mission of this thread no longer exists. Write in the general thread instead.',
    ]);
    expect(rig.engine.requests).toEqual([]);
  });

  it('saves the files in the folder of the mission that takes the message, also after triage', async () => {
    const news = rig.create({ name: 'news' });
    const thread = withFiles(news);
    await rig.dispatcher.incoming(thread.msg);
    rig.classify = () => ({ missionId: news, confidence: 0.95 });
    const general = withFiles();
    await rig.dispatcher.incoming(general.msg);
    await rig.dispatcher.idle();
    expect(thread.calls).toEqual([news]);
    expect(general.calls).toEqual([news]);
    const texts = rig.engine.requests.map((r) => (r.input.kind === 'chat' ? r.input.text : ''));
    expect(texts).toEqual([
      'see the file\n\nFiles the user sent, saved in your folder:\n- data/doc.pdf',
      'see the file\n\nFiles the user sent, saved in your folder:\n- data/doc.pdf',
    ]);
  });

  it('passes nothing on when the surface could not save the file', async () => {
    const news = rig.create({ name: 'news' });
    await rig.dispatcher.incoming({ surface: TELEGRAM, text: 'x', missionId: news, saveFiles: async () => undefined });
    await rig.dispatcher.incoming({
      surface: TELEGRAM,
      text: 'y',
      missionId: news,
      saveFiles: async () => {
        throw new Error('disk full');
      },
    });
    await rig.dispatcher.idle();
    expect(rig.engine.requests).toEqual([]);
    expect(rig.telegram.texts()).toEqual(['The file could not be saved, so the message was not passed on. Please send it again.']);
  });
});
