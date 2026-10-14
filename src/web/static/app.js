// src/web/static/app.js
// Hash router, top nav and view lifecycle. Views export render(ctx); ctx.onCleanup(fn) registers a teardown
// (polling timers) that runs before the next view renders.
import { post, session } from './api.js';
import { button, clear, el, showError } from './dom.js';
import * as login from './views/login.js';
import * as overview from './views/overview.js';
import * as jobs from './views/jobs.js';
import * as people from './views/people.js';
import * as mail from './views/mail.js';
import * as outcomes from './views/outcomes.js';
import * as sessions from './views/sessions.js';
import * as runs from './views/runs.js';
import * as config from './views/config.js';
import * as audit from './views/audit.js';
import * as chat from './views/chat.js';

const VIEWS = [
  ['overview', 'Overview', overview], ['jobs', 'Jobs', jobs], ['people', 'People', people], ['mail', 'Mail', mail],
  ['outcomes', 'Outcomes', outcomes], ['sessions', 'Sessions', sessions], ['runs', 'Runs', runs],
  ['config', 'Config', config], ['audit', 'Audit', audit], ['chat', 'Chat', chat],
];

const root = document.getElementById('app');
let cleanups = [];
let current = null; // session info once signed in
let renderToken = 0;

function lastTab() {
  try {
    return localStorage.getItem('lastTab') || 'overview';
  } catch {
    return 'overview';
  }
}
function rememberTab(name) {
  try {
    localStorage.setItem('lastTab', name);
  } catch {
    // storage unavailable: nothing to remember
  }
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: parts[0] || '', arg: parts[1] || null };
}

async function signOut() {
  try {
    await post('/api/logout', {});
  } catch {
    // an expired session is already signed out
  }
  current = null;
  location.hash = '#/login';
}

function nav(active) {
  const items = VIEWS.filter(([n]) => n !== 'chat' || (current && current.chatEnabled));
  return el('nav', { 'aria-label': 'Sections' },
    items.map(([n, label]) => button(label, () => { location.hash = `#/${n}`; }, {
      class: n === active ? 'tab active' : 'tab', 'aria-current': n === active ? 'page' : null,
    })),
    button('Sign out', signOut, { class: 'tab' }));
}

async function route() {
  const token = ++renderToken;
  cleanups.forEach((f) => f());
  cleanups = [];
  const { name, arg } = parseHash();
  clear(root);
  if (name === 'denied' || name === 'login') {
    login.render({ root, mode: name, onCleanup: (f) => cleanups.push(f) });
    return;
  }
  if (!current) {
    try {
      current = await session();
    } catch {
      return; // a 401 already moved the hash to the login view
    }
  }
  if (token !== renderToken) return;
  const entry = VIEWS.find(([n]) => n === name);
  if (!entry) {
    location.hash = `#/${lastTab()}`;
    return;
  }
  rememberTab(name);
  const main = el('main', { id: 'main', 'aria-live': 'polite' });
  root.append(el('header', null, el('h1', null, 'Jobber'), nav(name)), main);
  try {
    await entry[2].render({
      root: main, arg, session: current, onCleanup: (f) => cleanups.push(f),
    });
  } catch (e) {
    if (token === renderToken) showError(main)(e);
  }
}

window.addEventListener('hashchange', route);
route();
