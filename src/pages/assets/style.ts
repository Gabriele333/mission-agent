/**
 * The style sheet of both pages. System fonts only, light and dark from the system setting.
 * Colours and spacing are tokens on :root. Text colours keep a contrast of at least 4.5 to 1
 * on the page and on the cards, in both themes.
 */
export const STYLE_CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f6f8;
  --surface: #ffffff;
  --panel: #f1f2f5;
  --fg: #1b1c20;
  --muted: #565b68;
  --line: #e3e5ea;
  --line-strong: #c7cbd3;
  --accent: #2b50c8;
  --accent-hover: #2344ad;
  --accent-fg: #ffffff;
  --accent-soft: #eaf0fd;
  --focus: rgba(43, 80, 200, 0.35);
  --ok: #146c2e;
  --ok-bg: #e8f4ec;
  --warn: #7f4d00;
  --warn-bg: #fdf3e1;
  --bad: #b3261e;
  --bad-bg: #fcebea;
  --s1: 4px;
  --s2: 8px;
  --s3: 12px;
  --s4: 16px;
  --s5: 24px;
  --s6: 32px;
  --s7: 48px;
  --radius: 12px;
  --radius-sm: 8px;
  --shadow: 0 1px 2px rgba(20, 22, 30, 0.04), 0 2px 8px rgba(20, 22, 30, 0.04);
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121316;
    --surface: #1a1c20;
    --panel: #23262c;
    --fg: #e7e8eb;
    --muted: #a4a9b4;
    --line: #2b2e35;
    --line-strong: #41454e;
    --accent: #93b1ff;
    --accent-hover: #adc4ff;
    --accent-fg: #0c1630;
    --accent-soft: #1d2741;
    --focus: rgba(147, 177, 255, 0.4);
    --ok: #7fd49b;
    --ok-bg: #15301f;
    --warn: #f2c66b;
    --warn-bg: #332812;
    --bad: #f5978e;
    --bad-bg: #3a1d1b;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
html { font-size: 16px; -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  line-height: 1.5;
}
header.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s2) var(--s4);
  padding: var(--s3) var(--s5);
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
header.top h1 { font-size: 1rem; font-weight: 600; margin: 0; }
header.top nav a { margin-left: var(--s3); font-size: 0.9rem; text-decoration: none; }
header.top nav a:hover { text-decoration: underline; }
main { max-width: 980px; margin: 0 auto; padding: var(--s6) var(--s4) var(--s7); }
a { color: var(--accent); }
a:focus-visible, summary:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
h2 { font-size: 1.15rem; font-weight: 650; margin: 0 0 var(--s3); }
h3 { font-size: 0.95rem; font-weight: 650; margin: var(--s5) 0 var(--s2); }
p { margin: 0 0 var(--s3); }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* ---------------------------------------------------------------- the column */

.page { margin: 0 auto; }
.page.wizard { max-width: 640px; }
.page.settings { max-width: 760px; }
.page-title { font-size: 1.6rem; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 var(--s4); }

section.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: var(--s5);
  margin: 0 0 var(--s4);
}
section.card > h2:first-child { margin-bottom: var(--s4); }
.wizard section.card.step { padding: var(--s6); }
section.card > p.help { margin: 0 0 var(--s4); }
.muted { color: var(--muted); }
.small { font-size: 0.875rem; }
.lead { font-size: 1.02rem; color: var(--muted); margin-bottom: var(--s5); }
.good { color: var(--ok); font-weight: 600; }
.error { color: var(--bad); font-size: 0.9rem; margin: var(--s1) 0 0; }
code, pre { font-family: var(--mono); font-size: 0.85rem; }
code { overflow-wrap: anywhere; }
pre {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: var(--s3) var(--s3);
  margin: var(--s2) 0 var(--s3);
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
pre.code-big { font-size: 1.5rem; letter-spacing: 0.2em; text-align: center; padding: var(--s4); }

/* ---------------------------------------------------------------- the state of the agent */

.status {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s1) var(--s3);
  font-size: 0.9rem;
  margin: 0 0 var(--s5);
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  border: 1px solid transparent;
}
.pill .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill.ok { color: var(--ok); background: var(--ok-bg); }
.pill.warn { color: var(--warn); background: var(--warn-bg); }
.status-reason { flex-basis: 100%; color: var(--muted); overflow-wrap: anywhere; }
.status-why { color: var(--muted); }
.status-why summary { cursor: pointer; color: var(--accent); font-weight: 400; }
.status-why[open] { flex-basis: 100%; }
.status-why .status-reason { display: block; margin-top: var(--s1); }

