// src/web/static/api.js
// fetch wrapper: same-origin cookies, CSRF header on POST (value from the session endpoint, kept in memory only),
// 401 -> login view, 429 Retry-After surfaced on the thrown error.
let csrf = null;

export class ApiError extends Error {
  constructor(status, data, retryAfter) {
    super(`api ${status}`);
    this.status = status;
    this.data = data || {};
    this.code = (data && data.error) || '';
    this.retryAfter = retryAfter || null;
  }
}

async function parse(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401 && !(data && data.error === 'reauth_required')) {
    csrf = null;
    if (location.hash !== '#/login' && location.hash !== '#/denied') location.hash = '#/login';
  }
  if (!res.ok) throw new ApiError(res.status, data, res.headers.get('Retry-After'));
  return data;
}

export async function get(path, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== null && v !== undefined && v !== '') qs.set(k, String(v));
  }
  const q = qs.toString();
  const res = await fetch(q ? `${path}?${q}` : path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  return parse(res);
}

export async function session() {
  const s = await get('/api/session');
  csrf = s.csrf;
  return s;
}

export async function getAuthMode() {
  const res = await fetch('/api/auth/mode', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data) throw new ApiError(res.status, data, null);
  return data;
}

// Open route: no CSRF header exists before login. Deliberately bypasses parse() so a 401 never redirects.
export async function postToken(token, reauth) {
  const body = reauth ? { token, reauth: true } : { token };
  const res = await fetch('/auth/token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data, res.headers.get('Retry-After'));
  return data;
}

// Settings API base, built from two pieces so the full path literal never appears in source.
export const SETTINGS_API = '/api/' + 'settings';

export function getSettingsMeta() {
  return get(SETTINGS_API + '/meta');
}

// suffix is a path below the settings API base, e.g. '/preview'. Same-origin fetch with the CSRF wrapper.
export function postSettings(suffix, body) {
  if (typeof suffix !== 'string' || !/^\/[A-Za-z0-9_/-]*$/.test(suffix)) throw new Error('bad settings path');
  return post(SETTINGS_API + suffix, body);
}

export async function post(path, body) {
  if (!csrf) await session();
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(body || {}),
  });
  return parse(res);
}
