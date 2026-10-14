// src/web/static/views/chat.js
// Two-step confirmed send. POST /api/send/prepare {text} -> {token, preview, expiresInSec};
// POST /api/send/confirm {text, token} -> {ok:true}. Errors: 400 invalid text {reason}, 401 reauth_required {url},
// 409 {error: mismatch|used|...}, 429 too many sends, 502 send failed. After 409, 429 or 502 the owner prepares again.
import { post } from '../api.js';
import { button, clear, el, form, notice, pre } from '../dom.js';

export async function render({ root, session }) {
  root.append(el('h2', null, 'Chat'));
  if (!session.chatEnabled) {
    root.append(notice('Chat sending is turned off for this dashboard.'));
    return;
  }
  const input = el('textarea', { placeholder: 'Message to send to the agent session', 'aria-label': 'Message text' });
  input.rows = 4;
  const out = el('div', { 'aria-live': 'polite' });
  let busy = false;

  const say = (text, kind) => clear(out).append(notice(text, kind));

  function reauth() {
    clear(out).append(
      notice('Please confirm it is you before sending.', 'warn'),
      form('/auth/login', 'get', { reauth: '1' }, el('button', { type: 'submit' }, 'Confirm it is you')),
    );
  }

  function failure(e) {
    if (e.status === 401 && e.code === 'reauth_required') return reauth();
    if (e.status === 400) return say('That text cannot be sent. Check it and try again.', 'error');
    if (e.status === 429) return say('Sending too fast. Wait a moment, then prepare again.', 'error');
    if (e.status === 409) return say('The preview is no longer valid. Prepare the message again.', 'error');
    if (e.status === 502) return say('The send failed. Prepare the message again to retry.', 'error');
    return say('Something went wrong. Prepare the message again.', 'error');
  }

  async function preview() {
    if (busy) return;
    const text = input.value;
    busy = true;
    try {
      const p = await post('/api/send/prepare', { text });
      const confirm = button('Confirm send', async () => {
        if (busy) return;
        busy = true;
        try {
          await post('/api/send/confirm', { text, token: p.token });
          input.value = '';
          say('Sent.', 'good');
        } catch (e) {
          failure(e);
        } finally {
          busy = false;
        }
      }, { class: 'primary' });
      const cancel = button('Cancel', () => clear(out));
      clear(out).append(
        el('h3', null, 'Exactly this will be sent'), pre(p.preview),
        el('p', { class: 'muted' }, `Valid for about ${p.expiresInSec} seconds.`),
        el('div', { class: 'row' }, confirm, cancel));
    } catch (e) {
      failure(e);
    } finally {
      busy = false;
    }
  }

  root.append(input, el('div', { class: 'row' }, button('Preview', preview, { class: 'primary' })), out);
}
