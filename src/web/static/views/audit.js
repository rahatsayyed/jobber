// src/web/static/views/audit.js
// GET /api/audit?before=<id> -> {items: [{id, at, kind, ip, note}]}; no nextCursor, so paging uses the last id.
import { get } from '../api.js';
import { button, clear, el, fmtDate, notice, showError, table } from '../dom.js';

const PAGE = 50;

export async function render({ root }) {
  const all = [];
  const body = el('div'); const foot = el('div', { class: 'row' });
  root.append(el('h2', null, 'Audit log'), body, foot);
  async function load(before) {
    const r = await get('/api/audit', { limit: PAGE, before });
    all.push(...r.items);
    clear(body).append(all.length
      ? table([{ label: 'When', render: (a) => fmtDate(a.at) }, { label: 'Event', key: 'kind' }, { label: 'IP', key: 'ip' },
        { label: 'Note', key: 'note' }], all)
      : notice('No audit entries.'));
    clear(foot);
    if (r.items.length === PAGE) foot.append(button('Load more', () => load(all[all.length - 1].id).catch(showError(foot))));
  }
  await load(null);
}
