// src/web/static/views/mail.js
// GET /api/emails?q&cursor -> {items: SentEmail[], nextCursor}; SentEmail {id,job_id,title,company,to,subject,sent_at,
//   thread_id,status,has_reply}
// GET /api/emails/:id -> SentEmail + {body, followups: FollowupRow[], replies: ReplyRow[]}
// GET /api/followups?status&cursor -> {items: FollowupRow[]}; FollowupRow {id,job_id,n,status,subject,body,created_at,sent_at}
// GET /api/replies?cursor -> {items: ReplyRow[]}; ReplyRow {message_id,job_id,classification,action,proposed_outcome,
//   from_addr,subject,reply_date}
import { get } from '../api.js';
import { badge, button, clear, el, fmtDate, paged, pre, show, showError, table } from '../dom.js';

const TABS = ['sent', 'follow-ups', 'replies'];

function emailPanel(d) {
  return el('article', { class: 'panel' },
    el('h3', null, show(d.subject)),
    el('p', null, `To ${show(d.to)} for ${show(d.title)} at ${show(d.company)}. Sent ${fmtDate(d.sent_at)}. Status ${show(d.status)}.`),
    pre(d.body),
    el('h4', null, 'Follow-ups'),
    d.followups.length ? el('ul', null, d.followups.map((f) => el('li', { class: 'msg' },
      el('div', { class: 'row' }, badge(`#${f.n}`), badge(f.status), el('span', { class: 'muted' }, fmtDate(f.sent_at || f.created_at))),
      pre(f.body)))) : el('p', { class: 'muted' }, 'None.'),
    el('h4', null, 'Replies on this job'),
    d.replies.length
      ? table([{ label: 'From', key: 'from_addr' }, { label: 'Subject', key: 'subject' }, { label: 'Class', key: 'classification' },
        { label: 'Proposed', key: 'proposed_outcome' }, { label: 'Date', render: (r) => fmtDate(r.reply_date) }], d.replies)
      : el('p', { class: 'muted' }, 'None.'));
}

export async function render({ root }) {
  let tab = 'sent';
  const tabs = el('div', { class: 'tabs' }); const results = el('div'); const panel = el('div', { 'aria-live': 'polite' });
  async function open(id) {
    try {
      clear(panel).append(emailPanel(await get(`/api/emails/${encodeURIComponent(id)}`)));
    } catch (e) {
      showError(panel)(e);
    }
  }
  const sources = {
    sent: {
      path: '/api/emails',
      cols: [{ label: 'Subject', render: (m) => button(show(m.subject), () => open(m.id), { class: 'link' }) },
        { label: 'Company', key: 'company' }, { label: 'To', key: 'to' }, { label: 'Sent', render: (m) => fmtDate(m.sent_at) },
        { label: 'Reply', render: (m) => (m.has_reply ? badge('replied', 'good') : '-') }],
    },
    'follow-ups': {
      path: '/api/followups',
      cols: [{ label: 'Job', key: 'job_id' }, { label: 'No.', key: 'n' }, { label: 'Status', key: 'status' },
        { label: 'Subject', key: 'subject' }, { label: 'Body', render: (f) => pre(f.body) },
        { label: 'Sent', render: (f) => fmtDate(f.sent_at) }],
    },
    replies: {
      path: '/api/replies',
      cols: [{ label: 'From', key: 'from_addr' }, { label: 'Subject', key: 'subject' }, { label: 'Class', key: 'classification' },
        { label: 'Action', key: 'action' }, { label: 'Proposed', key: 'proposed_outcome' }, { label: 'Job', key: 'job_id' },
        { label: 'Date', render: (r) => fmtDate(r.reply_date) }],
    },
  };
  function load() {
    clear(tabs).append(...TABS.map((t) => button(t, () => { tab = t; clear(panel); load(); }, { class: t === tab ? 'tab active' : 'tab' })));
    clear(results);
    const s = sources[tab];
    paged(results, (cursor) => get(s.path, { cursor }), (items) => table(s.cols, items)).catch(showError(results));
  }
  root.append(el('h2', null, 'Mail'), tabs, results, panel);
  load();
}
