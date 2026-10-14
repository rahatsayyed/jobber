// src/web/server.ts
// Dashboard HTTP server: Host check, strict headers, OIDC login, server-side sessions, CSRF and a read-only API.
// Nothing here logs cookies, tokens, codes, state or bodies; a handler failure logs the route template and error name.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import type { OutreachConfig } from '../outreach/config.js';
import type { Run } from '../platform/tmux.js';
import { assertName, capture, listWindows } from '../platform/tmux.js';
import { redactSecrets } from '../safety/redact.js';
import { buildSnapshot } from '../status/snapshot.js';
import { audit, listAudit, savePendingLogin, takePendingLogin, type AuthDb } from '../dash/authStore.js';
import { OidcError, type createOidc } from '../dash/oidc.js';
import { evaluateLogin, normaliseEmail } from '../dash/account.js';
import { checkLogin, recordLogin } from '../dash/throttle.js';
import {
  createSession, csrfOk, isFresh, refreshAuth, revokeSession, validateSession,
} from '../dash/sessions.js';
import {
  clearCookie, oidcCookieName, parseCookies, serializeOidc, serializeSession, sessionCookieName,
} from '../dash/cookies.js';
import { clampLimit, MAX_Q, parseCursor } from '../dash/readDb.js';
import { cleanText } from '../dash/clean.js';
import { JOB_BUCKETS, jobCounts, jobDetail, listJobs, type JobBucket } from '../dash/queries/jobs.js';
import { listPeople, personThread } from '../dash/queries/people.js';
import { emailDetail, listFollowups, listReplies, listSentEmails } from '../dash/queries/mail.js';
import { funnelView, listOutcomes } from '../dash/queries/outcomes.js';
import { readRunLog } from '../dash/runlog.js';
import { sessionsPanel } from '../dash/sessionsPanel.js';
import { buildConfigView } from '../dash/configView.js';
import { loadStatic } from './page.js';
import { applySecurityHeaders, HttpError, json, securityHeaders, type Ctx } from './router.js';

export interface WebDeps {
  port: number;
  bind: string; // default '127.0.0.1'; non-loopback only when allowRemoteBind
  allowRemoteBind: boolean;
  allowedHosts: string[]; // extra Host values (tunnel hostnames); loopback with port is always allowed
  trustProxy: boolean; // WEB_TRUST_PROXY
  auth: AuthDb;
  oidc: ReturnType<typeof createOidc>;
  oidcCfg: { redirectUri: string; reauthMaxAgeSec: number };
  data: BetterSqlite3.Database; // read-only
  cfg: OutreachConfig;
  run: Run;
  sessionsToShow: string[];
  chat: { enabled: boolean; session: string; window: string; send: (text: string) => Promise<void> };
  now?: () => Date;
  // optional wiring
  secrets?: string[]; // literal secret values masked in pane output, status and config (include the OIDC client secret)
  threshold?: number; // MATCH_THRESHOLD, default 60
  env?: NodeJS.ProcessEnv; // for the masked config view, default process.env
  root?: string; // project root for the config view, default cwd
  staticDir?: string; // default: ./static next to this file
}

// Kept here until Task 10 moves it to src/web/chat.ts.
export const STATUS_COMMANDS = ['limits', 'working', 'health'] as const;

export { redactSecrets };

const SESSION_MAX_AGE_SEC = 12 * 60 * 60;
const PENDING_TTL_MS = 10 * 60_000;
const RATE_PER_MIN = 120;
const PANE_LINES = 40;
const LOCKOUT_AUDIT_GAP_MS = 60_000;
const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);
const JOB_ID_RE = /^[A-Za-z0-9:_.-]{1,128}$/;
const NUM_ID_RE = /^\d{1,12}$/;
const STAGE_RE = /^[A-Za-z0-9_ -]{1,32}$/;

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const hint = (s: string): string => sha256Hex(s).slice(0, 12);

function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

type RouteFn = (c: Ctx, params: string[]) => Promise<void> | void;
interface Route { method: string; re: RegExp; name: string; open: boolean; fn: RouteFn }

