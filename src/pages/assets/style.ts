/** The style sheet of both pages. System fonts only, light and dark from the system setting. */
export const STYLE_CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1d1d1f;
  --muted: #5f6368;
  --line: #d9dce1;
  --panel: #f6f7f9;
  --accent: #0b57d0;
  --accent-fg: #ffffff;
  --ok: #146c2e;
  --warn: #8a5300;
  --bad: #b3261e;
  --bad-bg: #fdecea;
  --warn-bg: #fff4e0;
  --ok-bg: #e6f4ea;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a;
    --fg: #e8eaed;
    --muted: #a5a9b0;
    --line: #3a3d42;
    --panel: #212327;
    --accent: #8ab4f8;
    --accent-fg: #0b1b33;
    --ok: #81c995;
    --warn: #fdd663;
    --bad: #f28b82;
    --bad-bg: #3b1d1b;
    --warn-bg: #3a2f12;
    --ok-bg: #17321f;
  }
}
* { box-sizing: border-box; }
html { font-size: 16px; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  line-height: 1.45;
}
header.top {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
header.top h1 { font-size: 1.25rem; margin: 0; }
header.top nav a { margin-left: 12px; }
main { max-width: 980px; margin: 0 auto; padding: 16px; }
a { color: var(--accent); }
h2 { font-size: 1.1rem; margin: 0 0 8px; }
h3 { font-size: 1rem; margin: 16px 0 6px; }
section.card {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px 16px;
  margin: 0 0 16px;
  background: var(--bg);
}
.muted { color: var(--muted); }
.small { font-size: 0.875rem; }
.banner { border-radius: 8px; padding: 10px 14px; margin: 0 0 16px; border: 1px solid var(--line); }
.banner.bad { background: var(--bad-bg); border-color: var(--bad); }
.banner.warn { background: var(--warn-bg); border-color: var(--warn); }
.banner.ok { background: var(--ok-bg); border-color: var(--ok); }
.error { color: var(--bad); font-size: 0.875rem; margin: 4px 0 0; }
.good { color: var(--ok); }
.badge {
  display: inline-block;
  padding: 0 8px;
  border-radius: 10px;
  font-size: 0.8rem;
  border: 1px solid var(--line);
  white-space: nowrap;
}
.badge.ok { color: var(--ok); border-color: var(--ok); }
ul.checks { list-style: none; padding: 0; margin: 0 0 12px; }
ul.checks li { padding: 6px 0; border-top: 1px solid var(--line); }
ul.checks li:first-child { border-top: none; }
.badge.bad { color: var(--bad); border-color: var(--bad); }
.badge.warn { color: var(--warn); border-color: var(--warn); }
.field { margin: 0 0 12px; }
.field label { display: block; font-weight: 600; margin-bottom: 2px; }
.field .help { color: var(--muted); font-size: 0.85rem; margin: 2px 0 0; }
input, select, textarea, button {
  font: inherit;
  color: inherit;
}
input[type="text"], input[type="password"], input[type="number"], select, textarea {
  width: 100%;
  max-width: 520px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
}
textarea { max-width: 100%; min-height: 12em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.875rem; }
input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"] { border-color: var(--bad); }
button {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
  cursor: pointer;
  margin: 4px 8px 4px 0;
}
button.secondary { background: transparent; color: var(--accent); }
button.danger { background: transparent; color: var(--bad); border-color: var(--bad); }
button:disabled { opacity: 0.5; cursor: default; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0 16px; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
pre {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; white-space: nowrap; }
td.num, th.num { text-align: right; white-space: nowrap; }
tr.failed td { background: var(--bad-bg); }
td .cell-text { white-space: pre-wrap; word-break: break-word; max-width: 32em; }
ol.steps { padding-left: 1.4em; }
ol.steps li { margin: 4px 0; }
ol.steps li.current { font-weight: 600; }
.status-line { margin: 6px 0; }
@media (max-width: 600px) {
  main { padding: 10px; }
  section.card { padding: 10px; }
  th, td { padding: 4px 6px; }
}
`;
