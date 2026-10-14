// src/web/static/views/jobs.js
// GET /api/jobs?bucket&q&cursor -> {items: JobRow[], nextCursor}; JobRow {id,title,company,source,score,confidence,
//   excluded_reason,posted_at,deadline,created_at,bucket[],flags[]}
// GET /api/jobs/counts -> {discovered,matched,applied,pending,failed}
// GET /api/jobs/:id -> JobRow + {url,apply_url,strengths[],gaps[],requirements[],queue[],applications[],outcomes[]}
// url and apply_url are stored text and are shown as plain text, never as links.
import { get } from '../api.js';
import { badge, button, clear, el, fmtDate, paged, show, showError, table } from '../dom.js';

const BUCKETS = ['discovered', 'matched', 'applied', 'pending', 'failed'];

function list(title, xs) {
  return el('div', null, el('h3', null, title),
    xs.length ? el('ul', null, xs.map((x) => el('li', null, x))) : el('p', { class: 'muted' }, 'None.'));
}

function detail(d) {
  return el('article', { class: 'panel' },
    el('h2', null, `${d.title} at ${d.company}`),
    el('p', null, `Score ${show(d.score)} (${show(d.confidence)}). Source ${d.source}. Posted ${show(d.posted_at)}. Deadline ${show(d.deadline)}.`),
    d.excluded_reason ? el('p', null, badge('excluded', 'bad'), ` ${d.excluded_reason}`) : null,
    d.flags.length ? list('Flags', d.flags) : null,
    el('p', null, `Posting: ${show(d.url)}`),
    el('p', null, `Apply: ${show(d.apply_url)}`),
    list('Strengths', d.strengths), list('Gaps', d.gaps), list('Requirements', d.requirements),
    el('h3', null, 'Outreach'),
    d.queue.length
      ? table([{ label: 'Email', render: (q) => show(q.email_status) }, { label: 'Connect', render: (q) => show(q.connect_status) },
        { label: 'Apply', render: (q) => show(q.apply_status) }, { label: 'ATS', render: (q) => show(q.ats_coverage) }], d.queue)
      : el('p', { class: 'muted' }, 'Nothing queued.'),
    el('h3', null, 'Applications'),
    d.applications.length
      ? table([{ label: 'Platform', key: 'platform' }, { label: 'Status', key: 'status' }, { label: 'Reason', key: 'reason' },
        { label: 'When', render: (a) => fmtDate(a.applied_at) }], d.applications)
      : el('p', { class: 'muted' }, 'None.'),
    el('h3', null, 'Outcomes'),
    d.outcomes.length
      ? table([{ label: 'Outcome', key: 'outcome' }, { label: 'Note', key: 'note' }, { label: 'When', render: (o) => fmtDate(o.created_at) }], d.outcomes)
      : el('p', { class: 'muted' }, 'None.'));
}

export async function render({ root }) {
  let bucket = 'discovered';
  let q = '';
  const counts = await get('/api/jobs/counts');
  const tabs = el('div', { class: 'tabs', 'aria-label': 'Job buckets' });
  const search = el('input', { type: 'search', placeholder: 'Search title or company', 'aria-label': 'Search jobs' });
  const results = el('div'); const panel = el('div', { 'aria-live': 'polite' });

  async function showDetail(id) {
    try {
      clear(panel).append(detail(await get(`/api/jobs/${encodeURIComponent(id)}`)));
    } catch (e) {
      showError(panel)(e);
    }
  }
  function load() {
    clear(results);
    clear(tabs).append(...BUCKETS.map((b) =>
      button(`${b} (${counts[b]})`, () => { bucket = b; load(); }, { class: b === bucket ? 'tab active' : 'tab' })));
    const cols = [
      { label: 'Job', render: (j) => button(`${j.title}`, () => showDetail(j.id), { class: 'link' }) },
      { label: 'Company', key: 'company' }, { label: 'Score', key: 'score' }, { label: 'Source', key: 'source' },
      { label: 'Flags', render: (j) => (j.excluded_reason ? badge('excluded', 'bad') : j.flags.join('; ') || '-') },
    ];
    paged(results, (cursor) => get('/api/jobs', { bucket, q, cursor }), (items) => table(cols, items)).catch(showError(results));
  }
  const go = () => { q = search.value.trim(); load(); };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  root.append(el('h2', null, 'Jobs'), tabs, el('div', { class: 'row' }, search, button('Search', go)), results, panel);
  load();
}
