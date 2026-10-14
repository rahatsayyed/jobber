// src/web/static/views/people.js
// GET /api/people?q&stage&cursor -> {items: PersonRow[], nextCursor}; PersonRow {id,platform,name,headline,company,
//   category,stage,followups_sent,last_touch_at,next_due_at,paused_reason}
// GET /api/people/:id/thread?cursor -> {person: PersonRow, touches: {items: Touch[], nextCursor}}
//   Touch {id,job_id,kind,status,body,created_at,sent_at}
import { get } from '../api.js';
import { badge, button, clear, el, fmtDate, paged, pre, show, showError, table } from '../dom.js';

function touch(t) {
  return el('li', { class: 'msg' },
    el('div', { class: 'row' }, badge(t.kind), badge(t.status), el('span', { class: 'muted' }, fmtDate(t.sent_at || t.created_at))),
    pre(t.body));
}

async function showThread(host, id) {
  clear(host);
  const head = el('div');
  const body = el('div');
  host.append(el('h3', null, 'Thread'), head, body);
  await paged(body, async (cursor) => {
    const r = await get(`/api/people/${encodeURIComponent(id)}/thread`, { cursor });
    if (!cursor) {
      const p = r.person;
      clear(head).append(el('p', null, `${show(p.name)}, ${show(p.headline)} at ${show(p.company)} (${p.platform}, ${p.category})`));
    }
    return r.touches;
  }, (items) => el('ul', { class: 'thread' }, items.map(touch)));
}

export async function render({ root, arg }) {
  let q = '';
  const search = el('input', { type: 'search', placeholder: 'Search name or company', 'aria-label': 'Search people' });
  const results = el('div'); const panel = el('div', { 'aria-live': 'polite' });
  const cols = [
    { label: 'Name', render: (p) => button(show(p.name), () => { location.hash = `#/people/${p.id}`; }, { class: 'link' }) },
    { label: 'Company', key: 'company' }, { label: 'Headline', key: 'headline' }, { label: 'Platform', key: 'platform' },
    { label: 'Stage', key: 'stage' }, { label: 'Follow-ups', key: 'followups_sent' },
    { label: 'Last touch', render: (p) => fmtDate(p.last_touch_at) },
    { label: 'Paused', render: (p) => (p.paused_reason ? badge(p.paused_reason, 'warn') : '-') },
  ];
  function load() {
    clear(results);
    paged(results, (cursor) => get('/api/people', { q, cursor }), (items) => table(cols, items)).catch(showError(results));
  }
  const go = () => { q = search.value.trim(); load(); };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  root.append(el('h2', null, 'People'), el('div', { class: 'row' }, search, button('Search', go)), results, panel);
  load();
  if (arg && /^\d+$/.test(arg)) showThread(panel, arg).catch(showError(panel));
}
