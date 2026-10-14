// src/web/static/views/runs.js
// GET /api/runs -> {available:false, note} | {available:true, items:[{id,started_at,finished_at,kind,status,summary}]}
import { get } from '../api.js';
import { el, fmtDate, notice, pre, show, table } from '../dom.js';

export async function render({ root }) {
  const r = await get('/api/runs');
  root.append(el('h2', null, 'Runs'));
  if (!r.available) {
    root.append(notice(`Run history is not available yet. ${show(r.note)}`));
    return;
  }
  if (r.items.length === 0) {
    root.append(notice('No runs recorded.'));
    return;
  }
  root.append(table([
    { label: 'Started', render: (x) => fmtDate(x.started_at) }, { label: 'Finished', render: (x) => fmtDate(x.finished_at) },
    { label: 'Kind', key: 'kind' }, { label: 'Status', key: 'status' }, { label: 'Summary', render: (x) => pre(x.summary) },
  ], r.items));
}
