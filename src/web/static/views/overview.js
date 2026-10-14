// src/web/static/views/overview.js
// GET /api/jobs/counts {discovered, matched, applied, pending, failed}
// GET /api/funnel {discovered, matched, contacted, replied, interview, offer, rates{reply, interview, rejection},
//                  first_response_days_median, benchmarks{response_rate, interview_rate, first_response_days}}
// GET /api/status (polled 30 s) {generatedAt, ceilings{key:{used,limit,ok}}, halts[{platform,reason,setAt}],
//                  queue[{status,count}], lastSend, degraded[]}
import { get } from '../api.js';
import { badge, clear, el, fmtDate, notice, pct, poll, show, showError } from '../dom.js';

const bench = (b) => `typical ${pct(b.typical)}, ${pct(b.low)}-${pct(b.high)}`;

function funnelLine(f) {
  const b = f.benchmarks;
  return el('div', null,
    el('p', { class: 'funnel-line' },
      `discovered ${f.discovered} -> matched ${f.matched} -> contacted ${f.contacted} -> replied ${f.replied} -> interview ${f.interview} -> offer ${f.offer}`),
    el('ul', null,
      el('li', null, `Reply rate ${pct(f.rates.reply)} (${bench(b.response_rate)})`),
      el('li', null, `Interview rate ${pct(f.rates.interview)} (${bench(b.interview_rate)})`),
      el('li', null, `Median days to first response: ${show(f.first_response_days_median)} (typical ${b.first_response_days.typical}, ${b.first_response_days.low}-${b.first_response_days.high})`),
      el('li', null, `Rejection rate ${pct(f.rates.rejection)}`)),
    el('p', { class: 'muted' }, 'Benchmarks are context, not targets.'));
}

function statusPanel(s) {
  const halts = s.halts.length
    ? el('ul', null, s.halts.map((h) => el('li', null, badge('halted', 'bad'), ` ${h.platform}: ${h.reason} (since ${fmtDate(h.setAt)})`)))
    : el('p', null, 'No halts.');
  const ceil = Object.entries(s.ceilings).map(([k, c]) =>
    el('li', null, `${k}: ${c.used} / ${c.limit} `, badge(c.ok ? 'ok' : 'at limit', c.ok ? 'good' : 'bad')));
  const queue = s.queue.length ? s.queue.map((q) => el('li', null, `${q.status}: ${q.count}`)) : [el('li', null, 'Queue is empty.')];
  return el('div', null,
    s.degraded.length ? notice(`Some data is unavailable: ${s.degraded.join(', ')}`, 'warn') : null,
    el('h2', null, 'Halts'), halts,
    el('h2', null, 'Daily ceilings'), el('ul', null, ceil),
    el('h2', null, 'Queue'), el('ul', null, queue),
    el('p', { class: 'muted' }, `Last send: ${s.lastSend ? `${s.lastSend.kind} at ${fmtDate(s.lastSend.at)}` : '-'}. Updated ${fmtDate(s.generatedAt)}.`));
}

export async function render({ root, onCleanup }) {
  const counts = el('section'); const funnel = el('section'); const status = el('section', { 'aria-live': 'polite' });
  root.append(el('h2', null, 'Jobs'), counts, el('h2', null, 'Funnel'), funnel, status);
  const [c, f] = await Promise.all([get('/api/jobs/counts'), get('/api/funnel')]);
  counts.append(el('div', { class: 'cards' },
    Object.entries(c).map(([k, n]) => el('div', { class: 'card' }, el('strong', null, String(n)), el('span', null, k)))));
  funnel.append(funnelLine(f));
  async function refresh() {
    try {
      const s = await get('/api/status');
      clear(status).append(statusPanel(s));
    } catch (e) {
      showError(status)(e);
    }
  }
  await refresh();
  onCleanup(poll(refresh, 30000));
}