/* ---------------------------------------------------------------- messages */

.banner {
  border: 1px solid var(--line);
  border-left-width: 4px;
  border-radius: var(--radius-sm);
  padding: var(--s3) var(--s4);
  margin: 0 0 var(--s4);
  background: var(--surface);
  overflow-wrap: anywhere;
}
.banner.bad { background: var(--bad-bg); border-color: var(--bad); }
.banner.warn { background: var(--warn-bg); border-color: var(--warn); }
.banner.ok { background: var(--ok-bg); border-color: var(--ok); }
.banner pre { margin-bottom: 0; }
.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.5;
  border: 1px solid var(--line-strong);
  color: var(--muted);
  white-space: nowrap;
  vertical-align: 1px;
}
.badge.ok { color: var(--ok); border-color: transparent; background: var(--ok-bg); }
.badge.warn { color: var(--warn); border-color: transparent; background: var(--warn-bg); }
.badge.bad { color: var(--bad); border-color: transparent; background: var(--bad-bg); }
.badge.unknown { color: var(--muted); }
.status-line { margin: var(--s2) 0; }

/* ---------------------------------------------------------------- the steps of the first setup */

.progress { margin: 0 0 var(--s5); }
.progress ol { display: flex; list-style: none; padding: 0; margin: 0; }
.progress li { flex: 1 1 0; position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
.progress li::before {
  content: "";
  position: absolute;
  top: 13px;
  right: 50%;
  width: 100%;
  height: 2px;
  background: var(--line-strong);
  z-index: 0;
}
.progress li:first-child::before { display: none; }
.progress li.done::before { background: var(--accent); }
.progress .marker {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  background: var(--surface);
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 650;
}
.progress li.done .marker { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.progress li.current .marker { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.progress li.done.current .marker { color: var(--accent-fg); }
.progress .label { font-size: 0.78rem; color: var(--muted); text-align: center; overflow-wrap: anywhere; }
.progress li.current .label { color: var(--fg); font-weight: 650; }
.step-caption { font-size: 0.8rem; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); margin: 0 0 var(--s1); }
.step-title { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 var(--s2); }

/* ---------------------------------------------------------------- the two logins */

fieldset.choices { border: none; padding: 0; margin: 0 0 var(--s3); min-width: 0; }
fieldset.choices legend { font-weight: 600; font-size: 0.9rem; padding: 0; margin-bottom: var(--s2); }
label.choice {
  display: grid;
  grid-template-columns: 20px 1fr;
  gap: var(--s3);
  align-items: start;
  padding: var(--s4);
  margin: 0 0 var(--s3);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}
label.choice:hover { border-color: var(--accent); }
label.choice.selected { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
label.choice input[type="radio"] { width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--accent); }
label.choice:focus-within { outline: 3px solid var(--focus); outline-offset: 2px; }
.choice-label { display: flex; flex-direction: column; gap: 2px; }
.choice-title { font-weight: 650; }
.choice-text { color: var(--muted); font-size: 0.9rem; }
.choice-panel { margin: calc(-1 * var(--s1)) 0 var(--s4); padding: var(--s3) 0 0 calc(var(--s4) + 20px + var(--s3)); }
.wait {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
  padding: var(--s4);
  margin: 0 0 var(--s3);
}
.wait-title { display: flex; align-items: center; gap: var(--s2); font-weight: 650; }
.spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  border-top-color: var(--accent);
  animation: spin 900ms linear infinite;
  flex: none;
}
@keyframes spin { to { transform: rotate(360deg); } }
details.more { margin: var(--s3) 0; }
details.more > summary { cursor: pointer; color: var(--accent); font-weight: 600; font-size: 0.9rem; padding: var(--s1) 0; }
details.more[open] > summary { margin-bottom: var(--s2); }

/* ---------------------------------------------------------------- the small line about the step before */

.carried { display: flex; align-items: center; gap: var(--s2); color: var(--ok); font-size: 0.9rem; font-weight: 600; margin: 0 0 var(--s3); }
.carried-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--ok-bg);
  font-size: 0.75rem;
  flex: none;
}

