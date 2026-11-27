/**
 * The browser code of the dashboard (chapter 6). It only reads: it calls GET routes only, except
 * the two buttons of the Version part, which check for a release and start an update.
 * Every text from the harness, such as a mission name, a run input or an error, is set with
 * `textContent` through `MA.el`. The text below is JavaScript, not TypeScript, and has no backtick.
 */
export const DASHBOARD_JS = `'use strict';
(function () {
  const el = MA.el;
  const REFRESH_MS = 5000;
  const app = document.getElementById('app');
  let stopped = false;
  let busy = false;
  let runFilter = { mission: '', limit: 50 };
  let missionsCache = [];

  const parts = {};
  function section(key, title) {
    const body = el('div', { className: 'section-body' }, el('p', { className: 'muted', text: 'Loading.' }));
    const node = el('section', { className: 'card', id: 'part-' + key }, [el('h2', { text: title }), body]);
    parts[key] = body;
    return node;
  }

  const statusLine = el('p', { className: 'muted small status-line', attrs: { 'aria-live': 'polite' } });
  const runControls = el('div', { className: 'row small' });
  MA.replace(app, [
    statusLine,
    section('harness', 'The harness'),
    section('version', 'Version'),
    section('approvals', 'Approvals that wait'),
    section('missions', 'Missions'),
    el('section', { className: 'card', id: 'part-runs' }, [el('h2', { text: 'Runs' }), runControls, (parts.runs = el('div', { className: 'section-body' }))]),
    section('cost', 'Cost'),
    section('memory', 'Memory'),
    section('code', 'Tools and triggers'),
  ]);

  MA.setUnauthorized(function () {
    stopped = true;
    MA.replace(statusLine, el('span', { className: 'error', text: 'This page can no longer reach the harness. It may have restarted with a new access token. Run "mission-agent dashboard" again.' }));
  });

  function table(headers, rows) {
    const head = el('tr', null, headers.map(function (h) {
      return el('th', { className: h.num ? 'num' : '', text: h.text, attrs: { role: 'columnheader' } });
    }));
    return el('div', { className: 'table-wrap' }, el('table', null, [el('thead', null, head), el('tbody', null, rows)]));
  }

  function td(content, className) {
    return el('td', { className: className || '' }, typeof content === 'string' || typeof content === 'number' ? String(content) : content);
  }

  function badge(text, kind) {
    return el('span', { className: 'badge ' + (kind || ''), text: text });
  }

  function outcomeBadge(status) {
    if (status === 'success') return badge('success', 'ok');
    if (status === 'failed') return badge('failed', 'bad');
    return badge(status, 'warn');
  }

  function none(text) {
    return el('p', { className: 'muted', text: text });
  }

  function failedPart(key, r) {
    MA.replace(parts[key], el('p', { className: 'error', text: MA.errorText(r) }));
  }

  // ------------------------------------------------------------ the harness

  function renderHarness(d) {
    const items = [];
    items.push(el('p', null, [el('strong', { text: d.agentName || 'The agent has no name yet.' })]));
    if (d.paused) {
      items.push(el('div', { className: 'banner warn' }, [
        el('strong', { text: 'Paused. ' }),
        d.pauseReason || 'No reason was given.',
        d.pausedSince ? el('span', { className: 'muted small', text: ' Since ' + MA.time(d.pausedSince) + '.' }) : null,
      ]));
    } else if (d.running) {
      items.push(el('div', { className: 'banner ok', text: 'Running. Runs start when a message, a timer or an event arrives.' }));
    }
    items.push(el('p', null, [
      'Started at ' + (d.startedAt ? MA.time(d.startedAt) : 'an unknown time') + '. ',
      'Default surface: ' + d.defaultSurface + '. ',
      'Telegram: ' + (d.telegramRunning ? 'connected.' : 'not connected.'),
    ]));
    if (d.configError) items.push(el('div', { className: 'banner bad' }, [el('strong', { text: 'agent.yaml is invalid. ' }), el('pre', { text: d.configError })]));
    if (d.missedTimerRuns.length > 0) {
      items.push(el('h3', { text: 'Timer runs missed while the harness was stopped' }));
      items.push(el('ul', null, d.missedTimerRuns.map(function (m) {
        const count = m.count === 1 ? 'once' : (m.countIsMinimum ? 'more than ' : '') + m.count + ' times';
        return el('li', null, m.missionName + ': timer "' + m.expression + '" missed ' + count + ', last due at ' + MA.time(m.dueAt) + '. It ran once at the start.');
      })));
    } else {
      items.push(el('p', { className: 'muted small', text: 'No timer run was missed at the last start.' }));
    }
    if (d.manifestErrors.length > 0) {
      items.push(el('h3', { text: 'Manifests that are not loaded' }));
      items.push(el('ul', null, d.manifestErrors.map(function (e) {
        return el('li', null, [el('code', { text: e.source }), ': ', e.message]);
      })));
    }
    MA.replace(parts.harness, items);
  }

  // ------------------------------------------------------------ version

  // While a button works, its part shows what it does, and the refresh leaves the part alone.
  let versionWork = null;
  let versionError = null;
  let versionData = null;

  async function checkRelease() {
    versionWork = 'Checking for a newer release.';
    versionError = null;
    renderVersion(versionData);
    const r = await MA.api('POST', '/api/update/check', {});
    versionWork = null;
    if (!r.ok) versionError = MA.errorText(r);
    const again = await MA.api('GET', '/api/dashboard/version');
    if (again.ok && again.data) renderVersion(again.data);
    else renderVersion(versionData);
  }

  async function installRelease(version) {
    if (typeof window.confirm === 'function' && !window.confirm('Install version ' + version + '? The harness stops during the update, and starts again with the new version.')) return;
    versionWork = 'Starting the update. The progress page opens in a moment.';
    versionError = null;
    renderVersion(versionData);
    const r = await MA.api('POST', '/api/update/start', { version: version });
    if (r.ok && r.data && typeof r.data.url === 'string') {
      stopped = true;
      window.location.assign(r.data.url);
      return;
    }
    versionWork = null;
    versionError = MA.errorText(r);
    renderVersion(versionData);
  }

  function renderVersion(d) {
    if (!d) return;
    versionData = d;
    const items = [];
    items.push(el('p', null, [
      'Installed: ', el('strong', { text: d.installed || 'unknown' }), '. ',
      d.latest ? 'Newest release: ' + d.latest + ', checked at ' + MA.time(d.checkedAt) + '.' : 'No check for a newer release got an answer yet.',
    ]));
    if (d.newer) {
      items.push(el('div', { className: 'banner warn' }, [
        el('strong', { text: 'Version ' + d.latest + ' is available. ' }),
        d.notes ? el('pre', { text: d.notes }) : el('span', { text: 'Press Check for updates to read its notes.' }),
      ]));
    } else if (d.latest) {
      items.push(el('p', { className: 'muted', text: 'This is the newest release.' }));
    }
    const check = el('button', { type: 'button', className: 'secondary', text: 'Check for updates', disabled: versionWork !== null, on: { click: checkRelease } });
    const buttons = [check];
    if (d.newer) {
      buttons.push(el('button', { type: 'button', id: 'install-release', text: 'Install version ' + d.latest, disabled: versionWork !== null || !!d.refusal, on: { click: function () { installRelease(d.latest); } } }));
    }
    items.push(el('div', { className: 'row' }, buttons));
    if (versionWork) items.push(el('div', { className: 'wait' }, el('div', { className: 'wait-title' }, [el('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }), versionWork])));
    if (versionError) items.push(el('p', { className: 'error', text: versionError }));
    if (d.newer && d.refusal) items.push(el('p', { className: 'error', text: 'The dashboard cannot install it: ' + d.refusal }));
    items.push(el('p', { className: 'muted small' }, ['The same in a terminal: ', el('code', { text: d.command })]));
    MA.replace(parts.version, items);
  }

  function renderVersionFromRefresh(d) {
    if (versionWork === null) renderVersion(d);
    else versionData = d;
  }

  // ------------------------------------------------------------ missions

  function renderMissions(d) {
    missionsCache = d.missions;
    const rows = d.missions.map(function (m) {
      const last = m.lastRun
        ? el('div', null, [MA.time(m.lastRun.startedAt) + ' ', outcomeBadge(m.lastRun.status), m.lastRun.error ? el('div', { className: 'cell-text error', text: m.lastRun.error }) : null])
        : el('span', { className: 'muted', text: 'none yet' });
      const state = el('div', null, [badge(m.status, m.status === 'active' ? 'ok' : 'warn'), m.running ? ' ' : null, m.running ? badge('run in progress', '') : null]);
      return el('tr', null, [
        td(el('div', null, [el('strong', { text: m.name }), m.system ? ' ' : null, m.system ? badge('system', '') : null])),
        td(el('div', { className: 'cell-text', text: m.description })),
        td(state),
        td(String(m.version), 'num'),
        td(last),
        td(m.nextTimerRun ? MA.time(m.nextTimerRun) : (m.timers.length > 0 ? 'none while frozen' : 'no timer')),
      ]);
    });
    const out = [table([{ text: 'Name' }, { text: 'Description' }, { text: 'Status' }, { text: 'Version', num: true }, { text: 'Last run' }, { text: 'Next timer run' }], rows)];
    if (d.invalid.length > 0) out.push(el('p', { className: 'error', text: d.invalid.length + ' manifest(s) are invalid. The harness part above lists them.' }));
    MA.replace(parts.missions, out);
    renderRunControls();
  }

  // ------------------------------------------------------------ runs

  function renderRunControls() {
    const select = el('select', { id: 'run-mission', on: { change: function () { runFilter.mission = select.value; refresh(); } } });
    select.appendChild(el('option', { value: '', text: 'All missions' }));
    for (const m of missionsCache) {
      const opt = el('option', { value: m.id, text: m.name });
      if (m.id === runFilter.mission) opt.selected = true;
      select.appendChild(opt);
    }
    const limit = el('select', { id: 'run-limit', on: { change: function () { runFilter.limit = Number(limit.value); refresh(); } } });
    for (const n of [20, 50, 100, 500]) {
      const opt = el('option', { value: String(n), text: 'Last ' + n });
      if (n === runFilter.limit) opt.selected = true;
      limit.appendChild(opt);
    }
    MA.replace(runControls, [el('label', { htmlFor: 'run-mission', text: 'Mission' }), select, el('label', { htmlFor: 'run-limit', text: 'Show' }), limit]);
  }

  function renderRuns(d) {
    if (d.runs.length === 0) return MA.replace(parts.runs, none('No run yet.'));
    const rows = d.runs.map(function (r) {
      const outcome = el('div', null, [outcomeBadge(r.status), r.error ? el('div', { className: 'cell-text error', text: r.error }) : null]);
      return el('tr', { className: r.failed ? 'failed' : '' }, [
        td(MA.time(r.startedAt)),
        td(el('div', null, [r.missionName, el('div', { className: 'muted small', text: 'version ' + r.manifestVersion })])),
        td(el('div', { className: 'cell-text', text: r.input })),
        td(el('div', { className: 'cell-text', text: r.toolsCalled.length > 0 ? r.toolsCalled.join(', ') : 'none' })),
        td(MA.number(r.inputTokens) + ' in, ' + MA.number(r.outputTokens) + ' out', 'num'),
        td(MA.usd(r.costUsd), 'num'),
        td(outcome),
      ]);
    });
    MA.replace(parts.runs, table([{ text: 'Time' }, { text: 'Mission' }, { text: 'Input' }, { text: 'Tools called' }, { text: 'Tokens', num: true }, { text: 'Cost', num: true }, { text: 'Outcome' }], rows));
  }

  // ------------------------------------------------------------ cost

  function renderCost(d) {
    const headers = [{ text: 'Mission' }].concat(d.periods.map(function (p) { return { text: p.label, num: true }; }));
    const total = el('tr', null, [td(el('strong', { text: 'All missions' }))].concat(d.periods.map(function (p) { return td(el('strong', { text: MA.usd(d.total[p.key]) }), 'num'); })));
    const rows = [total].concat(d.missions.map(function (m) {
      const name = m.deleted ? el('span', null, [m.name + ' ', badge('deleted', '')]) : m.name;
      return el('tr', null, [td(name)].concat(d.periods.map(function (p) { return td(MA.usd(m.cost[p.key]), 'num'); })));
    }));
    MA.replace(parts.cost, [table(headers, rows), el('p', { className: 'muted small', text: 'From the logbook. Days are local days. The cost of a run is the estimate that the run reported.' })]);
  }

  // ------------------------------------------------------------ approvals

  function renderApprovals(d) {
    if (d.approvals.length === 0) return MA.replace(parts.approvals, none('No action waits for your approval. You answer approvals in the chat, not here.'));
    const rows = d.approvals.map(function (a) {
      return el('tr', null, [
        td(a.missionName),
        td(el('div', null, [el('code', { text: a.action }), el('div', { className: 'muted small', text: a.toolName })])),
        td(el('div', { className: 'cell-text', text: a.note || '' })),
        td(el('div', { className: 'cell-text small', text: a.input })),
        td(MA.time(a.createdAt)),
        td(MA.duration(a.msLeft), 'num'),
      ]);
    });
    MA.replace(parts.approvals, [
      table([{ text: 'Mission' }, { text: 'Action' }, { text: 'Note' }, { text: 'Input' }, { text: 'Waiting since' }, { text: 'Time left', num: true }], rows),
      el('p', { className: 'muted small', text: 'Answer each request in the chat. An action with no answer is cancelled when its time runs out.' }),
    ]);
  }

  // ------------------------------------------------------------ memory

  function level(value, max) {
    if (value > max) return 'bad';
    if (value > max * 0.8) return 'warn';
    return 'ok';
  }

  function renderMemory(d) {
    const c = d.core;
    const core = el('p', null, [
      'Core memory: ', badge(c.lines + ' of ' + c.maxLines + ' lines', level(c.lines, c.maxLines)),
      c.longLines > 0 ? el('span', { className: 'error', text: ' ' + c.longLines + ' line(s) are longer than ' + c.maxLineChars + ' characters.' }) : null,
    ]);
    const rows = d.missions.map(function (m) {
      return el('tr', null, [
        td(el('div', null, [m.name, m.status === 'frozen' ? ' ' : null, m.status === 'frozen' ? badge('frozen', 'warn') : null])),
        td(String(m.notes), 'num'),
        td(badge(m.indexLines + ' of ' + d.index.maxLines, level(m.indexLines, d.index.maxLines)), 'num'),
        td(badge(MA.bytes(m.indexBytes) + ' of ' + MA.bytes(d.index.maxBytes), level(m.indexBytes, d.index.maxBytes)), 'num'),
      ]);
    });
    MA.replace(parts.memory, [core, table([{ text: 'Mission' }, { text: 'Notes', num: true }, { text: 'Index lines', num: true }, { text: 'Index size', num: true }], rows)]);
  }

  // ------------------------------------------------------------ tools and triggers

  function codeTable(items) {
    const rows = items.map(function (t) {
      const users = t.missions.length === 0 ? el('span', { className: 'muted', text: 'no mission' }) : el('div', null, t.missions.map(function (m, i) {
        return el('span', null, [i > 0 ? ', ' : '', m.name, m.status === 'frozen' ? ' (frozen)' : '']);
      }));
      const creds = t.credentials.length === 0 ? el('span', { className: 'muted', text: 'none needed' }) : el('div', null, t.credentials.map(function (c) {
        return el('div', null, [el('code', { text: c.id }), ' ', badge(c.present ? 'present' : 'missing', c.present ? 'ok' : 'bad')]);
      }));
      return el('tr', null, [td(el('code', { text: t.id })), td(users), td(creds)]);
    });
    return table([{ text: 'Id' }, { text: 'Used by' }, { text: 'Credentials' }], rows);
  }

  function renderCode(d) {
    MA.replace(parts.code, [el('h3', { text: 'Tools' }), codeTable(d.tools), el('h3', { text: 'Triggers' }), codeTable(d.triggers)]);
  }

  // ------------------------------------------------------------ refresh

  const sources = [
    ['harness', '/api/dashboard/harness', renderHarness],
    ['version', '/api/dashboard/version', renderVersionFromRefresh],
    ['missions', '/api/dashboard/missions', renderMissions],
    ['runs', null, renderRuns],
    ['cost', '/api/dashboard/cost', renderCost],
    ['approvals', '/api/dashboard/approvals', renderApprovals],
    ['memory', '/api/dashboard/memory', renderMemory],
    ['code', '/api/dashboard/code', renderCode],
  ];

  function runsPath() {
    let path = '/api/dashboard/runs?limit=' + encodeURIComponent(String(runFilter.limit));
    if (runFilter.mission !== '') path += '&mission=' + encodeURIComponent(runFilter.mission);
    return path;
  }

  async function refresh() {
    if (stopped || busy) return;
    busy = true;
    try {
      const results = await Promise.all(sources.map(function (s) { return MA.api('GET', s[1] || runsPath()); }));
      if (stopped) return;
      let failures = 0;
      results.forEach(function (r, i) {
        const s = sources[i];
        if (r.ok && r.data && typeof r.data === 'object') {
          s[2](r.data);
        } else {
          failures++;
          failedPart(s[0], r);
        }
      });
      if (results[0].data && results[0].data.agentName) document.title = 'Dashboard · ' + results[0].data.agentName;
      MA.replace(statusLine, failures === 0
        ? 'Updated at ' + MA.time(new Date().toISOString()).slice(11) + '. The page updates every 5 seconds.'
        : el('span', { className: 'error', text: 'Some parts could not be read at ' + MA.time(new Date().toISOString()).slice(11) + '. The page tries again in 5 seconds.' }));
    } finally {
      busy = false;
    }
  }

  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
})();
`;
