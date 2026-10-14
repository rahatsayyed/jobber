// src/web/static/views/config.js
// GET /api/config -> {env: [{name, value, masked}], files: [{path, summary: object}], halts[], ceilings{}}
// A masked item never carries its value; it is shown with a "masked" badge.
import { get } from '../api.js';
import { badge, el, fmtDate, pre, table } from '../dom.js';

export async function render({ root }) {
  const c = await get('/api/config');
  root.append(
    el('h2', null, 'Config'),
    el('p', { class: 'muted' }, 'Read only. Secret values are never sent to this page.'),
    el('h3', null, 'Environment'),
    table([
      { label: 'Name', key: 'name' },
      { label: 'Value', render: (i) => (i.masked ? badge('masked', 'warn') : i.value) },
    ], c.env),
    el('h3', null, 'Config files'),
    c.files.length
      ? el('div', null, c.files.map((f) => el('details', null, el('summary', null, f.path), pre(JSON.stringify(f.summary, null, 2)))))
      : el('p', { class: 'muted' }, 'None found.'),
    el('h3', null, 'Halts'),
    c.halts.length
      ? el('ul', null, c.halts.map((h) => el('li', null, `${h.platform}: ${h.reason} (since ${fmtDate(h.setAt)})`)))
      : el('p', null, 'No halts.'),
    el('h3', null, 'Ceilings'),
    el('ul', null, Object.entries(c.ceilings).map(([k, v]) => el('li', null, `${k}: ${v.used} / ${v.limit}`))),
  );
}
