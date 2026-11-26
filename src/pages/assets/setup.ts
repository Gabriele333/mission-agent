/**
 * The browser code of the setup page (chapter 5). The first setup has five steps in order (§5.1).
 * After it, the page shows the five parts of §5.2 and the service. Each answer is saved when the
 * user gives it. A credential value goes in one POST and is never shown again (§J.3).
 * The text below is JavaScript, not TypeScript, and has no backtick.
 */
export const SETUP_JS = `'use strict';
(function () {
  const el = MA.el;
  const app = document.getElementById('app');
  let data = null;
  let service = null;
  let wizard = null;
  let finished = false;
  let stopped = false;
  let pairTimer = null;
  // Messages shown at the top of a part after an action, by part.
  const notes = {};

  MA.setUnauthorized(function () {
    stopped = true;
    MA.replace(app, el('div', { className: 'banner bad', text: 'This page can no longer reach the harness. It may have restarted with a new access token. Run "mission-agent setup" again.' }));
  });

  // ------------------------------------------------------------ loading

  async function reload() {
    const r = await MA.api('GET', '/api/setup/state');
    if (stopped) return;
    if (!r.ok) {
      MA.replace(app, el('div', { className: 'banner bad', text: MA.errorText(r) }));
      return;
    }
    data = r.data;
    if (data.agentName) document.title = 'Setup · ' + data.agentName;
    render();
    watchPairing();
  }

  async function loadService() {
    const r = await MA.api('GET', '/api/setup/service');
    service = r.ok ? r.data : { ok: false, error: MA.errorText(r) };
    if (data) render();
  }

  function note(key, kind, text) {
    notes[key] = { kind: kind, text: text };
  }

  function noteNode(key) {
    const n = notes[key];
    return n ? el('div', { className: 'banner ' + n.kind, attrs: { role: 'status' }, text: n.text }) : null;
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
    const node = el('div', { className: 'field' }, [
      el('label', { htmlFor: id, text: label }),
      input,
      helpText ? el('p', { className: 'help', text: helpText }) : null,
      errorBox,
    ]);
    function setErrors(list) {
      MA.clear(errorBox);
      if (list && list.length > 0) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', id + '-error');
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

  /** A form of fields that saves to agent.yaml in one POST. */
  function configForm(fields, buttonText, onSaved) {
    const general = el('div');
    const button = el('button', { type: 'submit', text: buttonText });
    const form = el('form', { attrs: { 'aria-label': buttonText } }, fields.map(function (f) { return f.node; }).concat([general, button]));
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
    const form = el('form', { className: 'row' }, [input, setButton]);
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
      el('p', { className: 'help' }, [el('code', { text: id }), ' ', el('span', { className: 'badge ' + (present ? 'ok' : 'bad'), text: present ? 'value present' : 'no value' })]),
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
    return el('section', { className: 'card', id: 'part-agent' }, [
      el('h2', { text: 'Agent' }),
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

  async function checkLogin() {
    const r = await MA.api('POST', '/api/setup/login/check');
    if (r.ok) note('login', 'ok', 'The model login works.');
    else note('login', 'bad', MA.errorText(r));
    await reload();
  }

  function loginStatus() {
    const l = data.login;
    if (l.state === 'ready') return el('p', { className: 'status-line' }, [el('span', { className: 'badge ok', text: 'ready' }), ' The model login works.']);
    if (l.state === 'not_ready') return el('div', { className: 'status-line' }, [el('span', { className: 'badge bad', text: 'not ready' }), ' ', el('span', { text: l.reason })]);
    return el('p', { className: 'status-line' }, [el('span', { className: 'badge warn', text: 'not checked' }), ' ', l.reason]);
  }

  function loginPart() {
    const chosen = String(data.config.values.model_login);
    const select = field('model_login', 'Model login', 'select', {
      choices: [{ value: 'api_key', text: 'An API key from the Claude Console' }, { value: 'subscription', text: 'My own Claude plan' }],
      help: 'Runs use this login. With your own plan, runs draw from the usage limits of your plan.',
      showDefault: false,
    });
    const details = [];
    if (chosen === 'api_key') {
      details.push(el('p', { text: 'The key is stored in the macOS Keychain. It is never written to a file and never shown again.' }));
      details.push(secretRow(data.login.apiKeyId, data.login.apiKeyPresent, 'API key', 'login'));
    } else {
      const command = data.login.signInCommand;
      const copied = el('span', { className: 'muted small' });
      details.push(el('p', { text: 'Sign in to Claude Code with your plan for this agent only. Run this command in a terminal on this computer. The page does not run it, and the harness never sees your sign-in.' }));
      details.push(el('pre', { text: command }));
      details.push(el('div', { className: 'row' }, [
        el('button', { type: 'button', className: 'secondary', text: 'Copy the command', on: { click: async function () {
          copied.textContent = (await MA.copy(command)) ? 'Copied.' : 'The browser did not allow copying. Select the text instead.';
        } } }),
        copied,
      ]));
      details.push(el('p', { className: 'help', text: 'A sign-in ends after some time. Run the command again then.' }));
    }
    return el('div', null, [
      noteNode('login'),
      configForm([select], 'Use this login'),
      el('h3', { text: chosen === 'api_key' ? 'The API key' : 'The sign-in with your Claude plan' }),
      details,
      loginStatus(),
      el('button', { type: 'button', className: 'secondary', text: 'Check again', on: { click: checkLogin } }),
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
    return el('section', { className: 'card', id: 'part-models' }, [
      el('h2', { text: 'Models' }),
      loginPart(),
      el('h3', { text: 'Models and effort' }),
      configForm(modelFields(), 'Save models'),
    ]);
  }

  function limitsPart() {
    return el('section', { className: 'card', id: 'part-limits' }, [
      el('h2', { text: 'Limits' }),
      el('p', { className: 'help', text: 'Empty a box to go back to its default.' }),
      el('div', null, configForm(limitFields(), 'Save limits')),
    ]);
  }

  // ------------------------------------------------------------ Telegram

  async function checkBot() {
    const r = await MA.api('POST', '/api/setup/telegram/check');
    if (r.ok && r.data && r.data.ok) {
      note('telegram', r.data.topicsEnabled ? 'ok' : 'warn', r.data.topicsEnabled
        ? 'The token works. The bot is @' + r.data.username + '. Topic mode is on.'
        : 'The token works. The bot is @' + r.data.username + ', but topic mode is off. Turn it on for the bot in BotFather, then check again. Without it the agent cannot give each mission its own thread.');
    } else {
      note('telegram', 'bad', MA.errorText(r));
    }
    await reload();
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
      if (r.data.pairing.state === 'waiting') watchPairing();
      else {
        const p = r.data.pairing;
        if (p.state === 'paired') note('telegram', 'ok', 'Your Telegram account is paired. The bot now accepts messages from that account only.');
        else note('telegram', p.state === 'cancelled' ? 'warn' : 'bad', p.reason);
        await reload();
      }
    }, 2000);
  }

  function telegramPart() {
    const t = data.telegram;
    const p = t.pairing;
    const items = [noteNode('telegram')];
    items.push(el('p', { text: 'Create a bot with BotFather in Telegram, turn on topic mode for it, and enter its token here. The token is stored in the macOS Keychain.' }));
    items.push(secretRow(t.tokenId, t.tokenPresent, 'Bot token', 'telegram'));
    if (t.tokenPresent) items.push(el('button', { type: 'button', className: 'secondary', text: 'Check the bot', on: { click: checkBot } }));
    if (t.bot) items.push(el('p', { className: 'small' }, ['Bot: @' + t.bot.username + '. Topic mode: ' + (t.bot.topicsEnabled ? 'on.' : 'off.')]));

    items.push(el('h3', { text: 'Your Telegram account' }));
    if (t.userId !== null) {
      items.push(el('p', null, ['Paired with the account ', el('code', { text: String(t.userId) }), '. The bot accepts messages from this account only. ', t.surfaceRunning ? 'The bot is connected.' : 'The bot is not connected.']));
    } else {
      items.push(el('p', { className: 'muted', text: 'No account is paired yet. Without Telegram, the default surface is the terminal.' }));
    }
    if (p.state === 'waiting') {
      items.push(el('div', { className: 'banner warn' }, [
        el('p', null, ['Send this code to ' + (t.bot ? '@' + t.bot.username : 'your bot') + ' in a private chat: ']),
        el('pre', { text: p.code }),
        el('p', { className: 'small', text: 'The page waits until ' + MA.time(p.expiresAt) + '. The bot does not answer the code. The first sender of the code becomes the account of the agent.' }),
        el('button', { type: 'button', className: 'secondary', text: 'Stop waiting', on: { click: async function () {
          await MA.api('POST', '/api/setup/telegram/pair/cancel');
        } } }),
      ]));
    } else if (t.tokenPresent) {
      items.push(el('button', { type: 'button', text: t.userId === null ? 'Pair my account' : 'Pair another account', on: { click: async function () {
        const r = await MA.api('POST', '/api/setup/telegram/pair');
        if (!r.ok) note('telegram', 'bad', MA.errorText(r));
        else delete notes.telegram;
        await reload();
      } } }));
    }
    if (t.userId !== null && p.state !== 'waiting') {
      items.push(el('button', { type: 'button', className: 'danger', text: 'Stop using Telegram', on: { click: async function () {
        if (!window.confirm('Remove your Telegram account from the agent? The default surface becomes the terminal.')) return;
        const r = await MA.api('POST', '/api/setup/telegram/forget');
        note('telegram', r.ok ? 'ok' : 'bad', r.ok ? 'Telegram is no longer used. The bot token stays in the Keychain until you delete it.' : MA.errorText(r));
        await reload();
      } } }));
    }
    return el('section', { className: 'card', id: 'part-telegram' }, [el('h2', { text: 'Telegram' })].concat(items));
  }

  // ------------------------------------------------------------ credentials and service

  function credentialsPart() {
    const list = data.credentials;
    const rows = list.length === 0
      ? [el('p', { className: 'muted', text: 'No credential is required now.' })]
      : list.map(function (c) { return secretRow(c.id, c.present, c.id, 'credentials'); });
    return el('section', { className: 'card', id: 'part-credentials' }, [
      el('h2', { text: 'Credentials' }),
      noteNode('credentials'),
      el('p', { className: 'help', text: 'Each credential that the harness, the tools and the triggers of active missions need. Values are in the macOS Keychain. The page never shows a value.' }),
    ].concat(rows));
  }

  function servicePart() {
    const items = [noteNode('service')];
    items.push(el('p', { text: 'The service starts the harness when you log in, and starts it again after a crash. It is a LaunchAgent of your macOS account.' }));
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
      items.push(el('p', null, [el('strong', { text: 'State: ' }), stateText]));
      items.push(el('h3', { text: 'What the install writes' }));
      items.push(el('ul', { className: 'small' }, [
        el('li', null, ['The file ', el('code', { text: plan.plistPath })]),
        el('li', null, ['The label ', el('code', { text: plan.label })]),
        el('li', null, ['The command ', el('code', { text: plan.programArguments.join(' ') })]),
        el('li', null, ['The root folder ', el('code', { text: plan.root })]),
        el('li', null, ['The logs ', el('code', { text: plan.stdoutPath }), ' and ', el('code', { text: plan.stderrPath })]),
        el('li', null, ['The PATH of the harness, taken from the shell that started it: ', el('code', { text: plan.envPath })]),
      ]));
      const details = el('details', null, [el('summary', { text: 'Show the whole file' }), el('pre', { text: plan.plistText })]);
      items.push(details);
      if (!service.cliFound) items.push(el('p', { className: 'error', text: 'The built program ' + plan.programArguments[1] + ' cannot be found. Build it first with: npm run build' }));
      if (service.isThisHarness) items.push(el('p', { className: 'good', text: 'This harness runs as the service.' }));
      const button = el('button', { type: 'button', text: st && st.installed ? 'Install again' : 'Install the service', disabled: !service.cliFound || service.isThisHarness, on: { click: async function () {
        button.disabled = true;
        const r = await MA.api('POST', '/api/setup/service/install');
        if (r.ok) {
          note('service', 'ok', r.data.handover
            ? 'The service is installed. This harness still runs in your terminal. Stop it there with Ctrl+C: the service then starts the harness within about ten seconds, and this page must be opened again with "mission-agent setup".'
            : 'The service is installed and loaded.');
        } else {
          note('service', 'bad', MA.errorText(r));
        }
        await loadService();
      } } });
      items.push(button);
    }
    return el('section', { className: 'card', id: 'part-service' }, [el('h2', { text: 'Service' })].concat(items));
  }

  function reachPart() {
    const t = data.telegram;
    return el('section', { className: 'card', id: 'part-reach' }, [
      el('h2', { text: 'Reach the agent' }),
      el('p', { text: 'In a terminal on this computer:' }),
      el('pre', { text: data.commands.chat }),
      t.userId !== null
        ? el('p', { text: 'On Telegram: write to ' + (t.bot ? '@' + t.bot.username : 'your bot') + '. Each mission has its own thread.' })
        : el('p', { className: 'muted', text: 'Telegram is not set up.' }),
    ]);
  }

  // ------------------------------------------------------------ banners

  function banners() {
    const out = [];
    const c = data.config;
    if (c.error) {
      out.push(el('div', { className: 'banner bad' }, [
        el('strong', { text: 'agent.yaml is invalid. ' }),
        data.harness.usesLastValidValues ? 'The harness keeps the last valid values until the file is fixed. ' : 'The harness stays paused until the file is fixed. ',
        'The errors are also shown next to each field below.',
        el('pre', { text: c.error }),
      ]));
    }
    const h = data.harness;
    if (h.paused) out.push(el('div', { className: 'banner warn' }, [el('strong', { text: 'The agent is paused. ' }), h.pauseReason]));
    else out.push(el('div', { className: 'banner ok', text: 'The agent is running. A new value applies from the next run.' }));
    return out;
  }

  // ------------------------------------------------------------ the first setup (§5.1)

  const STEPS = ['The agent name', 'The model login', 'Telegram', 'The limits and the models', 'The service'];

  function stepDone(i) {
    if (i === 1) return !!data.agentName;
    if (i === 2) return data.login.state === 'ready';
    if (i === 3) return data.telegram.userId !== null;
    if (i === 5) return !!(service && service.ok && service.status && service.status.installed);
    return false;
  }

  function stepList() {
    return el('ol', { className: 'steps' }, STEPS.map(function (title, i) {
      const n = i + 1;
      const mark = stepDone(n) ? ' (done)' : (n === 3 ? ' (you can skip it)' : '');
      return el('li', { className: n === wizard ? 'current' : '', text: title + mark });
    }));
  }

  function nav(back, nextButton) {
    return el('div', { className: 'row' }, [
      back ? el('button', { type: 'button', className: 'secondary', text: 'Back', on: { click: function () { wizard -= 1; render(); } } }) : null,
      nextButton,
      el('a', { href: '#', text: 'Show all settings instead', on: { click: function (ev) { ev.preventDefault(); wizard = null; render(); } } }),
    ]);
  }

  function next(text, enabled) {
    return el('button', { type: 'button', text: text, disabled: !enabled, on: { click: function () {
      if (wizard === 5) {
        wizard = null;
        finished = true;
      } else {
        wizard += 1;
      }
      render();
    } } });
  }

  function wizardStep() {
    const n = wizard;
    const head = el('h2', { text: 'Step ' + n + ' of 5: ' + STEPS[n - 1] });
    if (n === 1) {
      const name = field('agent_name', 'Agent name', 'text', { help: 'Free text, such as Ada. The agent uses it in every message.', emptyIsDefault: false });
      return el('section', { className: 'card' }, [head, configForm([name], 'Save and continue', function () { wizard = 2; }), nav(false, null)]);
    }
    if (n === 2) {
      const ready = data.login.state === 'ready';
      return el('section', { className: 'card' }, [
        head,
        el('p', { text: 'Choose how runs log in to the model. One of the two is required.' }),
        loginPart(),
        ready ? el('p', { className: 'good', text: 'The login is ready. The agent ended its pause by itself.' }) : el('p', { className: 'muted', text: 'Continue is possible once the login is ready. Press Check again after you signed in.' }),
        nav(true, next('Continue', ready)),
      ]);
    }
    if (n === 3) {
      return el('div', null, [
        el('section', { className: 'card' }, [head, el('p', { text: 'Telegram is optional. You can skip it and add it later in this page.' })]),
        telegramPart(),
        nav(true, next(data.telegram.userId !== null ? 'Continue' : 'Skip Telegram', true)),
      ]);
    }
    if (n === 4) {
      const fields = modelFields().concat(limitFields());
      return el('section', { className: 'card' }, [
        head,
        el('p', { text: 'These are the defaults. Keep them or change them, then save.' }),
        configForm(fields, 'Save and continue', function () { wizard = 5; }),
        nav(true, null),
      ]);
    }
    return el('div', null, [
      el('section', { className: 'card' }, [head, el('p', { text: 'Install the harness as a service, so that it starts when you log in. You can also do this later.' })]),
      servicePart(),
      nav(true, next('Finish', true)),
    ]);
  }

  // ------------------------------------------------------------ the page

  function render() {
    if (stopped || !data) return;
    const out = banners();
    if (wizard !== null) {
      out.push(el('section', { className: 'card' }, [el('h2', { text: 'First setup' }), stepList()]));
      out.push(wizardStep());
    } else {
      if (finished) out.push(el('div', { className: 'banner ok', text: 'The first setup is done. Each part below can be changed at any time.' }));
      const open = STEPS.map(function (t, i) { return stepDone(i + 1) ? null : t; }).filter(function (t, i) { return t !== null && i !== 3; });
      if (!finished && open.length > 0) {
        out.push(el('section', { className: 'card' }, [
          el('h2', { text: 'First setup' }),
          el('p', { text: 'Not done yet: ' + open.join(', ') + '.' }),
          el('button', { type: 'button', className: 'secondary', text: 'Go through the first setup steps', on: { click: function () { wizard = 1; render(); } } }),
        ]));
      }
      out.push(reachPart(), agentPart(), modelsPart(), limitsPart(), telegramPart(), credentialsPart(), servicePart());
    }
    MA.replace(app, out);
  }

  async function startPage() {
    await reload();
    if (!data) return;
    if (!data.config.exists) wizard = 1;
    else if (!data.config.error && data.login.state !== 'ready') wizard = 2;
    render();
    await loadService();
  }

  startPage();
})();
`;
