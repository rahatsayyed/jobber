// src/web/static/views/sessions.js
// GET /api/sessions -> {sessions: [{session, up, windows: [{window, index, command, active, lastLine}]}]}
// GET /api/pane?window=<name> -> {window, text}   (polled every 10 s, skipped while the tab is hidden)
import { get } from '../api.js';
import { badge, button, clear, el, poll, pre, showError } from '../dom.js';

export async function render({ root, onCleanup }) {
  const list = el('div'); const live = el('div', { 'aria-live': 'polite' });
  root.append(el('h2', null, 'Sessions'), list, el('h3', null, 'Live pane'), live);
  let selected = null;
  let stop = null;

  async function refreshPane() {
    if (!selected) return;
    try {
      const r = await get('/api/pane', { window: selected });
      clear(live).append(el('p', { class: 'muted' }, `${r.window}, refreshed every 10 seconds while this tab is visible`), pre(r.text));
    } catch (e) {
      showError(live)(e);
    }
  }
  function choose(name) {
    selected = name;
    if (stop) stop();
    refreshPane();
    stop = poll(refreshPane, 10000);
  }
  onCleanup(() => { if (stop) stop(); });

  const data = await get('/api/sessions');
  if (data.sessions.length === 0) list.append(el('p', { class: 'muted' }, 'No sessions configured.'));
  for (const s of data.sessions) {
    list.append(el('h3', null, s.session, ' ', badge(s.up ? 'up' : 'down', s.up ? 'good' : 'bad')));
    if (s.windows.length === 0) continue;
    list.append(el('ul', { class: 'windows' }, s.windows.map((w) => el('li', { class: 'card' },
      el('div', { class: 'row' }, el('strong', null, `${w.index}: ${w.window}`), w.active ? badge('active') : null,
        el('span', { class: 'muted' }, w.command)),
      el('p', { class: 'last-line' }, w.lastLine || '-'),
      button('Watch live', () => choose(w.window))))));
  }
}
