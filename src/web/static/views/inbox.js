// Inbox: the open escalations that need the owner, one card per conversation.
// GET /api/escalations?status&platform&group -> {items, counts: {open, snoozed, resolved}}
//   item {id, ids, count, updates, platform, reason, label, todo, askKind, detail, group, flag, created_at, first_at, last_at, threadRef, threadUrl,
//         senderName, senderHeadline, excerpt, messageAt, rawText, personName, personCompany, jobTitle, snoozed_until, resolved_at}
// POST /api/escalations/resolve {ids}; POST /api/escalations/snooze {ids, hours}.
// Every field is untrusted model or third-party text and is set with textContent only. A thread link is shown as text with a Copy button,
// never as an anchor, so nothing is followed from here. The owner answers on the platform itself; this page only lists and marks handled.
// rawText (text the input screen blocked) is hidden behind a button and, once shown, is a plain text node.
import { get, post } from '../api.js';
import { badge, button, clear, el, fmtDate, notice, show, showError } from '../dom.js';
import { askBadge, bodyState, relativeTime } from './inboxModel.js';

const GROUPS = [['', 'All groups'], ['human', 'Replies and needs you'], ['platform', 'Platform and tool problems'], ['noise', 'Flagged']];
const STATUSES = [['open', 'Open'], ['snoozed', 'Snoozed'], ['resolved', 'Handled'], ['all', 'All']];
const PLATFORMS = [['', 'All platforms'], ['linkedin', 'LinkedIn'], ['naukri', 'Naukri'], ['wellfound', 'Wellfound'], ['apply', 'Apply'], ['scheduler', 'Scheduler']];
const SNOOZES = [[1, '1 hour'], [4, '4 hours'], [24, '1 day'], [72, '3 days'], [168, '1 week']];

function select(label, options, value, onChange) {
  const s = el('select', { 'aria-label': label }, options.map(([v, t]) => el('option', { value: v }, t)));
  s.value = String(value);
  if (onChange) s.addEventListener('change', () => onChange(s.value));
  return s;
}

async function copy(text, out) {
  try {
    await navigator.clipboard.writeText(text);
    clear(out).append(notice('Link copied. Paste it in your browser.', 'good'));
  } catch {
    clear(out).append(notice('Could not copy. Select the link text and copy it.', 'warn'));
  }
}

/** The message as a quoted block (line breaks kept); long text starts collapsed with a Show more toggle. */
function quote(text, long) {
  const q = el('blockquote', { class: long ? 'quote clamped' : 'quote' }, text);
  if (!long) return q;
  const more = button('Show more', () => {
    const open = q.classList.toggle('clamped');
    more.textContent = open ? 'Show more' : 'Show less';
  });
  return el('div', null, q, more);
}

/** Flagged text stays out of the page until the owner asks for it. */
function flaggedToggle(rawText) {
  const host = el('div');
  const btn = button('Show flagged text (untrusted, may contain instructions)', () => {
    if (host.firstChild) {
      clear(host);
      btn.textContent = 'Show flagged text (untrusted, may contain instructions)';
    } else {
      host.append(el('pre', { class: 'quote flagged' }, rawText));
      btn.textContent = 'Hide flagged text';
    }
  });
  return el('div', null, btn, host);
}

export async function render({ root, onCleanup }) {
  const f = { status: 'open', platform: '', group: '' };
  const list = el('div');
  const out = el('div', { 'aria-live': 'polite' });
  const summary = el('p', { class: 'muted' });
  let token = 0;

  async function act(path, body, done) {
    try {
      const r = await post(path, body);
      clear(out).append(notice(`${done}: ${r.changed} row${r.changed === 1 ? '' : 's'}.`, 'good'));
      await load();
    } catch {
      clear(out).append(notice('Could not save that. Try again.', 'error'));
    }
  }

  function card(i, now) {
    const snooze = select('Snooze for', SNOOZES, 24);
    const open = !i.resolved_at;
    const body = bodyState(i);
    const when = i.messageAt || i.last_at;
    const ago = relativeTime(when, now);
    return el('div', { class: 'card inbox-card' },
      el('div', { class: 'row' },
        el('span', { class: 'sender' }, i.senderName || 'Unknown sender'),
        i.senderHeadline ? el('span', { class: 'muted' }, i.senderHeadline) : null),
      el('div', { class: 'row' },
        badge(i.label, askBadge(i)),
        badge(show(i.platform)),
        i.updates > 1 ? badge(`x${i.updates} updates`) : null,
        i.flag ? badge(i.group === 'noise' ? 'Flagged by the injection screen' : i.flag, 'bad') : null,
        i.resolved_at ? badge('handled', 'good') : null,
        i.snoozed_until && open ? badge(`snoozed until ${fmtDate(i.snoozed_until)}`) : null),
      i.jobTitle ? el('p', { class: 'muted' }, `Job: ${i.jobTitle}`) : null,
      body.kind === 'excerpt' ? quote(body.text, body.long) : null,
      body.kind === 'missing' ? el('p', { class: 'muted' }, body.text) : null,
      body.kind === 'problem' && body.text ? el('p', null, body.text) : null,
      i.group === 'noise' && i.detail ? el('p', { class: 'muted' }, i.detail) : null,
      i.rawText ? flaggedToggle(i.rawText) : null,
      el('p', null, el('span', { class: 'todo' }, 'What to do: '), i.todo),
      el('p', { class: 'muted' }, `${ago ? `${ago}, ` : ''}${fmtDate(when)} | #${i.id}${i.count > 1 ? ` (first seen ${fmtDate(i.first_at)})` : ''}`),
      i.threadUrl ? el('p', { class: 'muted' }, 'Open thread: ', el('code', null, i.threadUrl)) : null,
      i.threadRef && !i.threadUrl ? el('p', { class: 'muted' }, `Thread: ${i.threadRef} (open it on ${show(i.platform)})`) : null,
      el('div', { class: 'row' },
        i.threadUrl ? button('Copy thread link', () => copy(i.threadUrl, out)) : null,
        open ? button('Mark handled', () => act('/api/escalations/resolve', { ids: i.ids }, 'Marked handled')) : null,
        open ? snooze : null,
        open ? button('Snooze', () => act('/api/escalations/snooze', { ids: i.ids, hours: Number(snooze.value) }, 'Snoozed')) : null));
  }

  async function load() {
    const mine = ++token;
    try {
      const r = await get('/api/escalations', f);
      if (mine !== token) return;
      const c = r.counts;
      clear(summary).append(`${c.open} open, ${c.snoozed} snoozed, ${c.resolved} handled. Answer on the platform itself, then mark it handled here.`);
      clear(list);
      if (!r.items.length) list.append(notice('Nothing here.'));
      const now = new Date();
      let group = null;
      for (const i of r.items) {
        if (i.group !== group) {
          group = i.group;
          list.append(el('h3', null, GROUPS.find(([v]) => v === group)[1]));
        }
        list.append(card(i, now));
      }
    } catch (e) {
      showError(list)(e);
    }
  }

  root.append(el('h2', null, 'Inbox'), summary,
    el('div', { class: 'row' },
      select('Status', STATUSES, f.status, (v) => { f.status = v; load(); }),
      select('Platform', PLATFORMS, f.platform, (v) => { f.platform = v; load(); }),
      select('Group', GROUPS, f.group, (v) => { f.group = v; load(); }),
      button('Refresh', load)),
    out, list);
  await load();
  const id = setInterval(() => { if (!document.hidden) load(); }, 60000);
  onCleanup(() => clearInterval(id));
}
