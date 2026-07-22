/** Self-contained presentation styles for the offline session viewer. */
export const SESSION_EXPORT_STYLE = String.raw`
:root {
  color-scheme: dark;
  --page: #0f1117;
  --surface: #171a23;
  --surface-2: #1d2230;
  --border: #30384a;
  --text: #e8ebf2;
  --muted: #98a2b5;
  --accent: #75b8ff;
  --success: #76d49b;
  --warning: #f4c96b;
  --error: #ff8585;
  --user: #1d2a3d;
  --tool: #17241f;
  --sidebar-width: 310px;
}

:root[data-theme="light"] {
  color-scheme: light;
  --page: #f7f8fb;
  --surface: #ffffff;
  --surface-2: #eef2f8;
  --border: #ccd4e0;
  --text: #1b2432;
  --muted: #5f6b7c;
  --accent: #1368b7;
  --success: #176b3a;
  --warning: #875700;
  --error: #b4232a;
  --user: #e8f2ff;
  --tool: #eaf6ef;
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  overflow: hidden;
  background: var(--page);
  color: var(--text);
  font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
button, input { font: inherit; }
button { color: inherit; }

#app { display: flex; height: 100%; min-width: 0; }
#sidebar {
  width: var(--sidebar-width);
  min-width: 220px;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  flex: none;
  border-right: 1px solid var(--border);
  background: var(--surface);
}
.sidebar-head { padding: 12px; border-bottom: 1px solid var(--border); }
.sidebar-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; }
.sidebar-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-search {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--page);
  color: var(--text);
}
.tree-search:focus { outline: 1px solid var(--accent); }
.filters, .viewer-actions { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px; }
.compact-button {
  min-height: 28px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-2);
  cursor: pointer;
}
.compact-button:hover, .compact-button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.tree { flex: 1; overflow: auto; padding: 7px 4px; }
.tree-row {
  width: 100%;
  display: flex;
  gap: 7px;
  align-items: baseline;
  border: 0;
  border-radius: 4px;
  padding: 3px 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  text-align: left;
}
.tree-row:hover { background: var(--surface-2); color: var(--text); }
.tree-row.active { background: var(--surface-2); color: var(--accent); font-weight: 700; }
.tree-row.in-path { color: var(--text); }
.tree-prefix { flex: none; white-space: pre; color: var(--muted); }
.tree-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-count { padding: 6px 12px 10px; color: var(--muted); font-size: 12px; }
#resizer { width: 6px; flex: none; cursor: col-resize; background: transparent; }
#resizer:hover, body.resizing #resizer { background: color-mix(in srgb, var(--accent) 25%, transparent); }

#content { min-width: 0; flex: 1; overflow: auto; padding: 22px clamp(16px, 4vw, 54px) 70px; }
.content-inner { width: min(900px, 100%); margin: 0 auto; }
.topbar { display: flex; align-items: start; justify-content: space-between; gap: 18px; margin-bottom: 16px; }
.topbar h1 { font-size: 17px; margin: 0; overflow-wrap: anywhere; }
.meta { color: var(--muted); font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
.usage-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin: 12px 0 16px; }
.usage-cell { background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 8px 10px; }
.usage-cell span { display: block; color: var(--muted); font-size: 11px; }
.usage-cell strong { display: block; margin-top: 2px; font-size: 13px; }
.usage-cell small { display: block; color: var(--muted); font-size: 10px; }
.session-details { margin: 0 0 18px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }
.session-details > summary { padding: 9px 11px; cursor: pointer; color: var(--muted); }
.details-body { padding: 0 11px 11px; }
.details-body h3 { font-size: 12px; margin: 12px 0 4px; color: var(--accent); }

#messages { display: flex; flex-direction: column; gap: 10px; }
.entry { position: relative; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); overflow: hidden; }
.entry.user { background: var(--user); }
.entry.tool, .entry.tool-row { background: var(--tool); }
.entry-head { display: flex; justify-content: space-between; gap: 12px; padding: 7px 10px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 11px; }
.entry-kind { font-weight: 700; color: var(--text); }
.entry-body { padding: 10px; }
.entry.structural .entry-body { color: var(--muted); }
.entry.hidden-entry { opacity: .72; }
.entry.error { border-color: color-mix(in srgb, var(--error) 65%, var(--border)); }
.deep-link { border: 0; background: transparent; color: var(--muted); cursor: pointer; padding: 0; }
.deep-link:hover { color: var(--accent); }
.target-flash { animation: target-flash 1.8s ease-out; }
@keyframes target-flash { from { box-shadow: 0 0 0 3px var(--accent); } to { box-shadow: 0 0 0 0 transparent; } }

.text-block { white-space: pre-wrap; overflow-wrap: anywhere; }
.code-block, .json-block, .terminal-output {
  margin: 7px 0 0;
  padding: 9px;
  overflow: auto;
  white-space: pre;
  border-radius: 6px;
  background: var(--page);
  border: 1px solid var(--border);
  color: var(--text);
  font: inherit;
}
.markdown-link { color: var(--accent); text-decoration: underline; }
.inline-image { display: block; max-width: min(100%, 760px); max-height: 70vh; margin: 8px 0; border-radius: 6px; border: 1px solid var(--border); cursor: zoom-in; }
.image-fallback { color: var(--muted); }
.tool-card, .reasoning-card, .skill-card { margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--page); }
.tool-card > summary, .reasoning-card > summary, .skill-card > summary { padding: 7px 9px; cursor: pointer; }
.tool-card > div, .reasoning-card > div, .skill-card > div { padding: 0 9px 9px; }
.tool-card[open] > .collapsed-preview { display: none; }
.tool-status-error { color: var(--error); }
.tool-status-success { color: var(--success); }
.structural-title { color: var(--warning); font-weight: 700; }
.ansi-line { min-height: 1.55em; white-space: pre; }
.role-muted { color: var(--muted); }
.role-accent, .role-link { color: var(--accent); }
.role-success { color: var(--success); }
.role-warning { color: var(--warning); }
.role-error { color: var(--error); }
.role-title { font-weight: 700; }
.is-hidden { display: none !important; }
.empty { padding: 28px; border: 1px dashed var(--border); color: var(--muted); text-align: center; border-radius: 8px; }

#mobile-open, #mobile-close { display: none; }
#overlay { display: none; }
.image-modal { position: fixed; inset: 0; z-index: 50; display: none; place-items: center; padding: 24px; background: rgba(0,0,0,.88); }
.image-modal.open { display: grid; }
.image-modal img { max-width: 95vw; max-height: 92vh; object-fit: contain; }

@media (max-width: 760px) {
  #sidebar { position: fixed; inset: 0 auto 0 0; z-index: 40; width: min(88vw, 360px); max-width: none; transform: translateX(-102%); transition: transform .18s ease; }
  body.sidebar-open #sidebar { transform: translateX(0); }
  #resizer { display: none; }
  #mobile-open, #mobile-close { display: inline-flex; }
  #overlay { position: fixed; inset: 0; z-index: 30; background: rgba(0,0,0,.55); }
  body.sidebar-open #overlay { display: block; }
  #content { padding: 14px 12px 48px; }
  .topbar { align-items: center; }
  .usage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media print {
  body { overflow: visible; }
  #app { height: auto; }
  #sidebar, #resizer, #mobile-open, .viewer-actions, .deep-link { display: none !important; }
  #content { overflow: visible; padding: 0; }
  .content-inner { width: 100%; max-width: none; }
}
`;
