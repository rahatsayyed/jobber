// src/web/static/views/login.js
// Sign-in is a plain same-origin GET form, so no script builds a navigation. The denied view is deliberately generic.
import { el, form } from '../dom.js';

export function render({ root, mode }) {
  const denied = mode === 'denied';
  root.append(el('main', { class: 'login' },
    el('h1', null, 'Jobber'),
    denied
      ? el('p', { class: 'notice error', 'aria-live': 'assertive' }, 'Sign-in was not completed. Try again with the account you set up for this dashboard.')
      : el('p', null, 'Sign in to view the dashboard.'),
    form('/auth/login', 'get', null, el('button', { type: 'submit' }, 'Sign in')),
  ));
}