/* ---------------------------------------------------------------- the stages of Telegram */

ol.stages { list-style: none; padding: 0; margin: 0; }
li.stage { display: grid; grid-template-columns: 28px 1fr; gap: var(--s3); padding: var(--s4) 0; border-top: 1px solid var(--line); }
li.stage:first-child { border-top: none; padding-top: 0; }
li.stage:last-child { padding-bottom: 0; }
.stage-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  background: var(--surface);
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 650;
}
li.stage.open .stage-mark { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
li.stage.failed .stage-mark { border-color: var(--bad); color: var(--bad); }
li.stage.skipped h3.stage-title { color: var(--muted); font-weight: 500; }
pre.log { max-height: 360px; overflow-y: auto; }
li.stage.done .stage-mark { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.stage-body { min-width: 0; }
.stage-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s1) var(--s3); min-height: 28px; }
h3.stage-title { margin: 0; font-size: 1rem; font-weight: 650; }
li.stage.done h3.stage-title { font-weight: 500; }
li.stage.later h3.stage-title { color: var(--muted); font-weight: 500; }
li.stage.open .stage-head { margin-bottom: var(--s3); }
.stage-head button.quiet { margin: 0; min-height: 32px; font-size: 0.875rem; }
.stage-detail { margin: var(--s1) 0 0; }
.stage-actions { margin-top: var(--s2); }
.stage-actions button { margin: 0; }
.stage-actions > button.quiet:first-child { margin-left: calc(-1 * var(--s2)); }
ol.send-list { margin: var(--s3) 0 var(--s4); padding-left: 1.4em; }
ol.send-list li { margin: var(--s2) 0; padding-left: var(--s1); }
ol.send-list button.copy { margin: 0 var(--s2) 0 var(--s2); min-height: 28px; padding: 2px 8px; font-size: 0.85rem; }
.topic-note { margin: var(--s3) 0 0; }
.topic-note .row { margin-top: var(--s2); }
.topic-note .row > * { margin: 0; }
.telegram .wait .wait-title { margin-bottom: var(--s3); }
.telegram .wait > button.quiet { margin-left: calc(-1 * var(--s2)); margin-bottom: 0; }
.telegram + .stage-actions { margin-top: var(--s4); }
.pair { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--s4) var(--s5); margin: 0 0 var(--s3); }
.pair-qr { flex: none; width: 200px; }
.pair-qr .help { margin-top: var(--s2); }
.pair-text { flex: 1 1 220px; min-width: 0; }
.pair-text a.button { margin: 0 0 var(--s3); }
.pair-code { font-size: 0.95rem; letter-spacing: 0.08em; }
/* A QR code stays dark on white in both themes, so a phone can read it. */
svg.qr { display: block; width: 200px; height: 200px; background: #ffffff; border-radius: var(--radius-sm); border: 1px solid var(--line); }

/* ---------------------------------------------------------------- fields and buttons */

.field { margin: 0 0 var(--s4); }
.field label { display: block; font-weight: 600; font-size: 0.9rem; margin-bottom: 6px; }
.field .help, .help { color: var(--muted); font-size: 0.85rem; margin: 6px 0 0; }
.help.meta { margin: 0 0 var(--s2); }
input, select, textarea, button { font: inherit; color: inherit; }
input[type="text"], input[type="password"], input[type="number"], select, textarea {
  width: 100%;
  max-width: 520px;
  min-height: 42px;
  padding: 8px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
textarea { max-width: 100%; min-height: 12em; font-family: var(--mono); font-size: 0.875rem; line-height: 1.45; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus); }
input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"] { border-color: var(--bad); }
input[type="checkbox"] { width: 16px; height: 16px; margin: 0 6px 0 0; vertical-align: -2px; accent-color: var(--accent); }
.input-row input { flex: 1 1 240px; max-width: 420px; }
.input-row button { margin: 0; }
button {
  min-height: 40px;
  padding: 8px 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
  font-weight: 600;
  cursor: pointer;
  margin: var(--s1) var(--s2) var(--s1) 0;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
button:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
button:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
button:disabled, button:disabled:hover {
  background: var(--panel);
  border-color: var(--line-strong);
  color: var(--muted);
  cursor: not-allowed;
}
button.secondary { background: var(--surface); color: var(--fg); border-color: var(--line-strong); }
button.secondary:hover { background: var(--panel); border-color: var(--muted); }
button.quiet { background: transparent; border-color: transparent; color: var(--muted); padding-left: var(--s2); padding-right: var(--s2); font-weight: 500; }
button.quiet:hover { color: var(--fg); background: var(--panel); }
a.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 8px 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
  font-weight: 600;
  text-decoration: none;
  margin: var(--s1) var(--s2) var(--s1) 0;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
a.button:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
a.button:focus-visible { border-radius: var(--radius-sm); }
a.button.secondary { background: var(--surface); color: var(--fg); border-color: var(--line-strong); }
a.button.secondary:hover { background: var(--panel); border-color: var(--muted); }
button.danger { background: transparent; color: var(--bad); border-color: var(--bad); }
button.danger:hover { background: var(--bad-bg); }
.actions-quiet > button.quiet:first-child, .login-foot > button.quiet { margin-left: calc(-1 * var(--s2)); }
.login-foot { margin-top: var(--s2); }
.login-foot > .status-line { margin: 0; }
.quiet-link { color: var(--muted); font-size: 0.9rem; text-decoration: none; }
.quiet-link:hover { color: var(--fg); text-decoration: underline; }
.row { display: flex; flex-wrap: wrap; gap: var(--s2); align-items: center; }
.row > p { margin: 0; }
.row select { width: auto; min-width: 160px; }
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s2) var(--s4);
  margin-top: var(--s5);
}
.actions > button { margin: 0; }
.actions-quiet { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s3); }
.actions-quiet:empty { display: none; }
.settings .actions { justify-content: flex-start; margin-top: var(--s3); }
.wizard .actions { border-top: 1px solid var(--line); padding-top: var(--s5); }
.wizard .actions > button { order: 2; min-width: 140px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0 var(--s4); }

