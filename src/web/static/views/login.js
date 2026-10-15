// src/web/static/views/login.js
// Token mode: paste form or #token=... fragment (removed from the address bar before any network call).
// Google modes: a plain same-origin GET form, so no script builds a navigation.
// The token lives only in the input and one local variable; it is never stored, echoed or logged.
import { clear, el, form } from '../dom.js';
import { getAuthMode, postToken } from '../api.js';

const FAILED = 'That token was not accepted.';

function googleForm() {
  return form('/auth/login', 'get', null, el('button', { type: 'submit' }, 'Sign in with Google'));
}

// Reads a #token= fragment and removes it from the address bar and history entry before anything else runs.
function takeFragment() {
  if (!location.hash.startsWith('#token=')) return '';
  const raw = location.hash.slice('#token='.length);
  history.replaceState(null, '', location.pathname + location.search);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function render({ root, mode, reauth, returnTo }) {
  const fragment = takeFragment();
  const denied = mode === 'denied';
  const host = el('div');
  const status = el('p', { class: 'notice error', 'aria-live': 'assertive' });
  status.hidden = true;
  root.append(el('main', { class: 'login' },
    el('h1', null, 'Jobber'),
    denied
      ? el('p', { class: 'notice error', 'aria-live': 'assertive' }, 'Sign-in was not completed. Try again with the account you set up for this dashboard.')
      : el('p', null, reauth ? 'Confirm it is you to continue.' : 'Sign in to view the dashboard.'),
    status,
    host,
  ));

  function fail(msg) {
    status.textContent = msg;
    status.hidden = false;
  }

  async function submit(value, input) {
    status.hidden = true;
    if (input) input.value = '';
    try {
      const body = await postToken(value, reauth);
      if (body && body.ok === true) {
        location.hash = reauth && returnTo ? returnTo : '#/';
        return;
      }
      fail(FAILED);
    } catch (e) {
      if (e && e.status === 429) {
        const n = Number.parseInt(e.retryAfter, 10);
        fail(Number.isFinite(n) && n > 0 ? `Too many attempts, wait ${n} seconds` : 'Too many attempts, wait a moment');
      } else {
        fail(FAILED);
      }
    }
  }

  function tokenForm() {
    const input = el('input', { type: 'password', 'aria-label': 'Access token', placeholder: 'Access token' });
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    const f = el('form', null, input, el('button', { type: 'submit' }, 'Sign in'));
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const v = input.value;
      if (v) submit(v, input);
    });
    return f;
  }

  (async () => {
    let authMode = 'oidc';
    try {
      authMode = (await getAuthMode()).mode;
    } catch {
      // fall through to the Google form
    }
    clear(host);
    if (authMode !== 'token') {
      host.append(googleForm());
      return;
    }
    host.append(tokenForm());
  })();

  if (fragment) submit(fragment, null);
}
