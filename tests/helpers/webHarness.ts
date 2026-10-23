// tests/helpers/webHarness.ts
// Shared harness for the dashboard server tests: ephemeral port, injected clock, temp auth store, in-memory data
// db, fake tmux runner and the in-process fake OIDC provider. No network, no real tmux.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../../src/db.js';
import { migrateOutreachTables } from '../../src/outreach/schema.js';
import { loadOutreachConfig } from '../../src/outreach/config.js';
import { openAuthStore, type AuthDb } from '../../src/dash/authStore.js';
import { allowAccount } from '../../src/dash/account.js';
import { createOidc } from '../../src/dash/oidc.js';
import { createWebServer, type WebDeps } from '../../src/web/server.js';
import type { Run } from '../../src/platform/tmux.js';
import { createFakeOidc, type FakeOidc } from './fakeOidc.js';

export interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }
export interface CallOpts { headers?: Record<string, string>; body?: string | Buffer }

export const START = Date.parse('2026-10-14T12:00:00.000Z');

export interface Harness {
  server: http.Server;
  port: number;
  auth: AuthDb;
  data: BetterSqlite3.Database;
  fake: FakeOidc;
  clock: { t: number };
  now: () => Date;
  call: (method: string, path: string, opts?: CallOpts) => Promise<Res>;
  /** run login through the fake provider; returns the callback response and the cookie header for the session */
  login: (claims?: Record<string, unknown>, cookieOver?: { secure?: boolean }) => Promise<{ cb: Res; cookie: string; state: string }>;
  start: (headers?: Record<string, string>) => Promise<{ loginRes: Res; state: string; nonce: string; oidcCookie: string }>;
  close: () => Promise<void>;
  paneText: { value: string };
}

export function setCookies(r: Res): string[] {
  const v = r.headers['set-cookie'];
  return Array.isArray(v) ? v : v ? [v] : [];
}

export function cookiePair(r: Res, name: string): string | null {
  for (const c of setCookies(r)) {
    if (c.startsWith(name + '=')) return c.split(';')[0];
  }
  return null;
}

export async function makeHarness(over: Partial<WebDeps> = {}, opts: { allow?: boolean } = {}): Promise<Harness> {
  const clock = { t: START };
  const now = (): Date => new Date(clock.t);
  const fake = await createFakeOidc({ now });
  const auth = openAuthStore(join(mkdtempSync(join(tmpdir(), 'web-auth-')), 'auth.sqlite'));
  if (opts.allow !== false) allowAccount(auth, 'owner@example.test', now());
  const data = openDb(':memory:');
  migrateOutreachTables(data);
  const paneText = { value: 'pane line one' };
  const run: Run = async (_cmd, args) => {
    if (args[0] === 'list-windows') return { stdout: '0|JobApplier|1|claude\n', code: 0 };
    if (args[0] === 'capture-pane') return { stdout: paneText.value, code: 0 };
    if (args[0] === 'has-session') return { stdout: '', code: 0 };
    return { stdout: '', code: 1 };
  };
  const redirectUri = 'http://127.0.0.1:8787/auth/callback';
  const oidc = createOidc(
    { issuer: fake.issuer, clientId: fake.clientId, clientSecret: 'client-secret-xyz', redirectUri, reauthPrompt: 'select_account', maxAgeSec: 300 },
    { fetch: fake.fetch, now, random: (n) => randomBytes(n) },
  );
  const deps: WebDeps = {
    port: 0,
    bind: '127.0.0.1',
    allowRemoteBind: false,
    allowedHosts: [],
    trustProxy: false,
    auth,
    oidc,
    oidcCfg: { redirectUri, reauthMaxAgeSec: 300 },
    data,
    cfg: loadOutreachConfig({} as NodeJS.ProcessEnv),
    run,
    sessionsToShow: ['ccgram'],
    chat: { enabled: false, session: 'ccgram', window: 'JobApplier', send: async () => {} },
    now,
    ...over,
  };
  const server = createWebServer(deps);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;

  function call(method: string, path: string, o: CallOpts = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...o.headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      r.on('error', reject);
      if (o.body !== undefined) r.write(o.body);
      r.end();
    });
  }

  async function start(headers: Record<string, string> = {}) {
    const loginRes = await call('GET', '/auth/login', { headers });
    const loc = new URL(String(loginRes.headers.location));
    const state = loc.searchParams.get('state') ?? '';
    const nonce = loc.searchParams.get('nonce') ?? '';
    const pair = setCookies(loginRes).map((c) => c.split(';')[0]).find((c) => /jobber_oidc=/.test(c)) ?? '';
    return { loginRes, state, nonce, oidcCookie: pair };
  }

  async function login(claims: Record<string, unknown> = {}, cookieOver: { secure?: boolean } = {}) {
    const hdr: Record<string, string> = cookieOver.secure ? { 'x-forwarded-proto': 'https' } : {};
    const s = await start(hdr);
    const nowSec = Math.floor(clock.t / 1000);
    fake.setIdToken(await fake.mint({ nonce: s.nonce, iat: nowSec, exp: nowSec + 300, ...claims }));
    const cb = await call('GET', `/auth/callback?code=c1&state=${encodeURIComponent(s.state)}`, {
      headers: { ...hdr, cookie: s.oidcCookie },
    });
    const sess = setCookies(cb).map((c) => c.split(';')[0]).find((c) => /jobber_session=/.test(c)) ?? '';
    return { cb, cookie: sess, state: s.state };
  }

  return {
    server, port, auth, data, fake, clock, now, call, login, start, paneText,
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

export function insertJob(db: BetterSqlite3.Database, id: string, title: string, company = 'Acme', score: number | null = 80): void {
  db.prepare('INSERT OR IGNORE INTO jobs (id, source, title, company) VALUES (?,?,?,?)').run(id, 'remotive', title, company);
  if (score !== null) db.prepare('UPDATE jobs SET score = ? WHERE id = ?').run(score, id);
}
