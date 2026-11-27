/**
 * The browser code of the progress page (chapter 7.5). The maintenance program serves it while an
 * update or a repair runs. It reads the state every second, and posts only to start a repair and
 * to answer the one question that a repair asks a person. Every text is set through `MA.el`.
 * The text below is JavaScript, not TypeScript, and has no backtick.
 */
export const PROGRESS_JS = `'use strict';
(function () {
  const el = MA.el;
  const POLL_MS = 1000;
  const app = document.getElementById('app');
  let stopped = false;
  let busy = false;
  let lastState = null;
  let missed = 0;

  const statusLine = el('p', { className: 'muted small status-line', attrs: { 'aria-live': 'polite' } });
  const head = el('div');
  const stepsBody = el('ol', { className: 'stages' });
  const resultBody = el('div', { attrs: { 'aria-live': 'polite' } });
  const questionBody = el('div');
  const logBody = el('pre', { className: 'log small' });
  MA.replace(app, [
    head,
    statusLine,
    el('section', { className: 'card' }, [el('h2', { text: 'Steps' }), stepsBody]),
    resultBody,
    questionBody,
    el('section', { className: 'card' }, [el('h2', { text: 'What the maintenance program printed' }), logBody]),
  ]);

  MA.setUnauthorized(function () {
    stopped = true;
    MA.replace(statusLine, el('span', { className: 'error', text: 'This page can no longer reach the maintenance program. Its access token is no longer valid.' }));
  });

  const MARKS = { waiting: '', running: '…', done: '✓', failed: '✗', skipped: '–' };
  const WORDS = { waiting: 'waiting', running: 'running', done: 'done', failed: 'failed', skipped: 'skipped' };
  const KINDS = { waiting: '', running: 'warn', done: 'ok', failed: 'bad', skipped: '' };

  function renderSteps(d) {
    MA.replace(stepsBody, d.steps.map(function (s) {
      const cls = 'stage ' + (s.state === 'done' ? 'done' : s.state === 'running' ? 'open' : s.state === 'failed' ? 'failed' : s.state === 'skipped' ? 'skipped' : 'later');
      return el('li', { className: cls }, [
        el('span', { className: 'stage-mark', text: MARKS[s.state] || '', attrs: { 'aria-hidden': 'true' } }),
        el('div', { className: 'stage-body' }, el('div', { className: 'stage-head' }, [
          el('h3', { className: 'stage-title', text: s.title }),
          el('span', { className: 'badge ' + (KINDS[s.state] || ''), text: WORDS[s.state] || s.state }),
        ])),
      ]);
    }));
  }

  function dashboardLink(d) {
    if (!d.dashboard) return null;
    return el('p', null, el('a', { className: 'button', href: d.dashboard, text: 'Open the dashboard' }));
  }

  function renderResult(d) {
    const items = [];
    if (d.state === 'running') {
      items.push(el('div', { className: 'wait' }, el('div', { className: 'wait-title' }, [el('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }), d.operation === 'repair' ? 'The repair runs. Keep this page open.' : 'The update runs. Keep this page open.'])));
    } else if (d.state === 'done') {
      items.push(el('div', { className: 'banner ok' }, [el('strong', { text: d.operation === 'repair' ? 'The repair is finished. ' : 'The update is finished. ' }), d.result]));
      items.push(dashboardLink(d));
    } else if (d.state === 'refused') {
      items.push(el('div', { className: 'banner warn' }, [el('strong', { text: 'Nothing was changed. ' }), d.result]));
      items.push(dashboardLink(d));
    } else {
      items.push(el('div', { className: 'banner bad' }, [el('strong', { text: d.operation === 'repair' ? 'The repair did not finish. ' : 'The update failed. ' }), d.result]));
      if (d.oldRuns === true) items.push(el('p', { text: 'The version from before the update runs again.' }));
      if (d.oldRuns === false) items.push(el('p', { className: 'error', text: 'The agent does not run now.' }));
      if (d.canRepair) {
        const button = el('button', { type: 'button', text: 'Repair', on: { click: function () { startRepair(button); } } });
        items.push(el('p', { text: 'Repair finds what is wrong and fixes it. It asks you before it puts a copy of the root folder back.' }));
        items.push(el('p', null, button));
      }
      if (d.repairCommand) items.push(el('p', { className: 'muted small' }, ['In a terminal: ', el('code', { text: d.repairCommand })]));
      items.push(dashboardLink(d));
    }
    if (d.stopsAt) items.push(el('p', { className: 'muted small', text: 'This page stops answering at ' + MA.time(d.stopsAt) + '.' }));
    MA.replace(resultBody, el('section', { className: 'card' }, [el('h2', { text: 'Result' })].concat(items)));
  }

  function renderQuestion(d) {
    if (!d.question) return MA.replace(questionBody, null);
    const q = d.question;
    const error = el('p', { className: 'error' });
    function answer(value, buttons) {
      buttons.forEach(function (b) { b.disabled = true; });
      MA.api('POST', '/api/answer', { id: q.id, answer: value }).then(function (r) {
        if (!r.ok) {
          buttons.forEach(function (b) { b.disabled = false; });
          MA.replace(error, MA.errorText(r));
        }
        refresh();
      });
    }
    const yes = el('button', { type: 'button', className: 'danger', text: 'Put the copy back' });
    const no = el('button', { type: 'button', className: 'secondary', text: 'Leave the root folder as it is' });
    yes.addEventListener('click', function () { answer('yes', [yes, no]); });
    no.addEventListener('click', function () { answer('no', [yes, no]); });
    MA.replace(questionBody, el('section', { className: 'card' }, [
      el('h2', { text: 'A question' }),
      el('p', { text: q.text }),
      el('div', { className: 'row' }, [yes, no]),
      error,
    ]));
  }

  async function startRepair(button) {
    button.disabled = true;
    const r = await MA.api('POST', '/api/repair', {});
    if (!r.ok) {
      button.disabled = false;
      MA.replace(statusLine, el('span', { className: 'error', text: MA.errorText(r) }));
    }
    refresh();
  }

  function render(d) {
    lastState = d;
    document.title = (d.operation === 'repair' ? 'Repair' : 'Update') + (d.title ? ' · ' + d.title : '');
    MA.replace(head, [el('h1', { className: 'page-title', text: d.title || (d.operation === 'repair' ? 'Repair' : 'Update') })]);
    renderSteps(d);
    renderResult(d);
    renderQuestion(d);
    logBody.textContent = d.lines.join('\\n');
    logBody.scrollTop = logBody.scrollHeight;
  }

  async function refresh() {
    if (stopped || busy) return;
    busy = true;
    try {
      const r = await MA.api('GET', '/api/progress');
      if (stopped) return;
      if (r.ok && r.data && typeof r.data === 'object') {
        missed = 0;
        render(r.data);
        MA.replace(statusLine, 'Updated at ' + MA.time(new Date().toISOString()).slice(11) + '.');
      } else {
        missed++;
        const ended = lastState && lastState.state !== 'running';
        MA.replace(statusLine, el('span', { className: ended ? 'muted' : 'error', text: ended ? 'The maintenance program has stopped serving this page.' : 'The maintenance program does not answer. This page tries again.' }));
        if (ended && missed > 3) stopped = true;
      }
    } finally {
      busy = false;
    }
  }

  refresh();
  setInterval(refresh, POLL_MS);
})();
`;