export function createWebServer(deps: WebDeps): http.Server {
  if (!LOOPBACK_BINDS.has(deps.bind) && !deps.allowRemoteBind) {
    throw new Error('refusing to bind a non-loopback address without allowRemoteBind');
  }
  const now = deps.now ?? ((): Date => new Date());
  const statics = loadStatic(deps.staticDir ?? fileURLToPath(new URL('./static', import.meta.url)));
  const threshold = deps.threshold ?? 60;
  const secrets = deps.secrets ?? [];
  const allowedHosts = new Set(deps.allowedHosts.map((h) => h.toLowerCase()));
  const hits = new Map<string, number[]>(); // session id hash -> request times (ms)
  const lockoutAudited = new Map<string, number>(); // scope -> last audit time (ms)
  let server: http.Server;

  const port = (): number => deps.port || (server.address() as AddressInfo | null)?.port || 0;
  const redact = (s: string): string => redactSecrets(s, secrets, { tokenLines: false });
  const q = (c: Ctx, k: string): string | undefined => c.url.searchParams.get(k) ?? undefined;
  const qText = (c: Ctx, k: string): string | undefined => {
    const v = q(c, k);
    return v === undefined ? undefined : v.slice(0, MAX_Q);
  };
  const denied = (res: http.ServerResponse, extra: Record<string, string | string[]> = {}): void => {
    res.writeHead(302, { Location: '/#/denied', 'Cache-Control': 'no-store', ...extra });
    res.end();
  };

  // ---- auth routes -------------------------------------------------------------------------------------------

  function lockoutResponse(c: Ctx, scope: string, retryAfterSec: number): void {
    const t = now();
    const last = lockoutAudited.get(scope) ?? -Infinity;
    if (t.getTime() - last >= LOCKOUT_AUDIT_GAP_MS) {
      lockoutAudited.set(scope, t.getTime());
      audit(deps.auth, 'lockout', { ip: c.ip, note: scope }, t);
    }
    json(c.res, 429, { error: 'too many attempts' }, { 'Retry-After': String(retryAfterSec) });
  }

  async function authLogin(c: Ctx): Promise<void> {
    const reauth = c.url.searchParams.get('reauth') === '1';
    if (reauth && !c.session) {
      json(c.res, 401, { error: 'unauthenticated' });
      return;
    }
    const t = now();
    const th = checkLogin(deps.auth, c.ip, t);
    if (!th.allowed) {
      lockoutResponse(c, th.scope ?? 'ip', th.retryAfterSec);
      return;
    }
    let req;
    try {
      req = await deps.oidc.buildAuthRequest({ reauth });
    } catch (e) {
      audit(deps.auth, 'login_error', { ip: c.ip, note: e instanceof OidcError ? e.code : 'provider' }, t);
      denied(c.res);
      return;
    }
    savePendingLogin(deps.auth, {
      stateHash: req.stateHash,
      nonce: req.nonce,
      verifier: req.verifier,
      reauth,
      sessionHash: reauth && c.session ? c.session.idHash : null,
      createdAt: t.toISOString(),
      expiresAt: new Date(t.getTime() + PENDING_TTL_MS).toISOString(),
    });
    c.res.writeHead(302, {
      Location: req.url,
      'Cache-Control': 'no-store',
      'Set-Cookie': serializeOidc(req.state, c.secure),
    });
    c.res.end();
  }

  async function authCallback(c: Ctx): Promise<void> {
    const t = now();
    const clearOidc = clearCookie(oidcCookieName(c.secure), c.secure);
    const th = checkLogin(deps.auth, c.ip, t);
    if (!th.allowed) {
      // a blocked request is never recorded: recording it would extend the lockout indefinitely
      lockoutResponse(c, th.scope ?? 'ip', th.retryAfterSec);
      return;
    }
    // From here the attempt is evaluated: every failure path records one failed attempt.
    const fail = (kind: 'login_denied' | 'login_error', reason: string, id?: string): void => {
      recordLogin(deps.auth, c.ip, false, t);
      audit(deps.auth, kind, { ip: c.ip, note: reason, ...(id ? { idHint: hint(id) } : {}) }, t);
      denied(c.res, { 'Set-Cookie': clearOidc });
    };

    const sp = c.url.searchParams;
    if (sp.has('error')) return fail('login_denied', 'provider_error');
    const code = sp.get('code');
    const state = sp.get('state');
    if (!code || code.length > 2048) return fail('login_denied', 'no_code');
    if (!state || state.length > 512) return fail('login_denied', 'no_state');
    const cookieState = parseCookies(c.req.headers.cookie)[oidcCookieName(c.secure)];
    if (!cookieState || !safeEqual(cookieState, state)) return fail('login_denied', 'state_cookie');
    const pending = takePendingLogin(deps.auth, sha256Hex(state), t);
    if (!pending) return fail('login_denied', 'state_unknown');

    let identity;
    try {
      const { idToken } = await deps.oidc.exchangeCode(code, pending.verifier);
      identity = await deps.oidc.verifyIdToken(idToken, {
        nonce: pending.nonce,
        ...(pending.reauth ? { notBefore: new Date(pending.createdAt) } : {}),
      });
    } catch (e) {
      if (e instanceof OidcError) {
        const exchange = e.code === 'exchange' || e.code === 'discovery';
        return fail(exchange ? 'login_error' : 'login_denied', e.code);
      }
      return fail('login_error', 'unexpected');
    }

    const who = normaliseEmail(identity.email) ?? identity.sub;
    const decision = evaluateLogin(
      deps.auth,
      { sub: identity.sub, email: identity.email, emailVerified: identity.emailVerified },
      t,
    );
    if (!decision.ok) return fail('login_denied', decision.reason, who);

    const authAt = new Date(identity.iat * 1000);
    if (pending.reauth) {
      if (!c.session || !pending.sessionHash || c.session.idHash !== pending.sessionHash) {
        return fail('login_denied', 'reauth_session', who);
      }
      recordLogin(deps.auth, c.ip, true, t);
      refreshAuth(deps.auth, c.session.idHash, authAt);
      audit(deps.auth, 'reauth_ok', { ip: c.ip, idHint: hint(who) }, t);
      c.res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store', 'Set-Cookie': clearOidc });
      c.res.end();
      return;
    }

    recordLogin(deps.auth, c.ip, true, t);
    if (decision.pinned) audit(deps.auth, 'sub_pinned', { ip: c.ip, idHint: hint(identity.sub) }, t);
    audit(deps.auth, 'login_ok', { ip: c.ip, idHint: hint(who) }, t);
    const old = parseCookies(c.req.headers.cookie)[sessionCookieName(c.secure)];
    if (old) revokeSession(deps.auth, old, t); // rotate: an existing session cookie never survives a login
    const { cookieValue } = createSession(deps.auth, c.ip, authAt, t);
    c.res.writeHead(302, {
      Location: '/',
      'Cache-Control': 'no-store',
      'Set-Cookie': [serializeSession(cookieValue, c.secure, SESSION_MAX_AGE_SEC), clearOidc],
    });
    c.res.end();
  }

  // ---- api routes --------------------------------------------------------------------------------------------

  const routes: Route[] = [];
  const add = (method: string, pattern: string, open: boolean, fn: RouteFn): void => {
    const re = new RegExp('^' + pattern.replace(/:[a-z]+/g, '([^/]+)') + '$');
    routes.push({ method, re, name: `${method} ${pattern}`, open, fn });
  };

  add('GET', '/api/health', true, (c) => json(c.res, 200, { ok: true }));
  add('GET', '/auth/login', true, authLogin);
  add('GET', '/auth/callback', true, authCallback);

  add('POST', '/api/logout', false, (c) => {
    const cookie = parseCookies(c.req.headers.cookie)[sessionCookieName(c.secure)];
    const t = now();
    if (cookie) revokeSession(deps.auth, cookie, t);
    audit(deps.auth, 'logout', { ip: c.ip }, t);
    json(c.res, 200, { ok: true }, { 'Set-Cookie': clearCookie(sessionCookieName(c.secure), c.secure) });
  });

  add('GET', '/api/session', false, (c) => {
    const s = c.session!;
    json(c.res, 200, {
      csrf: s.csrf,
      expiresAt: s.expiresAt,
      authAt: s.authAt,
      chatEnabled: deps.chat.enabled,
      reauthRequired: !isFresh(s, now(), deps.oidcCfg.reauthMaxAgeSec),
    });
  });

  add('GET', '/api/status', false, (c) => {
    const snap = buildSnapshot(deps.data, deps.cfg, now());
    c.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    c.res.end(redact(JSON.stringify(snap)));
  });

  add('GET', '/api/jobs/counts', false, (c) => json(c.res, 200, jobCounts(deps.data, threshold)));
  add('GET', '/api/jobs/:id', false, (c, [id]) => {
    if (!JOB_ID_RE.test(id)) return json(c.res, 400, { error: 'invalid id' });
    const d = jobDetail(deps.data, id, threshold);
    if (!d) return json(c.res, 404, { error: 'not found' });
    json(c.res, 200, d);
  });
  add('GET', '/api/jobs', false, (c) => {
    const bucket = q(c, 'bucket');
    if (bucket !== undefined && !(JOB_BUCKETS as readonly string[]).includes(bucket)) {
      return json(c.res, 400, { error: 'invalid bucket' });
    }
    json(c.res, 200, listJobs(deps.data, {
      bucket: bucket as JobBucket | undefined,
      q: qText(c, 'q'),
      cursor: parseCursor(q(c, 'cursor')),
      limit: clampLimit(q(c, 'limit')),
      threshold,
    }));
  });

  add('GET', '/api/people/:id/thread', false, (c, [id]) => {
    if (!NUM_ID_RE.test(id)) return json(c.res, 400, { error: 'invalid id' });
    const r = personThread(deps.data, Number(id), { cursor: parseCursor(q(c, 'cursor')), limit: clampLimit(q(c, 'limit')) });
    if (!r) return json(c.res, 404, { error: 'not found' });
    json(c.res, 200, r);
  });
  add('GET', '/api/people', false, (c) => {
    const stage = q(c, 'stage');
    if (stage !== undefined && !STAGE_RE.test(stage)) return json(c.res, 400, { error: 'invalid stage' });
    json(c.res, 200, listPeople(deps.data, {
      q: qText(c, 'q'), stage, cursor: parseCursor(q(c, 'cursor')), limit: clampLimit(q(c, 'limit')),
    }));
  });

  add('GET', '/api/emails/:id', false, (c, [id]) => {
    if (!NUM_ID_RE.test(id)) return json(c.res, 400, { error: 'invalid id' });
    const d = emailDetail(deps.data, Number(id));
    if (!d) return json(c.res, 404, { error: 'not found' });
    json(c.res, 200, d);
  });
  add('GET', '/api/emails', false, (c) => {
    json(c.res, 200, listSentEmails(deps.data, {
      q: qText(c, 'q'), cursor: parseCursor(q(c, 'cursor')), limit: clampLimit(q(c, 'limit')),
    }));
  });
  add('GET', '/api/followups', false, (c) => {
    const status = q(c, 'status');
    if (status !== undefined && !STAGE_RE.test(status)) return json(c.res, 400, { error: 'invalid status' });
    json(c.res, 200, listFollowups(deps.data, {
      status, cursor: parseCursor(q(c, 'cursor')), limit: clampLimit(q(c, 'limit')),
    }));
  });
  add('GET', '/api/replies', false, (c) => {
    json(c.res, 200, listReplies(deps.data, { cursor: parseCursor(q(c, 'cursor')), limit: clampLimit(q(c, 'limit')) }));
  });

  add('GET', '/api/outcomes', false, (c) => {
    const outcome = q(c, 'outcome');
    if (outcome !== undefined && !STAGE_RE.test(outcome)) return json(c.res, 400, { error: 'invalid outcome' });
    json(c.res, 200, listOutcomes(deps.data, {
      outcome, cursor: parseCursor(q(c, 'cursor')), limit: clampLimit(q(c, 'limit')),
    }));
  });
  add('GET', '/api/funnel', false, (c) => json(c.res, 200, funnelView(deps.data, threshold)));

  add('GET', '/api/sessions', false, async (c) => {
    json(c.res, 200, { sessions: await sessionsPanel(deps.run, deps.sessionsToShow) });
  });
  add('GET', '/api/pane', false, async (c) => {
    const window = q(c, 'window') ?? '';
    try {
      assertName(window);
    } catch {
      return json(c.res, 400, { error: 'invalid window' });
    }
    let owner: string | null = null;
    for (const session of deps.sessionsToShow) {
      try {
        assertName(session);
      } catch {
        continue;
      }
      const wins = await listWindows(deps.run, session);
      if (wins.some((w) => w.name === window)) {
        owner = session;
        break;
      }
    }
    if (owner === null) return json(c.res, 404, { error: 'not found' });
    const raw = await capture(deps.run, owner, window, PANE_LINES);
    // redact the whole capture before slicing so a secret wrapped across the cut is still masked
    const whole = redactSecrets(raw, secrets);
    json(c.res, 200, { window: cleanText(window, 64), text: whole.split('\n').slice(-PANE_LINES).join('\n') });
  });

  add('GET', '/api/runs', false, (c) => json(c.res, 200, readRunLog(deps.data, clampLimit(q(c, 'limit')))));
  add('GET', '/api/config', false, (c) => {
    const snapshot = buildSnapshot(deps.data, deps.cfg, now());
    const view = buildConfigView({
      root: deps.root ?? process.cwd(),
      env: deps.env ?? process.env,
      read: (p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      },
      snapshot,
    });
    c.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    c.res.end(redact(JSON.stringify(view)));
  });
  add('GET', '/api/audit', false, (c) => {
    const before = parseCursor(q(c, 'before'));
    json(c.res, 200, { items: listAudit(deps.auth, clampLimit(q(c, 'limit')), before ?? undefined) });
  });

  // ---- request handling --------------------------------------------------------------------------------------

  function rateLimited(idHash: string, t: number): boolean {
    const arr = (hits.get(idHash) ?? []).filter((x) => t - x < 60_000);
    arr.push(t);
    hits.set(idHash, arr);
    if (hits.size > 64) for (const [k, v] of hits) if (!v.some((x) => t - x < 60_000)) hits.delete(k);
    return arr.length > RATE_PER_MIN;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const trusted = deps.trustProxy;
    const secure = trusted && String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https';
    applySecurityHeaders(res, secure);
    let ip = req.socket.remoteAddress ?? '';
    if (trusted) {
      const first = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
      if (first) ip = first.slice(0, 64);
    }

    const host = (req.headers.host ?? '').toLowerCase();
    const p = port();
    if (host !== `127.0.0.1:${p}` && host !== `localhost:${p}` && !allowedHosts.has(host)) {
      return json(res, 421, { error: 'misdirected request' });
    }
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') {
      req.resume();
      return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' });
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
    const path = url.pathname;

    const file = method === 'GET' ? statics.get(path) : undefined;
    if (file) {
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' });
      res.end(file.body);
      return;
    }

    const matching = routes.filter((r) => r.re.test(path));
    if (matching.length === 0) {
      if (statics.has(path)) return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
      if (path.startsWith('/api/')) {
        const s0 = validateSession(deps.auth, parseCookies(req.headers.cookie)[sessionCookieName(secure)], now());
        if (!s0) return json(res, 401, { error: 'unauthenticated' });
      }
      return json(res, 404, { error: 'not found' });
    }
    const route = matching.find((r) => r.method === method);
    const anyOpen = matching.every((r) => r.open);

    const cookie = parseCookies(req.headers.cookie)[sessionCookieName(secure)];
    const session = validateSession(deps.auth, cookie, now());
    if (!anyOpen && !session) return json(res, 401, { error: 'unauthenticated' });
    if (!route) return json(res, 405, { error: 'method not allowed' }, { Allow: matching.map((r) => r.method).join(', ') });

    if (!route.open && session) {
      if (rateLimited(session.idHash, now().getTime())) {
        return json(res, 429, { error: 'rate limited' }, { 'Retry-After': '60' });
      }
      if (method !== 'GET') {
        const hdr = req.headers['x-csrf-token'];
        const token = Array.isArray(hdr) ? hdr[0] : hdr;
        if (!csrfOk(session.csrf, token)) return json(res, 403, { error: 'forbidden' });
        if (req.headers.origin !== `${secure ? 'https' : 'http'}://${req.headers.host ?? ''}`) {
          return json(res, 403, { error: 'forbidden origin' });
        }
      }
    }
    if (method === 'POST') req.resume();

    const m = route.re.exec(path)!;
    const params = m.slice(1).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    try {
      await route.fn({ req, res, url, ip, secure, session }, params);
    } catch (e) {
      if (e instanceof HttpError) {
        if (!res.headersSent) json(res, e.status, { error: e.code });
        return;
      }
      console.error(`web: ${route.name} failed: ${e instanceof Error ? e.name : 'error'}`);
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      else res.end();
    }
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      else res.end();
    });
  });
  server.on('clientError', (_err, socket) => {
    if (!socket.writable) return;
    const body = '{"error":"bad request"}';
    const h = Object.entries({
      'Content-Type': 'application/json; charset=utf-8',
      ...securityHeaders(false),
      Connection: 'close',
      'Content-Length': String(body.length),
    }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    socket.end(`HTTP/1.1 400 Bad Request\r\n${h}\r\n${body}`);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}

/** Create the server and listen on deps.bind (loopback unless allowRemoteBind). */
export function startWebServer(deps: WebDeps): Promise<http.Server> {
  const server = createWebServer(deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, deps.bind, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