/* ---------------------------------------------------------------- lists */

ul.facts { padding-left: 1.2em; margin: 0 0 var(--s3); }
ul.facts li { margin: var(--s1) 0; }
ul.checks { list-style: none; padding: 0; margin: 0 0 var(--s4); }
ul.checks li.check {
  display: grid;
  grid-template-columns: 22px 1fr;
  gap: var(--s3);
  padding: var(--s3) 0;
  border-top: 1px solid var(--line);
}
ul.checks li.check:first-child { border-top: none; }
.mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-top: 1px;
  border-radius: 50%;
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--muted);
  background: var(--panel);
}
.mark.ok { color: var(--ok); background: var(--ok-bg); }
.mark.warn { color: var(--warn); background: var(--warn-bg); }
.mark.bad { color: var(--bad); background: var(--bad-bg); }
.check-body { min-width: 0; }
.check-head { margin: 0 0 2px; }
.check-detail { margin: 0; color: var(--muted); font-size: 0.9rem; overflow-wrap: anywhere; }
.check-body .small { margin: var(--s2) 0 0; }
.check-body pre { margin: var(--s2) 0; }
.check-body button { margin-top: var(--s2); }
.check-box { margin: var(--s2) 0 var(--s3); }

/* ---------------------------------------------------------------- the dashboard */

.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; padding: var(--s2) var(--s2); border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; white-space: nowrap; color: var(--muted); font-size: 0.8rem; }
td.num, th.num { text-align: right; white-space: nowrap; }
tr.failed td { background: var(--bad-bg); }
td .cell-text { white-space: pre-wrap; word-break: break-word; max-width: 32em; }

@media (max-width: 600px) {
  main { padding: var(--s4) var(--s3) var(--s6); }
  section.card, .wizard section.card.step { padding: var(--s4); }
  .progress .label { font-size: 0.7rem; }
  .step-title { font-size: 1.3rem; }
  .choice-panel { padding-left: 0; }
  th, td { padding: var(--s1) 6px; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
  .spinner { animation: none; border-top-color: var(--line-strong); }
}
`;
