// src/web/static/views/inbox.js
// Inbox: the open escalations that need the owner.
// GET /api/escalations?status&platform&group -> {items, counts: {open, snoozed, resolved}}
//   item {id, ids, count, platform, reason, detail, group, flag, created_at, first_at, threadRef, threadUrl, personName, personCompany, jobTitle, snoozed_until, resolved_at}
// POST /api/escalations/resolve {ids}; POST /api/escalations/snooze {ids, hours}.
// Every field is untrusted model or third-party text and is set with textContent only. A thread link is shown as text with a Copy button,
// never as an anchor, so nothing is followed from here. The owner answers on the platform itself; this page only lists and marks handled.
import { get, post } from '../api.js';
import { badge, button, clear, el, fmtDate, notice, show, showError } from '../dom.js';

const GROUPS = [['', 'All groups'], ['human', 'Replies and needs you'], ['platform', 'Platform and tool problems'], ['noise', 'Flagged']];
const STATUSES = [['open', 'Open'], ['snoozed', 'Snoozed'], ['resolved', 'Handled'], ['all', 'All']];
const PLATFORMS = [['', 'All platforms'], ['linkedin', 'LinkedIn'], ['naukri', 'Naukri'], ['wellfound', 'Wellfound'], ['apply', 'Apply'], ['scheduler', 'Scheduler']];
const SNOOZES = [[1, '1 hour'], [4, '4 hours'], [24, '1 day'], [72, '3 days'], [168, '1 week']];
const GROUP_BADGE = { human: 'good', platform: 'warn', noise: 'bad' };

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

  function card(i) {
    const snooze = select('Snooze for', SNOOZES, 24);
    const who = i.personName ? `${i.personName}${i.personCompany ? ` (${i.personCompany})` : ''}` : null;
    const open = !i.resolved_at;
    return el('div', { class: 'card' },
      el('div', { class: 'row' },
        badge(i.group === 'human' ? 'needs you' : i.group === 'platform' ? 'problem' : 'flagged', GROUP_BADGE[i.group]),
        badge(show(i.platform)),
        el('strong', null, i.reason),
        i.count > 1 ? badge(`x${i.count}`) : null,
        i.flag ? badge(i.flag, 'bad') : null,
        i.resolved_at ? badge('handled', 'good') : null,
        i.snoozed_until && open ? badge(`snoozed until ${fmtDate(i.snoozed_until)}`) : null),
      who ? el('p', null, who) : null,
      i.jobTitle ? el('p', { class: 'muted' }, `Job: ${i.jobTitle}`) : null,
      i.detail ? el('p', null, i.detail) : null,
      el('p', { class: 'muted' }, `#${i.id} ${fmtDate(i.created_at)}${i.count > 1 ? ` (first ${fmtDate(i.first_at)})` : ''}`),
      i.threadRef ? el('p', { class: 'muted' }, `Thread: ${i.threadRef}`) : null,
      i.threadUrl ? el('p', null, el('code', null, i.threadUrl)) : null,
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
      let group = null;
      for (const i of r.items) {
        if (i.group !== group) {
          group = i.group;
          list.append(el('h3', null, GROUPS.find(([v]) => v === group)[1]));
        }
        list.append(card(i));
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
