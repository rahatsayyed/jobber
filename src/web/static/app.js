// src/web/static/app.js
// Hash router, top nav and view lifecycle. Views export render(ctx); ctx.onCleanup(fn) registers a teardown
// (polling timers) that runs before the next view renders.
import { get, getSettingsMeta, post, session } from './api.js';
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
import * as apply from './views/apply.js';
import * as inbox from './views/inbox.js';
import * as settings from './views/settings.js';

const VIEWS = [
  ['overview', 'Overview', overview], ['inbox', 'Inbox', inbox], ['jobs', 'Jobs', jobs], ['people', 'People', people], ['mail', 'Mail', mail],
  ['outcomes', 'Outcomes', outcomes], ['sessions', 'Sessions', sessions], ['runs', 'Runs', runs],
  ['config', 'Config', config], ['settings', 'Settings', settings], ['audit', 'Audit', audit], ['chat', 'Chat', chat],
  ['apply', 'Apply', apply],
];

const root = document.getElementById('app');
const banner = document.getElementById('banner'); // lives outside #app, so a view render never removes it
let bannerTimer = null;
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

let lastAppHash = '#/'; // where a reauth should return to

function parseHash() {
  if (location.hash.startsWith('#token=')) return { name: 'login', arg: null, reauth: false };
  const [path, query] = location.hash.split('?');
  const parts = path.replace(/^#\/?/, '').split('/').filter(Boolean);
  const reauth = new URLSearchParams(query || '').get('reauth') === '1';
  return { name: parts[0] || '', arg: parts[1] || null, reauth };
}

function stopBanner() {
  if (bannerTimer !== null) clearInterval(bannerTimer);
  bannerTimer = null;
  banner.hidden = true;
  clear(banner);
}

function paintBanner(mode, meta) {
  const m = mode && mode.mode === 'LIVE' ? 'LIVE' : mode && mode.mode === 'DRY RUN' ? 'DRY RUN' : null;
  const kind = m === 'LIVE' ? 'banner-live' : m === 'DRY RUN' ? 'banner-dry' : 'banner-unknown';
  const icon = m === 'LIVE' ? '⚠' : m === 'DRY RUN' ? '◌' : '?';
  banner.className = kind;
  clear(banner).append(el('span', { class: 'banner-mode' }, `${icon} ${m || 'MODE UNKNOWN'}`));
  const restarts = meta && Array.isArray(meta.pendingRestart) ? meta.pendingRestart.length : 0;
  if (restarts > 0) banner.append(el('span', { class: 'banner-note' }, `${restarts} ${restarts === 1 ? 'change needs' : 'changes need'} a restart`));
  if (meta && meta.modeChangedSinceStart === true) banner.append(el('span', { class: 'banner-note' }, 'changed since the dashboard started'));
  banner.hidden = false;
  document.documentElement.style.setProperty('--banner-h', `${banner.offsetHeight}px`);
}

async function refreshBanner(fresh) {
  if (!current) return;
  try {
    if (fresh) current = await session();
    let meta = null;
    try {
      meta = await getSettingsMeta();
    } catch {
      meta = null; // settings off or unavailable: the mode still shows
    }
    if (current) paintBanner(current.mode, meta);
  } catch {
    // a 401 already moved the hash to the login view, which hides the banner
  }
}

async function signOut() {
  stopBanner();
  try {
    await post('/api/logout', {});
  } catch {
    // an expired session is already signed out
  }
  current = null;
  location.hash = '#/login';
}

let inboxOpen = 0; // open escalations, shown as a count on the Inbox tab

async function refreshInboxCount() {
  try {
    inboxOpen = (await get('/api/escalations/count')).open || 0;
  } catch {
    inboxOpen = 0; // the tab still works without the badge
  }
}

function nav(active) {
  const items = VIEWS.filter(([n]) => (n !== 'chat' || (current && current.chatEnabled)));
  return el('nav', { 'aria-label': 'Sections' },
    items.map(([n, label]) => button(n === 'inbox' && inboxOpen > 0 ? `${label} (${inboxOpen})` : label, () => { location.hash = `#/${n}`; }, {
      class: n === active ? 'tab active' : 'tab', 'aria-current': n === active ? 'page' : null,
    })),
    button('Sign out', signOut, { class: 'tab' }));
}

async function route() {
  const token = ++renderToken;
  cleanups.forEach((f) => f());
  cleanups = [];
  const { name, arg, reauth } = parseHash();
  clear(root);
  if (name === 'denied' || name === 'login') {
    stopBanner();
    login.render({
      root, mode: name, reauth, returnTo: lastAppHash, onCleanup: (f) => cleanups.push(f),
    });
    return;
  }
  lastAppHash = location.hash || '#/';
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
  refreshBanner(false);
  if (bannerTimer === null) bannerTimer = setInterval(() => { if (!document.hidden) refreshBanner(true); }, 60000);
  await refreshInboxCount();
  if (token !== renderToken) return;
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
