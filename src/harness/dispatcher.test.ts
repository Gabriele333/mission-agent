import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../db/index.js';
import { NOT_LOGGED_IN } from '../run/index.js';
import { SYS_GENERAL, SYS_MISSION_ADMIN } from '../types.js';
import { callingText, RECENT_LINE_MAX_CHARS, RECENT_LINES_MAX, WORKING_TEXT } from './dispatcher.js';
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

/** The texts a surface received, without the two fixed lines of the fast step. */
const answers = (texts: string[]) => texts.filter((t) => t !== WORKING_TEXT && !/^Calling [a-z0-9-]+\.$/.test(t));

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
    expect(answers(rig.terminal.texts())).toEqual(['answer to: first', 'answer to: second', 'answer to: third']);
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
  it('sends a chat reply to the surface of the message', async () => {
    const news = rig.create({ name: 'news' });
    await chat('a reply to news', { surface: TELEGRAM, missionId: news });
    await chat('in terminal');
    await rig.dispatcher.idle();
    expect(rig.telegram.sent).toEqual([{ missionId: news, label: 'Ada · news', text: 'answer to: a reply to news' }]);
    // The reply made news the current mission, and the terminal shares it.
    expect(rig.terminal.sent).toEqual([
      { missionId: null, label: 'Ada', text: callingText('news') },
      { missionId: news, label: 'Ada · news', text: 'answer to: in terminal' },
    ]);
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
    expect(rig.terminal.texts()).toEqual([WORKING_TEXT, 'progress from chat run', 'answer to: hi']);
    expect(rig.telegram.texts()).toEqual(['report from timer run']);
  });

  it('on Telegram, triage sends the message to another mission, says so first, and moves its files', async () => {
    const news = rig.create({ name: 'news' });
    rig.classify = () => ({ missionId: news, confidence: 0.95 });
    const generalData = rig.paths.dataDir(SYS_GENERAL);
    mkdirSync(generalData, { recursive: true });
    const file = join(generalData, 'photo.jpg');
    writeFileSync(file, 'x');
    await chat('news about cats', { surface: TELEGRAM, files: [file] });
    await rig.dispatcher.idle();
    expect(rig.telegram.sent[0]).toEqual({ missionId: null, label: 'Ada', text: 'Calling news.' });
    expect(rig.telegram.sent[1]).toEqual({ missionId: news, label: 'Ada · news', text: expect.stringContaining('answer to: news about cats') });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(rig.paths.dataDir(news), 'photo.jpg'))).toBe(true);
    const req = rig.engine.requests[0];
    expect(req?.input.kind === 'chat' && req.input.text).toContain('- data/photo.jpg');
    // Telegram keeps a current mission, as the terminal does (§B.3).
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(news);
  });

  it('triage switches the current mission only above the threshold, on both surfaces', async () => {
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
    rig.classify = () => ({ missionId: SYS_GENERAL, confidence: 0.5 });
    await chat('still news, on Telegram', { surface: TELEGRAM });
    await rig.dispatcher.idle();
    expect(rig.engine.requests.at(-1)?.missionId).toBe(news);
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
    expect(answers(rig.terminal.texts())).toEqual([
      'The run of sys-general failed, also when it was tried again. The run failed: overloaded',
      'The run of news that trigger:cron started stopped at a run limit and was not tried again. The run reached its limit of 50 steps.',
    ]);
  });

  it('says plainly when the model declined', async () => {
    rig.engine.respond = () => ({ status: 'declined', finalText: '', error: 'The model declined the request.' });
    await chat('something');
    await rig.dispatcher.idle();
    expect(answers(rig.terminal.texts())).toEqual(['The run of sys-general ended because the model declined the request.']);
  });

  it('pauses the agent when the model login is missing', async () => {
    rig.engine.respond = () => ({ status: 'failed', finalText: '', error: `${NOT_LOGGED_IN}: sign in. Sign in with: claude auth login` });
    await chat('hello');
    await rig.dispatcher.idle();
    expect(rig.dispatcher.pauseRecord().blocker?.kind).toBe('login');
    expect(answers(rig.terminal.texts())[0]).toContain('The agent is paused because the model login is not ready.');
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
    const list = 'Missions that take chat messages: sys-general (/general), sys-mission-admin (/mission_admin).';
    expect(rig.terminal.texts().at(-1)).toBe(`There is no mission named "nope". ${list}`);
    await chat('/mission timer-only');
    expect(rig.terminal.texts().at(-1)).toBe(
      `The mission timer-only takes no chat messages: its manifest does not list trigger:chat. ${list}`,
    );
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBeUndefined();
  });

  it('/mission works on Telegram too, by name, id or command, and lists the commands', async () => {
    const news = rig.create({ name: 'news' });
    await chat('/mission news', { surface: TELEGRAM });
    expect(rig.telegram.texts().at(-1)).toBe('The current mission is now news.');
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(news);
    await chat('/mission /general', { surface: TELEGRAM });
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(SYS_GENERAL);
    await chat('/mission mission_admin', { surface: TELEGRAM });
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(SYS_MISSION_ADMIN);
    await chat('/mission', { surface: TELEGRAM });
    expect(rig.telegram.texts().at(-1)).toBe(
      'The current mission is sys-mission-admin. To switch, send /mission <name> or the command of the mission. ' +
        'Missions that take chat messages: sys-general (/general), sys-mission-admin (/mission_admin), news (/news).',
    );
    expect(rig.triageInputs).toEqual([]);
  });

  it('/stop stops the current mission, and /stop <mission> the one it names, on every surface', async () => {
    const news = rig.create({ name: 'news' });
    rig.engine.hold = true;
    await chat('/mission news');
    await chat('long job');
    await chat('/stop');
    expect(rig.engine.stops).toEqual([news]);
    expect(rig.cancelled).toContainEqual({ missionId: news, reason: 'the user sent /stop' });
    expect(rig.terminal.texts().at(-1)).toBe('Stopped the run of news. It is not continued and not tried again.');
    await chat('/stop', { surface: TELEGRAM });
    expect(rig.engine.stops).toEqual([news, news]);
    expect(rig.telegram.texts().at(-1)).toBe('The mission news has no run in progress.');
    await chat('/stop general', { surface: TELEGRAM });
    await chat('/stop /news', { surface: TELEGRAM });
    await chat('/stop sys-mission-admin', { surface: TELEGRAM });
    expect(rig.engine.stops).toEqual([news, news, SYS_GENERAL, news, SYS_MISSION_ADMIN]);
    await chat('/stop nope', { surface: TELEGRAM });
    expect(rig.telegram.texts().at(-1)).toBe('There is no mission named "nope", so nothing was stopped.');
    expect(rig.engine.stops).toHaveLength(5);
    await rig.dispatcher.idle();
    // A stopped chat run sends no failure message: the user was told by /stop.
    expect(rig.terminal.texts().filter((t) => t.includes('failed'))).toEqual([]);
  });

  it('answers an unknown command and /improve, and starts no run', async () => {
    await chat('/frobnicate now');
    await chat('/improve');
    await chat('/start');
    await rig.dispatcher.idle();
    const list =
      'The commands are /mission <name>, /stop, /stop <mission>, /pause, /resume and /improve. ' +
      'Each mission that takes chat messages also has its own command. Send /mission to see them.';
    expect(rig.terminal.texts()).toEqual([
      `"/frobnicate now" is not a command. ${list}`,
      'Self-improvement is not part of this version, so /improve does nothing yet.',
      `"/start" is not a command. ${list}`,
    ]);
    expect(rig.engine.requests).toEqual([]);
    expect(rig.triageInputs).toEqual([]);
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

  it('saves nothing for a frozen mission or a mission without trigger:chat', async () => {
    const frozen = rig.create({ name: 'news' });
    rig.registry.setStatus(frozen, 'frozen');
    const timer = rig.create({ name: 'timer-only', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    for (const id of [frozen, timer]) {
      const { msg, calls } = withFiles(id);
      await rig.dispatcher.incoming(msg);
      expect(calls).toEqual([]);
    }
    await rig.dispatcher.incoming(withFiles('m_aaaaaaaaaaaa').msg);
    await rig.dispatcher.idle();
    expect(rig.telegram.texts()).toEqual([
      'The mission news is frozen, so it takes no messages.',
      'The mission timer-only takes no chat messages: its manifest does not list trigger:chat.',
      // A reply to a message of a mission that no longer exists goes to the fast step, and then to a run.
      WORKING_TEXT,
      'answer to: see the file\n\nFiles the user sent, saved in your folder:\n- data/doc.pdf',
    ]);
    expect(rig.engine.requests.map((r) => r.missionId)).toEqual([SYS_GENERAL]);
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

describe('the fast first step (§B.3)', () => {
  it('sends a direct answer of the general mission, starts no run, and writes it to the logbook', async () => {
    rig.classify = () => ({ missionId: SYS_GENERAL, confidence: 0.95, answer: 'Hello! I am Ada.' });
    await chat('hi there', { surface: TELEGRAM });
    await rig.dispatcher.idle();
    expect(rig.telegram.sent).toEqual([{ missionId: SYS_GENERAL, label: 'Ada · sys-general', text: 'Hello! I am Ada.' }]);
    expect(rig.engine.requests).toEqual([]);
    const row = rig.store.listRuns({ missionId: SYS_GENERAL })[0];
    expect(row).toMatchObject({ missionId: SYS_GENERAL, status: 'success', input: 'hi there', finalText: 'Hello! I am Ada.', costUsd: 0 });
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(SYS_GENERAL);
  });

  it('puts the direct exchanges before the next chat text of the general mission, once', async () => {
    rig.classify = (text) =>
      text.startsWith('do') ? { missionId: SYS_GENERAL, confidence: 0.9 } : { missionId: SYS_GENERAL, confidence: 0.9, answer: `re: ${text}` };
    await chat('hello');
    await chat('thanks');
    await chat('do the real work');
    await chat('do more');
    await rig.dispatcher.idle();
    const inputs = rig.engine.requests.map((r) => (r.input.kind === 'chat' ? r.input.text : ''));
    expect(inputs[0]).toBe(
      'Earlier messages of this chat. The fast first step of the harness answered them directly, without a run of this mission:\n' +
        'User: hello\nAnswer: re: hello\nUser: thanks\nAnswer: re: thanks\n\nThe new message:\ndo the real work',
    );
    expect(inputs[1]).toBe('do more');
  });

  it('keeps the direct exchanges for the general mission only, at most 10 and within the size limit', async () => {
    const news = rig.create({ name: 'news' });
    rig.classify = (text) =>
      text === 'news please'
        ? { missionId: news, confidence: 0.95 }
        : text === 'go'
          ? { missionId: SYS_GENERAL, confidence: 0.95 }
          : { missionId: SYS_GENERAL, confidence: 0.95, answer: `a${text}` };
    for (let i = 1; i <= 12; i++) await chat(`q${i}`);
    await chat('news please');
    await rig.dispatcher.idle();
    const newsInput = rig.engine.requests[0]?.input;
    expect(newsInput?.kind === 'chat' && newsInput.text).toBe('news please');
    await chat('go');
    await rig.dispatcher.idle();
    const general = rig.engine.requests[1]?.input;
    const text = general?.kind === 'chat' ? general.text : '';
    expect(text).not.toContain('User: q2\n');
    expect(text).toContain('User: q3\nAnswer: aq3');
    expect(text).toContain('User: q12\nAnswer: aq12');
    expect(text.match(/^User: /gm)).toHaveLength(10);

    // A long exchange pushes the older ones out.
    rig.classify = (t) => (t === 'go' ? { missionId: SYS_GENERAL, confidence: 0.95 } : { missionId: SYS_GENERAL, confidence: 0.95, answer: 'y'.repeat(1500) });
    for (let i = 0; i < 4; i++) await chat(`long ${i}`);
    await chat('go');
    await rig.dispatcher.idle();
    const last = rig.engine.requests.at(-1)?.input;
    const lastText = last?.kind === 'chat' ? last.text : '';
    expect(lastText.match(/^User: /gm)).toHaveLength(2);
    expect(lastText).toContain('User: long 3');
  });

  it('sends "Working on it." before a normal run of the general mission, and "Calling <mission>." every time for another', async () => {
    const news = rig.create({ name: 'news' });
    await chat('plan my week');
    rig.classify = () => ({ missionId: news, confidence: 0.95 });
    await chat('news about cats');
    await chat('and dogs');
    await rig.dispatcher.idle();
    expect(rig.terminal.texts()).toEqual([
      WORKING_TEXT,
      'answer to: plan my week',
      'Calling news.',
      'answer to: news about cats',
      'Calling news.',
      'answer to: and dogs',
    ]);
    // The fixed lines are the harness's own: they carry no mission.
    expect(rig.terminal.sent.filter((m) => m.missionId === null).map((m) => m.text)).toEqual([WORKING_TEXT, 'Calling news.', 'Calling news.']);
  });

  it('uses an answer only when the decision is the general mission and the message has no file', async () => {
    const news = rig.create({ name: 'news' });
    await chat('/mission news');
    // Below the threshold: the message stays with news, and the answer is not used.
    rig.classify = () => ({ missionId: SYS_GENERAL, confidence: 0.5, answer: 'Hi.' });
    await chat('hi');
    await rig.dispatcher.idle();
    expect(rig.engine.requests.map((r) => r.missionId)).toEqual([news]);
    expect(rig.terminal.texts()).not.toContain('Hi.');

    await chat('/general');
    rig.classify = () => ({ missionId: SYS_GENERAL, confidence: 0.9, answer: 'Nice photo.' });
    await rig.dispatcher.incoming({ surface: TELEGRAM, text: 'look', saveFiles: async (t) => [join(rig.paths.dataDir(t), 'a.jpg')] });
    await rig.dispatcher.idle();
    expect(rig.engine.requests.map((r) => r.missionId)).toEqual([news, SYS_GENERAL]);
    expect(rig.telegram.texts()).toEqual([WORKING_TEXT, 'answer to: look\n\nFiles the user sent, saved in your folder:\n- data/a.jpg']);
  });

  it('sends the message to the current mission with no answer when the fast step fails or times out', async () => {
    const news = rig.create({ name: 'news' });
    await chat('/news');
    rig.classify = () => ({ missionId: SYS_GENERAL, confidence: 0, failed: true });
    await chat('what is new?');
    await rig.dispatcher.idle();
    expect(rig.engine.requests.map((r) => r.missionId)).toEqual([news]);
    expect(rig.terminal.texts().slice(-2)).toEqual(['Calling news.', 'answer to: what is new?']);
    expect(rig.logs.some((l) => l.startsWith('Triage: The fast step failed or timed out.'))).toBe(true);
  });

  it('gives the fast step the missions, the last mission and the recent lines, and no run sees those lines', async () => {
    const news = rig.create({ name: 'news' });
    rig.classify = (text) => (text.startsWith('news') ? { missionId: news, confidence: 0.95 } : { missionId: SYS_GENERAL, confidence: 0.9, answer: 'Hi!' });
    await chat('hello');
    await chat(`news ${'x'.repeat(400)}`);
    await rig.dispatcher.idle();
    await chat('anything else?');
    await rig.dispatcher.idle();
    const last = rig.triageInputs.at(-1)!;
    expect(last.text).toBe('anything else?');
    expect(last.lastMission).toBe('news');
    expect(last.candidates.map((c) => c.name)).toEqual(['sys-general', 'sys-mission-admin', 'news']);
    expect(last.recent.map((l) => l.speaker)).toEqual(['user', 'sys-general', 'user', 'news']);
    expect(last.recent[0]).toEqual({ speaker: 'user', text: 'hello' });
    expect(last.recent[2]!.text.length).toBe(RECENT_LINE_MAX_CHARS);
    // The run of news got the user's message only.
    const newsRun = rig.engine.requests.find((r) => r.missionId === news)!;
    expect(newsRun.input.kind === 'chat' && newsRun.input.text).toBe(`news ${'x'.repeat(400)}`);
  });

  it('drops a message whose fast step ends after the dispatcher closed', async () => {
    rig.classify = () => {
      rig.dispatcher.close();
      return { missionId: SYS_GENERAL, confidence: 0.9, answer: 'Hi!' };
    };
    await chat('hi', { surface: TELEGRAM });
    await rig.dispatcher.idle();
    expect(rig.telegram.sent).toEqual([]);
    expect(rig.store.listRuns({})).toEqual([]);
    expect(rig.telegram.signs.map((x) => x.open)).toEqual([false]);
  });

  it('keeps at most 8 recent lines, and none after a restart', async () => {
    rig.classify = () => ({ missionId: SYS_GENERAL, confidence: 0.9, answer: 'ok' });
    for (let i = 0; i < 6; i++) await chat(`m${i}`);
    await chat('again');
    expect(rig.triageInputs.at(-1)!.recent).toHaveLength(RECENT_LINES_MAX);
    expect(rig.triageInputs.at(-1)!.recent.at(-1)).toEqual({ speaker: 'sys-general', text: 'ok' });
    const again = rig.restart();
    await again.incoming({ surface: TERMINAL, text: 'after the restart' });
    expect(rig.triageInputs.at(-1)!.recent).toEqual([]);
    again.close();
  });

  it('makes a mission that writes from a timer run the current mission', async () => {
    const news = rig.create({ name: 'news', triggers: [{ use: 'trigger:chat' }, { use: 'trigger:cron', at: '0 7 * * *' }] });
    rig.engine.hold = true;
    rig.dispatcher.onEvent(news, rig.event('trigger:cron', 'c1'));
    await rig.dispatcher.sendFromRun(news, 'Three new articles today.');
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(news);
    rig.engine.held[0]?.finish();
    await rig.dispatcher.idle();
    await chat('tell me more');
    expect(rig.triageInputs.at(-1)!.lastMission).toBe('news');
    expect(rig.triageInputs.at(-1)!.recent).toEqual([{ speaker: 'news', text: 'Three new articles today.' }]);
  });
});

describe('the order in which a message finds its mission (§B.1)', () => {
  it('a mission command goes to its mission with no model call and no fixed line', async () => {
    const inbox = rig.create({ name: 'inbox-curator' });
    await chat('/inbox_curator check my mail', { surface: TELEGRAM });
    await rig.dispatcher.idle();
    expect(rig.triageInputs).toEqual([]);
    expect(rig.engine.requests.map((r) => [r.missionId, r.input.kind === 'chat' && r.input.text])).toEqual([[inbox, 'check my mail']]);
    expect(rig.telegram.texts()).toEqual(['answer to: check my mail']);
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(inbox);
  });

  it('a mission command alone makes it the current mission', async () => {
    const inbox = rig.create({ name: 'inbox-curator' });
    await chat('/inbox_curator');
    expect(rig.terminal.texts()).toEqual(['Your next messages go to inbox-curator.']);
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(inbox);
    await chat('/general');
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(SYS_GENERAL);
    await chat('/mission_admin@ada_bot');
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(SYS_MISSION_ADMIN);
    expect(rig.triageInputs).toEqual([]);
  });

  it('a mission command for a frozen mission or one without trigger:chat answers as before', async () => {
    const news = rig.create({ name: 'news' });
    rig.registry.setStatus(news, 'frozen');
    rig.create({ name: 'timer-only', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    await chat('/news hello');
    await chat('/timer_only');
    await rig.dispatcher.idle();
    expect(rig.terminal.texts()).toEqual([
      'The mission news is frozen, so it takes no messages.',
      'The mission timer-only takes no chat messages: its manifest does not list trigger:chat.',
    ]);
    expect(rig.engine.requests).toEqual([]);
  });

  it('a mission command with a text waits while the agent is paused', async () => {
    rig.create({ name: 'news' });
    await chat('/pause');
    await chat('/news hello');
    await rig.dispatcher.idle();
    expect(rig.terminal.texts().at(-1)).toContain('The agent is paused, so this message was not passed on.');
    expect(rig.engine.requests).toEqual([]);
  });

  it('a harness command wins over a mission command, and a mission command over a reply', async () => {
    const news = rig.create({ name: 'news' });
    rig.engine.hold = true;
    await chat('/news long job', { surface: TELEGRAM });
    // A reply to a message of news that is a command: the command decides.
    await chat('/stop', { surface: TELEGRAM, missionId: SYS_GENERAL });
    expect(rig.engine.stops).toEqual([news]);
    await chat('/general hello', { surface: TELEGRAM, missionId: news });
    rig.engine.hold = false;
    for (const h of [...rig.engine.held]) h.finish();
    await rig.dispatcher.idle();
    expect(rig.engine.requests.map((r) => r.missionId)).toEqual([news, SYS_GENERAL]);
    expect(rig.triageInputs).toEqual([]);
  });

  it('a reply to a message of a mission goes to it with no model call and no fixed line', async () => {
    const news = rig.create({ name: 'news' });
    await chat('more on that', { surface: TELEGRAM, missionId: news });
    await rig.dispatcher.idle();
    expect(rig.triageInputs).toEqual([]);
    expect(rig.telegram.texts()).toEqual(['answer to: more on that']);
    expect(rig.store.getState(STATE_KEYS.currentChatMission)).toBe(news);
  });
});

describe('the sign that the agent works (§F.1)', () => {
  it('starts when the message arrives, before the fast step, and ends when the reply is sent', async () => {
    let signsAtTriage = -1;
    rig.classify = () => {
      signsAtTriage = rig.telegram.signs.filter((s) => s.open).length;
      return { missionId: SYS_GENERAL, confidence: 0.9 };
    };
    rig.engine.hold = true;
    await chat('plan my week', { surface: TELEGRAM });
    expect(signsAtTriage).toBe(1);
    expect(rig.telegram.signs).toEqual([{ open: true, startedAfter: 0 }]);
    rig.engine.held[0]?.finish();
    await rig.dispatcher.idle();
    expect(rig.telegram.signs).toEqual([{ open: false, startedAfter: 0 }]);
  });

  it('ends after a direct answer, when the run waits for an approval, and for a refused message', async () => {
    rig.classify = () => ({ missionId: SYS_GENERAL, confidence: 0.9, answer: 'Hi!' });
    await chat('hi', { surface: TELEGRAM });
    expect(rig.telegram.signs.map((s) => s.open)).toEqual([false]);

    rig.classify = () => ({ missionId: SYS_GENERAL, confidence: 0.9 });
    rig.engine.hold = true;
    await chat('send the mail', { surface: TELEGRAM });
    expect(rig.telegram.signs.map((s) => s.open)).toEqual([false, true]);
    rig.dispatcher.runWaitsForApproval(SYS_GENERAL);
    expect(rig.telegram.signs.map((s) => s.open)).toEqual([false, false]);
    rig.engine.held[0]?.finish();
    await rig.dispatcher.idle();

    const timer = rig.create({ name: 'timer-only', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    await chat('hello', { surface: TELEGRAM, missionId: timer });
    expect(rig.telegram.signs.map((s) => s.open)).toEqual([false, false, false]);
    // The terminal has no sign.
    await chat('hello');
    expect(rig.telegram.signs).toHaveLength(3);
  });

  it('ends for a message that waits for a mission that is then frozen', async () => {
    const news = rig.create({ name: 'news' });
    rig.engine.hold = true;
    await chat('/news first', { surface: TELEGRAM });
    await chat('/news second', { surface: TELEGRAM });
    rig.registry.setStatus(news, 'frozen');
    rig.engine.held[0]?.finish();
    await rig.dispatcher.idle();
    expect(rig.telegram.signs.map((s) => s.open)).toEqual([false, false]);
  });
});
