// src/web/static/views/outcomes.js
// GET /api/outcomes?cursor -> {items: OutcomeRow[], nextCursor}; OutcomeRow {id,job_id,title,company,outcome,note,created_at}
// GET /api/funnel -> {discovered, matched, contacted, replied, interview, offer}
import { get } from '../api.js';
import { el, fmtDate, paged, show, showError, table } from '../dom.js';

const STAGES = ['discovered', 'matched', 'contacted', 'replied', 'interview', 'offer'];

function bars(f) {
  const max = Math.max(1, ...STAGES.map((s) => f[s]));
  return el('div', { class: 'bars' }, STAGES.map((s) => {
    const fill = el('div', { class: 'bar-fill' });
    fill.style.width = `${Math.round((f[s] / max) * 100)}%`;
    return el('div', { class: 'bar-row' }, el('span', { class: 'bar-label' }, s),
      el('div', { class: 'bar-track' }, fill), el('span', { class: 'bar-n' }, String(f[s])));
  }));
}

export async function render({ root }) {
  const f = await get('/api/funnel');
  const results = el('div');
  root.append(el('h2', null, 'Outcomes'), el('h3', null, 'Funnel'), bars(f), el('h3', null, 'Recorded outcomes'), results);
  const cols = [
    { label: 'Job', render: (o) => `${show(o.title)} at ${show(o.company)}` },
    { label: 'Outcome', key: 'outcome' }, { label: 'Note', key: 'note' },
    { label: 'When', render: (o) => fmtDate(o.created_at) },
  ];
  paged(results, (cursor) => get('/api/outcomes', { cursor }), (items) => table(cols, items)).catch(showError(results));
}
