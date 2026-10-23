// src/web/static/views/apply.js
// /apply request box. POST /api/apply/prepare {url, force} -> {token, url, force, classification, lines, stopped};
// POST /api/apply/confirm {url, force, token} -> {ok, id, duplicate, stopped}. GET /api/apply/requests -> last 20 with stored report text.
// All text is shown with textContent (the dom helpers never parse markup); the report is posting-derived and untrusted.
import { get, post } from '../api.js';
import { button, clear, el, notice, pre } from '../dom.js';

const STOP_NOTE = 'The scheduler will not run while it is stopped or halted. The request stays queued until it is resumed.';

export async function render({ root, session }) {
  root.append(el('h2', null, 'Apply request'));
  root.append(el('p', { class: 'muted' }, 'Paste a job page or a company careers page. It is queued for the next scheduler wake at priority; nothing is fetched or sent from here.'));
  const input = el('input', { type: 'text', placeholder: 'https://boards.greenhouse.io/company/jobs/123', 'aria-label': 'Job or careers page URL' });
  const forceBox = el('input', { type: 'checkbox', id: 'apply-force' });
  const out = el('div', { 'aria-live': 'polite' });
  const list = el('div');
  let busy = false;

  const say = (text, kind) => clear(out).append(notice(text, kind));

  function failure(e) {
    if (e.status === 401 && e.code === 'reauth_required') {
      const u = e.data && e.data.url;
      const ok = typeof u === 'string' && u.startsWith('/') && !u.startsWith('/' + '/') && u.length < 100;
      return clear(out).append(notice('Please confirm it is you first.', 'warn'), button('Confirm it is you', () => location.assign(ok ? u : '/#/login?reauth=1')));
    }
    if (e.status === 400 && e.data && e.data.reason) return say(`That URL cannot be used: ${e.data.reason}`, 'error');
    if (e.status === 429) return say('Too many requests this hour. Try again later.', 'error');
    if (e.status === 409) return say('The preview is no longer valid. Preview the request again.', 'error');
    return say('Something went wrong. Preview the request again.', 'error');
  }

  async function loadList() {
    try {
      const d = await get('/api/apply/requests');
      clear(list).append(el('h3', null, 'Last requests'));
      if (d.stopped) list.append(notice(STOP_NOTE, 'warn'));
      if (!d.items.length) list.append(el('p', { class: 'muted' }, 'No requests yet.'));
      for (const r of d.items) {
        list.append(el('div', { class: 'card' },
          el('strong', null, `#${r.id} ${r.status}`), ` ${r.kind}${r.force ? ', force' : ''} ${r.created_at}`,
          el('div', null, r.url),
          r.report ? pre(r.report) : null));
      }
    } catch {
      clear(list).append(notice('Could not load the request list.', 'error'));
    }
  }

  async function preview() {
    if (busy) return;
    busy = true;
    const url = input.value;
    const force = forceBox.checked;
    try {
      const p = await post('/api/apply/prepare', { url, force });
      const confirm = button('Confirm and queue', async () => {
        if (busy) return;
        busy = true;
        try {
          const r = await post('/api/apply/confirm', { url: p.url, force: p.force, token: p.token });
          input.value = '';
          clear(out).append(notice(`${r.duplicate ? 'Already queued' : 'Queued'}: request #${r.id}.`, 'good'));
          if (r.stopped) out.append(notice(STOP_NOTE, 'warn'));
          await loadList();
        } catch (e) {
          failure(e);
        } finally {
          busy = false;
        }
      }, { class: 'primary' });
      clear(out).append(
        el('h3', null, 'Queue exactly this?'), pre(p.lines.join('\n')),
        p.stopped ? notice(STOP_NOTE, 'warn') : null,
        el('p', { class: 'muted' }, `Valid for about ${p.expiresInSec} seconds.`),
        el('div', { class: 'row' }, confirm, button('Cancel', () => clear(out))));
    } catch (e) {
      failure(e);
    } finally {
      busy = false;
    }
  }

  root.append(input,
    el('div', { class: 'row' }, forceBox, el('label', { for: 'apply-force' }, 'Force (prepare it even if the score is below the threshold)')),
    el('div', { class: 'row' }, button('Preview', preview, { class: 'primary' })), out, list);
  await loadList();
}
