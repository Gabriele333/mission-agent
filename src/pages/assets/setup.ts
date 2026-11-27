/**
 * The browser code of the setup page (chapter 5). The first setup has six steps in order (§5.1),
 * shown one at a time. After it, the page shows the five parts of §5.2 and the service. Each answer
 * is saved when the user gives it. A credential value goes in one POST and is never shown again (§J.3).
 * With a Claude plan, the page asks the harness to start Anthropic's own sign-in program. The page
 * never sees the login: it only learns whether the sign-in ended well (§A.5).
 * The text below is JavaScript, not TypeScript, and has no backtick.
 */
export const SETUP_JS = `'use strict';
(function () {
  const el = MA.el;
  const app = document.getElementById('app');
  let data = null;
  let service = null;
  let system = null;
  // True when the user says that this computer runs the agent with nobody at it. Kept in the page only.
  let unattended = false;
  let wizard = null;
  let finished = false;
  let stopped = false;
  let pairTimer = null;
  let signInTimer = null;
  // Messages shown at the top of a part after an action, by part.
  const notes = {};
  // A small line about the step before, such as "Step 2 is done.", shown only on the step it names.
  // A note of one step never shows as a banner on the next step.
  let carried = null;

  MA.setUnauthorized(function () {
    stopped = true;
    MA.replace(app, el('div', { className: 'page' }, el('div', { className: 'banner bad', attrs: { role: 'alert' }, text: 'This page can no longer reach the harness. It may have restarted with a new access token. Run "mission-agent setup" again.' })));
  });

  // ------------------------------------------------------------ loading

  async function reload() {
    const r = await MA.api('GET', '/api/setup/state');
    if (stopped) return;
    if (!r.ok) {
      MA.replace(app, el('div', { className: 'page' }, el('div', { className: 'banner bad', attrs: { role: 'alert' }, text: MA.errorText(r) })));
      return;
    }
    data = r.data;
    if (data.agentName) document.title = 'Setup · ' + data.agentName;
    render();
    watchPairing();
    watchSignIn();
  }

  async function loadService() {
    const r = await MA.api('GET', '/api/setup/service');
    service = r.ok ? r.data : { ok: false, error: MA.errorText(r) };
    if (data) render();
  }

  async function loadSystem() {
    const r = await MA.api('GET', '/api/setup/system');
    if (stopped) return;
    system = r.ok ? r.data : { ok: false, error: MA.errorText(r) };
    if (data) render();
  }

  function note(key, kind, text) {
    notes[key] = { kind: kind, text: text };
  }

  function noteNode(key) {
    const n = notes[key];
    return n ? el('div', { className: 'banner ' + n.kind, attrs: { role: n.kind === 'bad' ? 'alert' : 'status' }, text: n.text }) : null;
  }

  /** A card of the page with a title. */
  function card(id, title, items) {
    return el('section', { className: 'card', id: id }, [el('h2', { text: title })].concat(items));
  }

  /** The row of buttons under a form or a step. quiet holds the quiet actions, shown first. */
  function actions(quiet, primary) {
    return el('div', { className: 'actions' }, [el('div', { className: 'actions-quiet' }, quiet || []), primary || null]);
  }

  // ------------------------------------------------------------ fields

  function fieldId(key) {
    return 'f-' + key.replace(/[^a-z0-9]+/g, '-');
  }

  /**
   * One field of agent.yaml. kind is text, number or select. Returns the node, a read() that gives
   * the value to send, and setErrors() that shows the errors of the configuration module next to it.
   */
  function field(key, label, kind, opts) {
    const o = opts || {};
    const id = fieldId(key);
    const values = data.config.values;
    const current = values[key];
    const def = data.config.defaults[key];
    let input;
    const helpId = id + '-help';
    if (kind === 'select') {
      input = el('select', { id: id, name: key });
      for (const choice of o.choices) {
        const opt = el('option', { value: choice.value, text: choice.text });
        if (String(current) === choice.value) opt.selected = true;
        input.appendChild(opt);
      }
    } else {
      input = el('input', {
        id: id,
        name: key,
        type: 'text',
        value: current === undefined || current === null ? '' : String(current),
        autocomplete: 'off',
        spellcheck: false,
        attrs: kind === 'number' ? { inputmode: 'decimal' } : {},
      });
    }
    const errorBox = el('div', { id: id + '-error' });
    const helpText = [o.help || '', def !== undefined && def !== '' && o.showDefault !== false ? 'Default: ' + def + '.' : ''].join(' ').trim();
    if (helpText) input.setAttribute('aria-describedby', helpId);
    const node = el('div', { className: 'field' }, [
      el('label', { htmlFor: id, text: label }),
      input,
      helpText ? el('p', { className: 'help', id: helpId, text: helpText }) : null,
      errorBox,
    ]);
    function setErrors(list) {
      MA.clear(errorBox);
      if (list && list.length > 0) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', id + '-error' + (helpText ? ' ' + helpId : ''));
        for (const text of list) errorBox.appendChild(el('p', { className: 'error', attrs: { role: 'alert' }, text: text }));
      } else {
        input.removeAttribute('aria-invalid');
      }
    }
    setErrors(data.config.fieldErrors[key]);
    function read() {
      const raw = input.value;
      if (kind === 'select') return raw;
      const t = raw.trim();
      if (t === '') return o.emptyIsDefault === false ? '' : null;
      // A number is sent as a number. Anything else is sent as typed, so the configuration module can say what is wrong.
      if (kind === 'number' && /^-?[0-9]+([.][0-9]+)?$/.test(t)) return Number(t);
      return kind === 'number' ? t : raw;
    }
    return { key: key, node: node, read: read, setErrors: setErrors };
  }

  /** A form of fields that saves to agent.yaml in one POST. quiet holds quiet actions for the row of buttons. */
  function configForm(fields, buttonText, onSaved, quiet) {
    const general = el('div');
    const button = el('button', { type: 'submit', text: buttonText });
    const form = el('form', { attrs: { 'aria-label': buttonText } }, fields.map(function (f) { return f.node; }).concat([general, actions(quiet, button)]));
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      const values = {};
      for (const f of fields) values[f.key] = f.read();
      button.disabled = true;
      const r = await MA.api('POST', '/api/setup/config', { values: values });
      button.disabled = false;
      if (r.ok) {
        if (onSaved) onSaved();
        await reload();
        return;
      }
      const fe = (r.data && r.data.fieldErrors) || {};
      for (const f of fields) f.setErrors(fe[f.key]);
      const other = (r.data && r.data.generalErrors) || [];
      const leftover = Object.keys(fe).filter(function (k) { return !fields.some(function (f) { return f.key === k; }); });
      for (const k of leftover) other.push.apply(other, fe[k]);
      MA.replace(general, [el('p', { className: 'error', attrs: { role: 'alert' }, text: MA.errorText(r) })].concat(other.map(function (t) {
        return el('p', { className: 'error', text: t });
      })));
    });
    return form;
  }

  function effortChoices() {
    return data.efforts.map(function (e) { return { value: e, text: e }; });
  }

  // ------------------------------------------------------------ credentials

  /** Set, replace or delete one credential. The value is read once, sent once, and the box is emptied. */
  function secretRow(id, present, label, partKey) {
    const inputId = 'secret-' + id.replace(/[^a-z0-9]+/g, '-');
    const input = el('input', { id: inputId, type: 'password', autocomplete: 'new-password', spellcheck: false, placeholder: present ? 'Type a new value to replace it' : 'Paste the value' });
    const setButton = el('button', { type: 'submit', text: present ? 'Replace' : 'Save' });
    const form = el('form', { className: 'row input-row' }, [input, setButton]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      let value = input.value;
      input.value = '';
      if (value.trim() === '') {
        note(partKey, 'bad', 'The value is empty. Nothing was stored.');
        render();
        return;
      }
      setButton.disabled = true;
      const r = await MA.api('POST', '/api/setup/secret', { id: id, value: value });
      value = '';
      if (r.ok) note(partKey, 'ok', 'A value for ' + id + ' is stored in the Keychain.');
      else note(partKey, 'bad', MA.errorText(r));
      await reload();
      if (id === data.telegram.tokenId && r.ok) await checkBot();
    });
    const del = present ? el('button', { type: 'button', className: 'danger', text: 'Delete', on: { click: async function () {
      if (!window.confirm('Delete the value of ' + id + ' from the Keychain?')) return;
      const r = await MA.api('POST', '/api/setup/secret/delete', { id: id });
      note(partKey, r.ok ? 'ok' : 'bad', r.ok ? 'The value of ' + id + ' is deleted.' : MA.errorText(r));
      await reload();
    } } }) : null;
    return el('div', { className: 'field' }, [
      el('label', { htmlFor: inputId, text: label || id }),
      el('p', { className: 'help meta' }, [el('code', { text: id }), ' ', el('span', { className: 'badge ' + (present ? 'ok' : 'bad'), text: present ? 'value present' : 'no value' })]),
      form,
      del,
    ]);
  }

  // ------------------------------------------------------------ the parts

  function agentPart() {
    const fields = [
      field('agent_name', 'Agent name', 'text', { help: 'Free text, such as Ada. It replaces {agent name} in the core system prompt.', emptyIsDefault: false }),
      field('default_surface', 'Default surface', 'select', {
        help: 'Where approval requests, notices and reports of timer runs go. Telegram needs your Telegram account.',
        choices: [{ value: 'terminal', text: 'Terminal' }, { value: 'telegram', text: 'Telegram' }],
        showDefault: false,
      }),
    ];
    const core = el('textarea', { id: 'core-prompt', rows: 16, spellcheck: false, value: data.texts.corePrompt });
    const notesText = el('textarea', { id: 'note-paragraph', rows: 6, value: data.texts.noteParagraph });
    async function saveTexts(body, what) {
      const r = await MA.api('POST', '/api/setup/texts', body);
      note('agent', r.ok ? 'ok' : 'bad', r.ok ? what + ' is saved. It applies from the next run.' : MA.errorText(r));
      await reload();
    }
    return card('part-agent', 'Agent', [
      noteNode('agent'),
      configForm(fields, 'Save name and surface'),
      el('h3', { text: 'Core system prompt' }),
      el('p', { className: 'help', text: data.texts.corePromptIsDefault ? 'This is the default text. It is the first part of the system prompt of every run.' : 'This is your own text, from core-prompt.md. It is the first part of the system prompt of every run.' }),
      el('div', { className: 'field' }, [el('label', { htmlFor: 'core-prompt', text: 'Core system prompt' }), core]),
      el('div', { className: 'row' }, [
        el('button', { type: 'button', text: 'Save the core system prompt', on: { click: function () { saveTexts({ corePrompt: core.value }, 'The core system prompt'); } } }),
        el('button', { type: 'button', className: 'secondary', text: 'Use the default text', on: { click: function () { saveTexts({ corePrompt: '' }, 'The default core system prompt'); } } }),
      ]),
      el('h3', { text: 'Paragraph about saving notes' }),
      el('p', { className: 'help', text: 'Added after the mission instructions on every run. Leave it empty to have no paragraph: the file note-paragraph.md is then removed.' }),
      el('div', { className: 'field' }, [el('label', { htmlFor: 'note-paragraph', text: 'Paragraph about saving notes' }), notesText]),
      el('button', { type: 'button', text: 'Save the paragraph', on: { click: function () { saveTexts({ noteParagraph: notesText.value }, 'The paragraph about saving notes'); } } }),
    ]);
  }

  // ------------------------------------------------------------ the model login (§A.5)

  async function checkLogin() {
    const r = await MA.api('POST', '/api/setup/login/check');
    if (r.ok) note('login', 'ok', 'The model login works.');
    else note('login', 'bad', MA.errorText(r));
    await reload();
  }

  /** Asks the harness to start Anthropic's sign-in program. It opens Anthropic's page in the browser of this computer. */
  async function startSignIn() {
    const r = await MA.api('POST', '/api/setup/login/start');
    if (!r.ok) note('login', 'bad', MA.errorText(r));
    else if (r.data.signIn.state === 'failed') note('login', 'bad', r.data.signIn.reason);
    else delete notes.login;
    await reload();
  }

  /** Saves the chosen login. Choosing the plan starts the sign-in at once, unless the login is ready. */
  async function chooseLogin(value) {
    if (value === String(data.config.values.model_login)) return;
    const r = await MA.api('POST', '/api/setup/config', { values: { model_login: value } });
    if (!r.ok) {
      note('login', 'bad', MA.errorText(r));
      await reload();
      return;
    }
    delete notes.login;
    await reload();
    if (!data || value !== 'subscription' || data.login.state === 'ready') return;
    if (data.login.state === 'unknown') {
      // Another reason keeps the pause, so the harness did not check the login. The page checks it first.
      const check = await MA.api('POST', '/api/setup/login/check');
      if (check.ok) {
        await reload();
        return;
      }
    }
    await startSignIn();
  }

  function watchSignIn() {
    if (signInTimer !== null) {
      clearTimeout(signInTimer);
      signInTimer = null;
    }
    if (!data || !data.login.signIn || data.login.signIn.state !== 'waiting') return;
    signInTimer = setTimeout(async function () {
      signInTimer = null;
      const r = await MA.api('GET', '/api/setup/login/sign-in');
      if (stopped) return;
      if (!r.ok || r.data.signIn.state === 'waiting') {
        watchSignIn();
        return;
      }
      const s = r.data.signIn;
      if (s.state === 'done') {
        note('login', 'ok', 'You are signed in with your Claude plan. The login is ready.');
        if (wizard === 2) {
          carried = { step: 3, text: 'Step 2 is done. You are signed in with your Claude plan.' };
          wizard = 3;
        }
      } else {
        note('login', s.state === 'cancelled' ? 'warn' : 'bad', s.reason);
      }
      await reload();
    }, 1500);
  }

  function loginStatus() {
    const l = data.login;
    if (l.state === 'ready') return el('p', { className: 'status-line' }, [el('span', { className: 'badge ok', text: 'ready' }), ' The model login works.']);
    if (l.state === 'not_ready') {
      // With the plan, the sign-in box above says what to do. The long reason would repeat it.
      if (l.modelLogin === 'subscription') return el('p', { className: 'status-line' }, [el('span', { className: 'badge bad', text: 'not ready' }), ' No sign-in with a Claude plan was found.']);
      if (l.modelLogin === 'api_key' && !l.apiKeyPresent) return el('p', { className: 'status-line' }, [el('span', { className: 'badge bad', text: 'not ready' }), ' No key is stored yet.']);
      return el('div', { className: 'status-line' }, [el('span', { className: 'badge bad', text: 'not ready' }), ' ', el('span', { text: l.reason })]);
    }
    return el('p', { className: 'status-line' }, [el('span', { className: 'badge warn', text: 'not checked' }), ' ', l.reason]);
  }

  /** One of the two login cards. It is a real radio input with its label. */
  function loginChoice(value, title, text, chosen) {
    const id = 'login-' + value.replace(/_/g, '-');
    const input = el('input', { id: id, type: 'radio', name: 'model_login', value: value, checked: chosen === value, on: { change: function () {
      if (input.checked) chooseLogin(value);
    } } });
    return el('label', { htmlFor: id, className: 'choice' + (chosen === value ? ' selected' : '') }, [
      input,
      el('span', { className: 'choice-label' }, [el('span', { className: 'choice-title', text: title }), el('span', { className: 'choice-text', text: text })]),
    ]);
  }

  /** The terminal command, for when the automatic sign-in does not work. */
  function terminalSignIn(open) {
    const command = data.login.signInCommand;
    const copied = el('span', { className: 'muted small', attrs: { role: 'status' } });
    return el('details', { className: 'more', open: !!open }, [
      el('summary', { text: 'Sign in from a terminal instead' }),
      el('p', { text: "Run this command in a terminal on this computer. It starts the same sign-in of Anthropic. This page does not run it, and the agent never sees your login." }),
      el('pre', { text: command }),
      el('div', { className: 'row' }, [
        el('button', { type: 'button', className: 'secondary', text: 'Copy the command', on: { click: async function () {
          copied.textContent = (await MA.copy(command)) ? 'Copied.' : 'The browser did not allow copying. Select the text instead.';
        } } }),
        copied,
      ]),
      el('p', { className: 'help', text: 'Then press Check again.' }),
    ]);
  }

  /** What goes under the plan card: the sign-in, its waiting state, or the ready state. */
  function planPanel() {
    const l = data.login;
    const s = l.signIn || { state: 'idle' };
    const items = [];
    if (l.state === 'ready') {
      items.push(el('p', { className: 'help', text: 'A sign-in ends after some time. The agent then pauses and this page offers the sign-in again.' }));
    } else if (s.state === 'waiting') {
      items.push(el('div', { className: 'wait', attrs: { role: 'status' } }, [
        el('p', { className: 'wait-title' }, [el('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }), 'Waiting for you to sign in']),
        el('p', { text: "Anthropic's sign-in page opened in the browser of this computer. Approve the sign-in there. This page moves on by itself." }),
        el('p', { className: 'help', text: 'The page waits until ' + MA.time(s.expiresAt) + '. If no page opened, stop waiting and sign in from a terminal instead.' }),
        el('button', { type: 'button', className: 'secondary', text: 'Stop waiting', on: { click: async function () {
          await MA.api('POST', '/api/setup/login/cancel');
        } } }),
      ]));
    } else if (!l.signInAvailable) {
      items.push(el('p', { className: 'error', attrs: { role: 'alert' }, text: 'Claude Code was not found on this computer, so this page cannot start the sign-in. Sign in from a terminal instead, with the command below.' }));
    } else {
      items.push(el('p', { text: "You sign in on Anthropic's own page, in the browser of this computer. The agent never sees your login. Claude Code keeps it in this agent's folder." }));
      items.push(el('button', { type: 'button', text: 'Sign in with my Claude plan', on: { click: startSignIn } }));
    }
    if (l.state !== 'ready') items.push(terminalSignIn(!l.signInAvailable));
    return items;
  }

  function apiKeyPanel() {
    return [
      secretRow(data.login.apiKeyId, data.login.apiKeyPresent, 'API key', 'login'),
      el('p', { className: 'help', text: 'The key is stored in the macOS Keychain. It is never written to a file and never shown again.' }),
    ];
  }

  function loginPart() {
    const chosen = String(data.config.values.model_login);
    const errors = data.config.fieldErrors.model_login || [];
    const panel = function (items) { return el('div', { className: 'choice-panel' }, items); };
    return el('div', { className: 'login' }, [
      noteNode('login'),
      el('fieldset', { className: 'choices' }, [
        el('legend', { className: 'sr-only', text: 'How runs log in to the model' }),
        loginChoice('subscription', 'My own Claude plan', 'Runs use your Pro or Max plan and draw from its usage limits.', chosen),
        chosen === 'subscription' ? panel(planPanel()) : null,
        loginChoice('api_key', 'An API key', 'Runs use a key from the Claude Console and are billed to that account.', chosen),
        chosen === 'api_key' ? panel(apiKeyPanel()) : null,
      ]),
      errors.map(function (t) { return el('p', { className: 'error', attrs: { role: 'alert' }, text: t }); }),
      el('div', { className: 'row login-foot' }, [
        loginStatus(),
        el('button', { type: 'button', className: 'quiet', text: 'Check again', on: { click: checkLogin } }),
      ]),
    ]);
  }

  function modelFields() {
    return [
      field('default_model', 'Default model', 'text', { help: 'The model of a mission whose manifest sets none.' }),
      field('default_effort', 'Default effort', 'select', { choices: effortChoices() }),
      field('triage_model', 'Triage model', 'text', { help: 'The small model that picks the mission of a chat message.' }),
      field('triage_effort', 'Triage effort', 'select', { choices: effortChoices() }),
    ];
  }

  function limitFields() {
    return [
      field('run_limits.max_steps', 'Steps per run', 'number', { help: 'One step is one model call. A manifest can only lower it.' }),
      field('run_limits.max_cost_usd', 'Cost per run, in dollars', 'number', { help: 'A manifest can only lower it.' }),
      field('run_limits.max_minutes', 'Time per run, in minutes', 'number', { help: 'A manifest can only lower it.' }),
      field('max_cost_per_day_usd', 'Cost per day, in dollars', 'number', { help: 'For the whole agent. Timers and events start no run after it is reached.' }),
      field('approval_wait_hours', 'Wait for an approval, in hours', 'number', { help: 'An action with no answer is cancelled after this time.' }),
      field('triage_switch_confidence', 'Triage confidence needed to switch mission', 'number', { help: 'Between 0 and 1.' }),
      field('retries_after_failure', 'Retries after a failed run', 'number'),
      field('max_index_line_chars', 'Longest line in a memory index, in characters', 'number'),
      field('max_note_bytes', 'Largest note file, in bytes', 'number'),
      field('core_memory_max_lines', 'Core memory lines', 'number'),
      field('core_memory_max_line_chars', 'Longest core memory line, in characters', 'number'),
      field('max_instructions_chars', 'Longest mission instructions, in characters', 'number'),
      field('max_description_chars', 'Longest mission description, in characters', 'number'),
    ];
  }

  function modelsPart() {
    return card('part-models', 'Models', [
      el('h3', { text: 'Model login' }),
      loginPart(),
      el('h3', { text: 'Models and effort' }),
      configForm(modelFields(), 'Save models'),
    ]);
  }

  function limitsPart() {
    return card('part-limits', 'Limits', [
      el('p', { className: 'help', text: 'Empty a box to go back to its default.' }),
      el('div', null, configForm(limitFields(), 'Save limits')),
    ]);
  }

  // ------------------------------------------------------------ Telegram (§5.1 step 3)

  // The Telegram part has three stages: create the bot, paste its token, connect the account.
  // Only the current stage is open. A stage that is done is one line with a check mark.
  // The page checks the bot after the token is saved, and starts the pairing by itself.

  const BOTFATHER = 'https://t.me/BotFather';

  // What the Telegram stages know that the harness does not keep. Kept in the page only.
  const tg = {
    // True when the user says that the bot exists, before a token is stored.
    haveBot: false,
    // True while the user enters a token for a bot that is already connected, and during a save.
    newToken: false,
    checking: false,
    // The text of the last save or bot check that failed.
    tokenError: null,
    // The text of the last start of a pairing that failed.
    pairError: null,
    // The page checks the bot by itself once, and starts the pairing by itself once.
    autoChecked: false,
    autoPaired: false,
    // A short text for a screen reader, after a stage ends.
    said: '',
  };

  /** Asks the harness to check the bot with Telegram. The answer gives the bot's user name and whether Threaded Mode is on. */
  async function checkBot() {
    tg.checking = true;
    tg.tokenError = null;
    render();
    const r = await MA.api('POST', '/api/setup/telegram/check');
    tg.checking = false;
    if (r.ok && r.data && r.data.ok) {
      tg.newToken = false;
      tg.said = 'Bot @' + r.data.username + ' connected.' + (r.data.topicsEnabled ? '' : ' Threaded Mode is off.');
    } else {
      tg.tokenError = MA.errorText(r);
    }
    await reload();
  }

  /** Stores the token in one POST, empties the box, and checks the bot at once. */
  async function saveToken(input, button) {
    let value = input.value;
    input.value = '';
    if (value.trim() === '') {
      tg.tokenError = 'The box is empty. Paste the token that BotFather sent you.';
      render();
      return;
    }
    button.disabled = true;
    tg.newToken = true;
    tg.tokenError = null;
    const r = await MA.api('POST', '/api/setup/secret', { id: data.telegram.tokenId, value: value });
    value = '';
    if (!r.ok) {
      tg.tokenError = MA.errorText(r);
      await reload();
      return;
    }
    tg.autoChecked = true;
    await checkBot();
  }

  async function startPairing() {
    tg.autoPaired = true;
    tg.pairError = null;
    const r = await MA.api('POST', '/api/setup/telegram/pair');
    if (!r.ok) tg.pairError = MA.errorText(r);
    await reload();
  }

  /** True when the bot works and Threaded Mode is on, so the account can be connected. */
  function canPair() {
    const t = data.telegram;
    return t.tokenPresent && !!t.bot && t.bot.topicsEnabled && !tg.newToken && !tg.checking;
  }

  /** Checks the bot and starts the pairing by themselves, each once, while the Telegram stages show. */
  function telegramAuto() {
    if (!data || (wizard !== null && wizard !== 3)) return;
    const t = data.telegram;
    if (t.tokenPresent && !t.bot && !tg.checking && !tg.autoChecked && !tg.newToken) {
      tg.autoChecked = true;
      checkBot();
      return;
    }
    if (canPair() && t.userId === null && t.pairing.state === 'idle' && !tg.autoPaired && !tg.pairError) startPairing();
  }

  function watchPairing() {
    if (pairTimer !== null) {
      clearTimeout(pairTimer);
      pairTimer = null;
    }
    if (!data || data.telegram.pairing.state !== 'waiting') return;
    pairTimer = setTimeout(async function () {
      pairTimer = null;
      const r = await MA.api('GET', '/api/setup/telegram/pair');
      if (!r.ok) return;
      if (r.data.pairing.state === 'waiting') {
        watchPairing();
        return;
      }
      const p = r.data.pairing;
      const t = data.telegram;
      if (p.state === 'paired') {
        tg.said = 'Your Telegram account is paired.';
        if (wizard === 3) {
          // The step is done, so the page moves on. The next step says so in one small line.
          carried = { step: 4, text: 'Step 3 is done. Your Telegram account is paired' + (t.bot ? ' with @' + t.bot.username : '') + '.' };
          wizard = 4;
        } else if (wizard === null) {
          note('telegram', 'ok', 'Your Telegram account is paired. The bot now accepts messages from that account only.');
        }
      } else if (t.userId !== null && wizard === null) {
        // A pairing of another account ended without a new account. Stage 3 stays done, so a note says it.
        note('telegram', p.state === 'cancelled' ? 'warn' : 'bad', p.reason);
      }
      await reload();
    }, 2000);
  }

  /** One stage. state is done, open or later. head holds the quiet actions next to the title. */
  function stage(n, state, title, items, head) {
    return el('li', { className: 'stage ' + state, attrs: state === 'open' ? { 'aria-current': 'step' } : {} }, [
      el('span', { className: 'stage-mark', attrs: { 'aria-hidden': 'true' }, text: state === 'done' ? '✓' : String(n) }),
      el('div', { className: 'stage-body' }, [
        el('div', { className: 'stage-head' }, [
          el('h3', { className: 'stage-title' }, [state === 'done' ? el('span', { className: 'sr-only', text: 'Done: ' }) : null, title]),
          head || null,
        ]),
      ].concat(items || [])),
    ]);
  }

  function quietButton(text, onClick) {
    return el('button', { type: 'button', className: 'quiet', text: text, on: { click: onClick } });
  }

  function checkingLine() {
    return el('p', { className: 'wait-title small', attrs: { role: 'status' } }, [el('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }), 'Checking the bot with Telegram.']);
  }

  /** Stage 1: the user creates the bot in a chat with BotFather. */
  function createBotItems() {
    const copied = el('span', { className: 'muted small', attrs: { role: 'status' } });
    const name = data.agentName ? data.agentName : 'Ada';
    return [
      el('p', { text: 'BotFather is the Telegram bot that creates bots. Only a person can do this step, so the page cannot do it for you.' }),
      el('a', { className: 'button', href: BOTFATHER, text: 'Open BotFather in Telegram' }),
      el('ol', { className: 'send-list' }, [
        el('li', null, [
          'Send ', el('code', { text: '/newbot' }), '.',
          el('button', { type: 'button', className: 'quiet copy', text: 'Copy', attrs: { 'aria-label': 'Copy /newbot' }, on: { click: async function () {
            copied.textContent = (await MA.copy('/newbot')) ? 'Copied.' : 'The browser did not allow copying.';
          } } }),
          copied,
        ]),
        el('li', { text: 'Send a name for the bot, such as ' + name + '.' }),
        el('li', null, ['Send a user name that ends in ', el('code', { text: 'bot' }), ', such as ', el('code', { text: 'my_agent_bot' }), '.']),
        el('li', { text: 'BotFather answers with a token. Copy it.' }),
      ]),
      el('button', { type: 'button', className: 'secondary', text: 'I have the token', on: { click: function () { tg.haveBot = true; render(); } } }),
    ];
  }

  /** Stage 2: the token. It is sent once and never shown again. Saving it checks the bot. */
  function tokenItems() {
    const t = data.telegram;
    // A check that the page started by itself shows only that it checks.
    if (tg.checking && !tg.newToken) return [checkingLine()];
    const inputId = 'secret-' + t.tokenId.replace(/[^a-z0-9]+/g, '-');
    const input = el('input', {
      id: inputId,
      type: 'password',
      autocomplete: 'new-password',
      spellcheck: false,
      placeholder: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ',
      attrs: { 'aria-describedby': 'tg-token-help' + (tg.tokenError ? ' tg-token-error' : ''), 'aria-invalid': tg.tokenError ? 'true' : 'false' },
    });
    const button = el('button', { type: 'submit', text: 'Save and check', disabled: tg.checking });
    const form = el('form', { className: 'row input-row', attrs: { 'aria-label': 'Bot token' } }, [input, button]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      saveToken(input, button);
    });
    const quiet = [];
    if (!t.tokenPresent) quiet.push(quietButton('Show how to create the bot', function () { tg.haveBot = false; tg.tokenError = null; render(); }));
    if (t.tokenPresent && t.bot && tg.newToken && !tg.checking) quiet.push(quietButton('Keep @' + t.bot.username, function () { tg.newToken = false; tg.tokenError = null; render(); }));
    if (t.tokenPresent && tg.tokenError && !tg.checking) quiet.push(quietButton('Check again', checkBot));
    if (t.tokenPresent && wizard === null && !tg.checking) {
      quiet.push(el('button', { type: 'button', className: 'danger', text: 'Delete the token', on: { click: async function () {
        if (!window.confirm('Delete the bot token from the Keychain?')) return;
        const r = await MA.api('POST', '/api/setup/secret/delete', { id: t.tokenId });
        tg.newToken = false;
        tg.haveBot = false;
        tg.tokenError = r.ok ? null : MA.errorText(r);
        if (r.ok) note('telegram', 'ok', 'The bot token is deleted from the Keychain.');
        await reload();
      } } }));
    }
    return [
      el('div', { className: 'field' }, [
        el('label', { htmlFor: inputId, text: 'Bot token' }),
        form,
        el('p', { className: 'help', id: 'tg-token-help', text: 'The token is stored in the macOS Keychain. The page never shows it again.' }),
      ]),
      tg.checking ? checkingLine() : null,
      tg.tokenError ? el('p', { className: 'error', id: 'tg-token-error', attrs: { role: 'alert' }, text: tg.tokenError }) : null,
      quiet.length > 0 ? el('div', { className: 'row stage-actions' }, quiet) : null,
    ];
  }

  /** The note when Threaded Mode is off. The agent cannot write to the user in Telegram without it. */
  function topicNote(bot) {
    const again = el('button', { type: 'button', text: tg.checking ? 'Checking' : 'Check again', disabled: tg.checking, on: { click: checkBot } });
    return el('div', { className: 'banner warn topic-note', attrs: { role: 'status' } }, [
      el('p', null, el('strong', { text: 'Turn on Threaded Mode for @' + bot.username + '.' })),
      el('p', { text: 'Without it, the agent cannot create its threads, so it cannot answer you or ask for approvals in Telegram.' }),
      el('p', { text: 'In Telegram, open BotFather and press Open to start its app. Choose @' + bot.username + ', open Bot Settings, and turn on Threaded Mode.' }),
      el('div', { className: 'row' }, [el('a', { className: 'button secondary', href: BOTFATHER, text: 'Open BotFather' }), again]),
    ]);
  }

  /** The QR code of the link, for the camera of a phone. Dark squares on white, with a quiet zone of four squares. */
  function qrNode(rows, who) {
    return MA.qr(rows, 'QR code of the link that opens ' + who + ' in Telegram with the pairing code. The button "Open your bot in Telegram" does the same.');
  }

  /** Stage 3: the account. The link opens the bot with the code, and Start sends it. */
  function pairItems() {
    const t = data.telegram;
    const p = t.pairing;
    const who = t.bot ? '@' + t.bot.username : 'your bot';
    if (p.state === 'waiting') {
      const link = t.pairLink;
      const stop = quietButton('Stop waiting', async function () {
        await MA.api('POST', '/api/setup/telegram/pair/cancel');
      });
      const until = el('p', { className: 'help', text: 'The page waits until ' + MA.time(p.expiresAt) + '. The first account that sends the code becomes the account of the agent.' });
      if (!link) {
        return [el('div', { className: 'wait' }, [
          el('p', { className: 'wait-title', attrs: { role: 'status' } }, [el('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }), 'Waiting for the code']),
          el('p', { text: 'Send this code to ' + who + ' in a private chat. This page moves on by itself.' }),
          el('pre', { className: 'code-big', text: p.code }),
          until,
          stop,
        ])];
      }
      return [el('div', { className: 'wait' }, [
        el('p', { className: 'wait-title', attrs: { role: 'status' } }, [el('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }), 'Waiting for you to press Start in Telegram']),
        el('div', { className: 'pair' }, [
          t.pairQr ? el('div', { className: 'pair-qr' }, [
            qrNode(t.pairQr, who),
            el('p', { className: 'help', text: 'Scan it with the camera of your phone, then press Start in Telegram.' }),
          ]) : null,
          el('div', { className: 'pair-text' }, [
            el('a', { className: 'button', href: link, text: 'Open your bot in Telegram' }),
            el('p', { text: 'Telegram opens the chat with ' + who + '. Press Start there. The bot does not reply, and this page moves on by itself.' }),
            el('p', { className: 'help' }, ['Or send this code to ' + who + ': ', el('code', { className: 'pair-code', text: p.code })]),
          ]),
        ]),
        until,
        stop,
      ])];
    }
    const items = [];
    if (tg.pairError) items.push(el('p', { className: 'error', attrs: { role: 'alert' }, text: tg.pairError }));
    else if (p.state === 'failed') items.push(el('p', { className: 'error', attrs: { role: 'alert' }, text: p.reason }));
    else if (p.state === 'cancelled') items.push(el('p', { className: 'muted', attrs: { role: 'status' }, text: p.reason }));
    items.push(el('p', { text: 'The page shows a link to your bot. You press Start, and the bot learns your account.' }));
    items.push(el('button', { type: 'button', text: p.state === 'idle' && !tg.pairError ? 'Connect my account' : 'Try again', on: { click: startPairing } }));
    return items;
  }

  /** The three stages. The wizard and the Telegram part of all settings both show them. */
  function telegramStages() {
    const t = data.telegram;
    const p = t.pairing;
    const s1 = t.tokenPresent || tg.haveBot;
    const s2 = t.tokenPresent && !!t.bot && !tg.newToken;
    const s3 = t.userId !== null && p.state !== 'waiting';
    const topicsOff = s2 && !t.bot.topicsEnabled;
    const list = [];

    list.push(s1
      ? stage(1, 'done', 'Bot created in BotFather')
      : stage(1, 'open', 'Create the bot', createBotItems()));

    if (s2) {
      list.push(stage(2, 'done', 'Bot @' + t.bot.username + ' connected', topicsOff ? [topicNote(t.bot)] : [],
        quietButton('Use another bot', function () { tg.newToken = true; tg.tokenError = null; render(); })));
    } else {
      list.push(stage(2, s1 ? 'open' : 'later', 'Paste the token', s1 ? tokenItems() : []));
    }

    if (s3) {
      list.push(stage(3, 'done', 'Paired with the account ' + t.userId, wizard === null
        ? [el('p', { className: 'help stage-detail', text: 'The bot accepts messages from this account only. ' + (t.surfaceRunning ? 'The agent reads its messages now.' : 'The agent does not read its messages now.') })]
        : []));
    } else if (s2 && !topicsOff) {
      list.push(stage(3, 'open', 'Connect your account', pairItems()));
    } else {
      list.push(stage(3, 'later', 'Connect your account', topicsOff ? [el('p', { className: 'help stage-detail', text: 'This comes after Threaded Mode is on.' })] : []));
    }

    const said = tg.said;
    tg.said = '';
    return el('div', { className: 'telegram' }, [
      el('ol', { className: 'stages', attrs: { 'aria-label': 'Set up Telegram' } }, list),
      el('p', { className: 'sr-only', attrs: { role: 'status' }, text: said }),
    ]);
  }

  function telegramPart() {
    const t = data.telegram;
    const items = [
      noteNode('telegram'),
      el('p', { className: 'help', text: 'Chat with your agent from your phone. Without Telegram, you chat with the agent in a terminal on this computer.' }),
      telegramStages(),
    ];
    if (t.userId !== null && t.pairing.state !== 'waiting') {
      items.push(el('div', { className: 'row stage-actions' }, [
        el('button', { type: 'button', className: 'secondary', text: 'Pair another account', on: { click: async function () {
          delete notes.telegram;
          await startPairing();
          if (tg.pairError) {
            note('telegram', 'bad', tg.pairError);
            tg.pairError = null;
            render();
          }
        } } }),
        el('button', { type: 'button', className: 'danger', text: 'Stop using Telegram', on: { click: async function () {
          if (!window.confirm('Remove your Telegram account from the agent? You then chat with the agent in a terminal on this computer.')) return;
          // The page must not start a new pairing by itself after this.
          tg.autoPaired = true;
          const r = await MA.api('POST', '/api/setup/telegram/forget');
          note('telegram', r.ok ? 'ok' : 'bad', r.ok ? 'Telegram is no longer used. The bot token stays in the Keychain until you delete it.' : MA.errorText(r));
          await reload();
        } } }),
      ]));
    }
    return card('part-telegram', 'Telegram', items);
  }

  // ------------------------------------------------------------ credentials and service

  function credentialsPart() {
    const list = data.credentials;
    const rows = list.length === 0
      ? [el('p', { className: 'muted', text: 'No credential is required now.' })]
      : list.map(function (c) { return secretRow(c.id, c.present, c.id, 'credentials'); });
    return card('part-credentials', 'Credentials', [
      noteNode('credentials'),
      el('p', { className: 'help', text: 'Each credential that the harness, the tools and the triggers of active missions need. Values are in the macOS Keychain. The page never shows a value.' }),
    ].concat(rows));
  }

  function serviceBody() {
    const items = [noteNode('service')];
    if (wizard === null) items.push(el('p', { text: 'The service starts the harness when you log in, and starts it again after a crash. It is a LaunchAgent of your macOS account.' }));
    if (service === null) {
      items.push(el('p', { className: 'muted', text: 'Reading the state of the service.' }));
    } else if (!service.ok) {
      items.push(el('p', { className: 'error', text: service.error }));
    } else {
      const plan = service.plan;
      const st = service.status;
      let stateText = 'Not installed.';
      if (st && st.loaded) stateText = 'Installed and loaded' + (st.pid ? ', running as process ' + st.pid : '') + '.';
      else if (st && st.installed) stateText = 'The file is installed, but launchd has not loaded it.';
      if (service.statusError) stateText = 'The state could not be read: ' + service.statusError;
      items.push(el('p', { className: 'status-line' }, [el('strong', { text: 'State: ' }), stateText]));
      const facts = el('ul', { className: 'facts small' }, [
        el('li', null, ['The file ', el('code', { text: plan.plistPath })]),
        el('li', null, ['The label ', el('code', { text: plan.label })]),
        el('li', null, ['The command ', el('code', { text: plan.programArguments.join(' ') })]),
        el('li', null, ['The root folder ', el('code', { text: plan.root })]),
        el('li', null, ['The logs ', el('code', { text: plan.stdoutPath }), ' and ', el('code', { text: plan.stderrPath })]),
        el('li', null, ['The PATH of the harness, taken from the shell that started it: ', el('code', { text: plan.envPath })]),
      ]);
      if (wizard === null) items.push(el('h3', { text: 'What the install writes' }), facts);
      else items.push(el('details', { className: 'more' }, [el('summary', { text: 'What the install writes' }), facts]));
      items.push(el('details', { className: 'more' }, [el('summary', { text: 'Show the whole file' }), el('pre', { text: plan.plistText })]));
      if (!service.cliFound) items.push(el('p', { className: 'error', text: 'The built program ' + plan.programArguments[1] + ' cannot be found. Build it first with: npm run build' }));
      if (service.isThisHarness) items.push(el('p', { className: 'good', text: 'This harness runs as the service.' }));
      const button = el('button', { type: 'button', className: wizard === null ? '' : 'secondary', text: st && st.installed ? 'Install again' : 'Install the service', disabled: !service.cliFound || service.isThisHarness, on: { click: async function () {
        button.disabled = true;
        const r = await MA.api('POST', '/api/setup/service/install');
        if (r.ok) {
          note('service', r.data.heldBack ? 'warn' : 'ok', (r.data.handover
            ? 'The service is installed. This harness still runs in your terminal. Stop it there with Ctrl+C: the service then starts the harness within about ten seconds, and this page must be opened again with "mission-agent setup".'
            : 'The service is installed and loaded.')
            + (r.data.heldBack ? ' launchd held back its start. See "Restart after a crash" under Computer below.' : ''));
        } else {
          note('service', 'bad', MA.errorText(r));
        }
        await loadService();
        await loadSystem();
      } } });
      items.push(button);
    }
    return items;
  }

  function servicePart() {
    return card('part-service', 'Service', serviceBody());
  }

  // ------------------------------------------------------------ the computer (§H)

  // A setting that is not in order counts as a problem when every agent needs it, or when the
  // user says that this computer runs the agent with nobody at it.
  function isProblem(c) {
    return c.state === 'not_ok' && (c.group === 'needed' || unattended);
  }

  // The settings that are not in order and count as a problem.
  function systemProblems() {
    if (!system || !system.ok) return [];
    return system.checks.filter(isProblem);
  }

  /** The kind of a check: ok, unknown, problem, or a choice that is not set. */
  function checkKind(c) {
    if (c.state === 'ok') return 'ok';
    if (c.state === 'unknown') return 'unknown';
    // A setting for a computer with nobody at it is a choice on any other computer.
    return isProblem(c) ? 'bad' : 'warn';
  }

  const CHECK_MARKS = { ok: '✓', unknown: '?', bad: '!', warn: '–' };
  const CHECK_WORDS = { ok: 'in order', unknown: 'unknown', bad: 'problem', warn: 'not set' };

  function unattendedBox() {
    const box = el('input', { id: 'unattended', type: 'checkbox', checked: unattended, on: { change: function () {
      unattended = !!box.checked;
      render();
    } } });
    return el('p', { className: 'check-box' }, [el('label', { htmlFor: 'unattended' }, [box, ' This computer runs the agent with nobody at it'])]);
  }

  function checkRow(c) {
    const kind = checkKind(c);
    const body = [
      el('p', { className: 'check-head' }, [el('strong', { text: c.title }), ' ', el('span', { className: 'badge ' + kind, text: CHECK_WORDS[kind] })]),
      el('p', { className: 'check-detail', text: c.detail }),
    ];
    if (c.state === 'not_ok') {
      if (c.fix) body.push(el('p', { className: 'small' }, [el('strong', { text: 'What to do: ' }), c.fix]));
      if (c.command) body.push(el('pre', { text: c.command }));
      if (c.settings) {
        const button = el('button', { type: 'button', className: 'secondary', text: 'Open System Settings there', on: { click: async function () {
          button.disabled = true;
          const r = await MA.api('POST', '/api/setup/system/open', { id: c.id });
          if (!r.ok) note('system', 'bad', MA.errorText(r));
          button.disabled = false;
          if (!r.ok) render();
        } } });
        body.push(button);
      }
    }
    return el('li', { id: 'check-' + c.id, className: 'check ' + kind }, [
      el('span', { className: 'mark ' + kind, attrs: { 'aria-hidden': 'true' }, text: CHECK_MARKS[kind] }),
      el('div', { className: 'check-body' }, body),
    ]);
  }

  function systemBody() {
    const items = [noteNode('system')];
    if (wizard === null) items.push(el('p', { text: 'The settings of this computer that the agent depends on. The page only reads them. You change them in System Settings, or with the command shown.' }));
    if (system === null) {
      items.push(el('p', { className: 'muted', text: 'Checking the computer.' }));
    } else if (!system.ok) {
      items.push(el('p', { className: 'error', text: system.error }));
    } else {
      ['needed', 'unattended'].forEach(function (group) {
        const list = system.checks.filter(function (c) { return c.group === group; });
        if (list.length === 0) return;
        items.push(el('h3', { text: system.groups[group] }));
        if (group === 'unattended') {
          items.push(el('p', { className: 'help', text: 'These matter for a computer with no screen that must keep the agent running. On a computer that you sit at, they are your choice.' }));
          items.push(unattendedBox());
        }
        items.push(el('ul', { className: 'checks' }, list.map(checkRow)));
      });
      items.push(el('p', { className: 'muted small', text: 'Checked at ' + new Date(system.checkedAt).toLocaleTimeString() + '. The page checks again every minute.' }));
    }
    const again = el('button', { type: 'button', className: 'secondary', text: 'Check the computer again', on: { click: async function () {
      again.disabled = true;
      delete notes.system;
      await loadSystem();
    } } });
    items.push(again);
    return items;
  }

  function systemPart() {
    return card('part-system', 'Computer', systemBody());
  }

  function reachPart() {
    const t = data.telegram;
    return card('part-reach', 'Reach the agent', [
      el('p', { text: 'In a terminal on this computer:' }),
      el('pre', { text: data.commands.chat }),
      t.userId !== null
        ? el('p', { text: 'On Telegram: write to ' + (t.bot ? '@' + t.bot.username : 'your bot') + '. Each mission has its own thread.' })
        : el('p', { className: 'muted', text: 'Telegram is not set up.' }),
    ]);
  }

  // ------------------------------------------------------------ status and banners

  /** The state of the agent, as a small line at the top. The reason of a pause stays readable. */
  function statusBar() {
    const h = data.harness;
    if (!h.paused) {
      return el('div', { className: 'status', attrs: { role: 'status' } }, [
        el('span', { className: 'pill ok' }, [el('span', { className: 'dot', attrs: { 'aria-hidden': 'true' } }), 'Running']),
        el('span', { text: 'The agent is running.' }),
        el('span', { className: 'muted', text: 'A new value applies from the next run.' }),
      ]);
    }
    const reason = el('span', { className: 'status-reason', text: h.pauseReason });
    return el('div', { className: 'status', attrs: { role: 'status' } }, [
      el('span', { className: 'pill warn' }, [el('span', { className: 'dot', attrs: { 'aria-hidden': 'true' } }), 'Paused']),
      el('strong', { text: 'The agent is paused.' }),
      // In the first setup, the steps already say what to do, so the reason is one click away.
      wizard !== null ? el('details', { className: 'status-why' }, [el('summary', { text: 'Why' }), reason]) : reason,
    ]);
  }

  function banners() {
    const out = [];
    const c = data.config;
    if (c.error) {
      out.push(el('div', { className: 'banner bad', attrs: { role: 'alert' } }, [
        el('strong', { text: 'agent.yaml is invalid. ' }),
        data.harness.usesLastValidValues ? 'The harness keeps the last valid values until the file is fixed. ' : 'The harness stays paused until the file is fixed. ',
        'The errors are also shown next to each field below.',
        el('pre', { text: c.error }),
      ]));
    }
    const problems = systemProblems();
    if (problems.length > 0 && wizard === null) {
      out.push(el('div', { className: 'banner warn' }, [
        el('strong', { text: 'This computer needs a change. ' }),
        'Not in order: ' + problems.map(function (c) { return c.title; }).join(', ') + '. See ',
        el('a', { href: '#part-system', text: 'Computer' }),
        ' below.',
      ]));
    }
    return out;
  }

  // ------------------------------------------------------------ the first setup (§5.1)

  const STEPS = ['The agent name', 'The model login', 'Telegram', 'The limits and the models', 'The service', 'The computer'];
  const SHORT = ['Name', 'Login', 'Telegram', 'Limits', 'Service', 'Computer'];

  function stepDone(i) {
    if (i === 1) return !!data.agentName;
    if (i === 2) return data.login.state === 'ready';
    if (i === 3) return data.telegram.userId !== null;
    if (i === 5) return !!(service && service.ok && service.status && service.status.installed);
    if (i === 6) return !!(system && system.ok && systemProblems().length === 0);
    return false;
  }

  /** Six markers. The names are short on screen, and whole for a screen reader. */
  function progress() {
    return el('nav', { className: 'progress', attrs: { 'aria-label': 'Steps of the first setup' } }, el('ol', null, STEPS.map(function (title, i) {
      const n = i + 1;
      const done = stepDone(n);
      const current = n === wizard;
      const spoken = 'Step ' + n + ': ' + title + (done ? ', done' : '') + (n === 3 && !done ? ', you can skip it' : '');
      return el('li', { className: (done ? 'done' : '') + (current ? ' current' : ''), attrs: current ? { 'aria-current': 'step' } : {} }, [
        el('span', { className: 'marker', attrs: { 'aria-hidden': 'true' }, text: done && !current ? '✓' : String(n) }),
        el('span', { className: 'label', attrs: { 'aria-hidden': 'true' }, text: SHORT[i] }),
        el('span', { className: 'sr-only', text: spoken }),
      ]);
    })));
  }

  function back() {
    return el('button', { type: 'button', className: 'quiet', text: 'Back', on: { click: function () { carried = null; wizard -= 1; render(); } } });
  }

  function allSettings() {
    return el('a', { href: '#', className: 'quiet-link', text: 'Show all settings instead', on: { click: function (ev) { ev.preventDefault(); carried = null; wizard = null; render(); } } });
  }

  function next(text, enabled) {
    return el('button', { type: 'button', text: text, disabled: !enabled, on: { click: function () {
      carried = null;
      if (wizard === STEPS.length) {
        wizard = null;
        finished = true;
      } else {
        wizard += 1;
      }
      render();
    } } });
  }

  /** One step: a caption, the title, what the step asks, and its row of buttons. */
  function step(n, items) {
    return el('section', { className: 'card step', attrs: { 'aria-labelledby': 'step-title' } }, [
      el('p', { className: 'step-caption', text: 'Step ' + n + ' of ' + STEPS.length }),
      el('h2', { className: 'step-title', id: 'step-title', text: STEPS[n - 1] }),
    ].concat(items));
  }

  /** The small line about the step before. It shows on the step it names only. */
  function carriedLine() {
    if (!carried || carried.step !== wizard) return null;
    return el('p', { className: 'carried', attrs: { role: 'status' } }, [el('span', { className: 'carried-mark', attrs: { 'aria-hidden': 'true' }, text: '✓' }), carried.text]);
  }

  function wizardStep() {
    const n = wizard;
    if (n === 1) {
      const name = field('agent_name', 'Agent name', 'text', { help: 'Free text, such as Ada. The agent uses it in every message.', emptyIsDefault: false });
      return step(1, [
        el('p', { className: 'lead', text: 'Give your agent a name. You can change it later.' }),
        configForm([name], 'Save and continue', function () { wizard = 2; }, [allSettings()]),
      ]);
    }
    if (n === 2) {
      const ready = data.login.state === 'ready';
      return step(2, [
        el('p', { className: 'lead', text: 'Choose how runs log in to the model. One of the two is required.' }),
        loginPart(),
        ready ? el('p', { className: 'good', text: 'The login is ready. The agent ended its pause by itself.' }) : el('p', { className: 'muted small', text: 'Continue is possible once the login is ready.' }),
        actions([back(), allSettings()], next('Continue', ready)),
      ]);
    }
    if (n === 3) {
      const t = data.telegram;
      const done = t.userId !== null;
      const skip = el('button', { type: 'button', className: done ? '' : 'secondary', text: done ? 'Continue' : 'Skip for now', on: { click: async function () {
        carried = null;
        // The user said no to Telegram for now, so a pairing that waits is stopped.
        if (!done && t.pairing.state === 'waiting') await MA.api('POST', '/api/setup/telegram/pair/cancel');
        wizard = 4;
        render();
      } } });
      return step(3, [
        el('p', { className: 'lead', text: 'Chat with your agent from your phone, in Telegram. This is optional. Without it, you chat with the agent in a terminal on this computer.' }),
        telegramStages(),
        actions([back(), allSettings()], skip),
      ]);
    }
    if (n === 4) {
      const fields = modelFields().concat(limitFields());
      return step(4, [
        el('p', { className: 'lead', text: 'These are the defaults. Keep them or change them, then save.' }),
        configForm(fields, 'Save and continue', function () { wizard = 5; }, [back(), allSettings()]),
      ]);
    }
    if (n === 5) {
      return step(5, [
        el('p', { className: 'lead', text: 'Install the harness as a service of your macOS account. It then starts when you log in, and again after a crash. You can also do this later.' }),
        el('div', null, serviceBody()),
        actions([back(), allSettings()], next('Continue', true)),
      ]);
    }
    return step(6, [
      el('p', { className: 'lead', text: 'The settings of this computer that the agent depends on. The page only reads them. Change each setting that is not in order, then press Check the computer again. You can finish with a problem still open, because some changes need you to log out first.' }),
      el('div', null, systemBody()),
      computerSummary(),
      actions([back(), allSettings()], next('Finish', true)),
    ]);
  }

  // What the last step says about the problems that are still open.
  function computerSummary() {
    if (!system || !system.ok) return null;
    const open = systemProblems();
    if (open.length === 0) return el('p', { className: 'good', text: 'No problem is open.' });
    return el('div', { className: 'banner warn', attrs: { role: 'status' } }, [
      el('strong', { text: 'Still open: ' + open.map(function (c) { return c.title; }).join(', ') + '. ' }),
      'You can finish now and change them later. The Computer part of this page shows them again.',
    ]);
  }

  // ------------------------------------------------------------ the page

  function render() {
    if (stopped || !data) return;
    const out = [statusBar()].concat(banners());
    if (wizard !== null) {
      out.push(el('h1', { className: 'page-title', text: 'First setup' }));
      out.push(progress());
      out.push(carriedLine());
      out.push(wizardStep());
    } else {
      if (finished) out.push(el('div', { className: 'banner ok', attrs: { role: 'status' }, text: 'The first setup is done. Each part below can be changed at any time.' }));
      // Step 4 has no done state. Step 6 is left out because the banner above already names its problems.
      const open = STEPS.map(function (t, i) { return stepDone(i + 1) ? null : t; }).filter(function (t, i) { return t !== null && i !== 3 && i !== 5; });
      if (!finished && open.length > 0) {
        out.push(el('section', { className: 'card todo' }, [
          el('h2', { text: 'First setup' }),
          el('p', { text: 'Not done yet: ' + open.join(', ') + '.' }),
          el('button', { type: 'button', text: 'Go through the first setup steps', on: { click: function () { wizard = 1; render(); } } }),
        ]));
      }
      out.push(reachPart(), agentPart(), modelsPart(), limitsPart(), telegramPart(), credentialsPart(), servicePart(), systemPart());
    }
    MA.replace(app, el('div', { className: 'page ' + (wizard !== null ? 'wizard' : 'settings') }, out));
    telegramAuto();
  }

  async function startPage() {
    await reload();
    if (!data) return;
    if (!data.config.exists) wizard = 1;
    else if (!data.config.error && data.login.state !== 'ready') wizard = 2;
    render();
    await loadService();
    await loadSystem();
    // The page keeps the checks of the computer current while it is open.
    setInterval(loadSystem, 60000);
  }

  startPage();
})();
`;
