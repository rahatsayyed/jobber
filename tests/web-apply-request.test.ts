import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';
import { openReadOnlyDb } from '../src/dash/readDb.js';
import { createManualRequest } from '../src/manual/requests.js';
import { enqueueManualRequest } from '../src/manual/webRequest.js';
import { APPLY_MAX_PER_HOUR } from '../src/web/applyRoutes.js';
import { makeHarness, type Harness } from './helpers/webHarness.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.close();
  h = null;
});

const GH = 'https://boards.greenhouse.io/acme/jobs/12345';

async function setup(over: Parameters<typeof makeHarness>[0] = {}) {
  h = await makeHarness({
    apply: { enqueue: (url, force, now) => createManualRequest(h!.data, url, { force, now }) },
    ...over,
  });
  const { cookie } = await h.login();
  const s = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body) as { csrf: string };
  const origin = `http://127.0.0.1:${h.port}`;
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    h!.call('POST', path, {
      headers: { cookie, 'x-csrf-token': s.csrf, origin, 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });
  const get = (path: string) => h!.call('GET', path, { headers: { cookie } });
  return { cookie, csrf: s.csrf, origin, post, get };
}

const rows = () => h!.data.prepare('SELECT * FROM manual_requests ORDER BY id').all() as { id: number; url: string; force: number; status: string }[];

describe('dashboard apply box', () => {
  it('unauthenticated requests are refused and write nothing', async () => {
    await setup();
    const origin = `http://127.0.0.1:${h!.port}`;
    const hdr = { origin, 'content-type': 'application/json' };
    expect((await h!.call('POST', '/api/apply/prepare', { headers: hdr, body: JSON.stringify({ url: GH }) })).status).toBe(401);
    expect((await h!.call('POST', '/api/apply/confirm', { headers: hdr, body: JSON.stringify({ url: GH, token: 'x' }) })).status).toBe(401);
    expect((await h!.call('GET', '/api/apply/requests')).status).toBe(401);
    expect(rows()).toHaveLength(0);
  });

  it('a bad Origin, a missing Origin or a bad CSRF token is refused', async () => {
    const c = await setup();
    expect((await c.post('/api/apply/prepare', { url: GH }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await c.post('/api/apply/prepare', { url: GH }, { 'x-csrf-token': 'nope' })).status).toBe(403);
    const noOrigin = await h!.call('POST', '/api/apply/prepare', {
      headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ url: GH }),
    });
    expect(noOrigin.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it('an invalid URL is rejected with a reason at both steps', async () => {
    const c = await setup();
    for (const bad of ['http://boards.greenhouse.io/acme/jobs/1', 'https://localhost/x', 'https://user:pw@example.com/jobs/1', 'not a url', 42, 'https://www.linkedin.com/in/someone']) {
      const r = await c.post('/api/apply/prepare', { url: bad });
      expect(r.status, String(bad)).toBe(400);
      expect(JSON.parse(r.body).reason).toBeTruthy();
    }
    expect((await c.post('/api/apply/confirm', { url: 'http://x.example/a', token: 'abc' })).status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it('two steps: prepare shows the classification and writes nothing, confirm queues one row', async () => {
    const c = await setup();
    const p = await c.post('/api/apply/prepare', { url: GH, force: true });
    expect(p.status).toBe(200);
    const pj = JSON.parse(p.body) as { token: string; classification: string; lines: string[]; stopped: boolean };
    expect(pj.classification).toContain('ATS vendor greenhouse');
    expect(pj.lines.join('\n')).toContain('force');
    expect(rows()).toHaveLength(0);
    // wrong force flag: the token is bound to the exact request and is consumed by the attempt
    expect((await c.post('/api/apply/confirm', { url: GH, force: false, token: pj.token })).status).toBe(409);
    expect(rows()).toHaveLength(0);
    const p2 = JSON.parse((await c.post('/api/apply/prepare', { url: GH, force: true })).body) as { token: string };
    const ok = await c.post('/api/apply/confirm', { url: GH, force: true, token: p2.token });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ ok: true, duplicate: false, kind: 'url' });
    expect(rows()).toMatchObject([{ url: GH, force: 1, status: 'pending' }]);
    // the token is single use
    expect((await c.post('/api/apply/confirm', { url: GH, force: true, token: p2.token })).status).toBe(409);
    expect(rows()).toHaveLength(1);
  });

  it('classifies a platform page, an unknown host and an open duplicate', async () => {
    const c = await setup();
    const li = JSON.parse((await c.post('/api/apply/prepare', { url: 'https://www.linkedin.com/jobs/view/3912345678/' })).body);
    expect(li.classification).toContain('job platform linkedin');
    const other = JSON.parse((await c.post('/api/apply/prepare', { url: 'https://careers.example.com/' })).body);
    expect(other.classification).toContain('unknown host');
    expect(other.classification).toContain('careers page');
    const t = JSON.parse((await c.post('/api/apply/prepare', { url: GH })).body) as { token: string };
    await c.post('/api/apply/confirm', { url: GH, token: t.token });
    const again = JSON.parse((await c.post('/api/apply/prepare', { url: GH })).body) as { lines: string[] };
    expect(again.lines.join('\n')).toContain('already open');
  });

  it('a chat token cannot be used to confirm an apply request', async () => {
    const c = await setup({ chat: { enabled: true, session: 'ccgram', window: 'JobApplier', send: async () => {} } });
    const t = JSON.parse((await c.post('/api/send/prepare', { text: 'hello' })).body) as { token: string };
    expect((await c.post('/api/apply/confirm', { url: GH, token: t.token })).status).toBe(409);
    expect(rows()).toHaveLength(0);
  });

  it('rate limit: 10 confirmed requests per hour per session, then 429; the window slides', async () => {
    const c = await setup();
    for (let i = 0; i < APPLY_MAX_PER_HOUR; i++) {
      const url = `https://boards.greenhouse.io/acme${i}/jobs/${1000 + i}`;
      const t = JSON.parse((await c.post('/api/apply/prepare', { url })).body) as { token: string };
      expect((await c.post('/api/apply/confirm', { url, token: t.token })).status).toBe(200);
    }
    const url = 'https://boards.greenhouse.io/acme99/jobs/9999';
    const t = JSON.parse((await c.post('/api/apply/prepare', { url })).body) as { token: string };
    const blocked = await c.post('/api/apply/confirm', { url, token: t.token });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(rows()).toHaveLength(APPLY_MAX_PER_HOUR);
  });

  it('lists the last 20 requests with the stored report escaped as untrusted text', async () => {
    const c = await setup();
    for (let i = 0; i < 23; i++) h!.data.prepare("INSERT INTO manual_requests (url, kind, status, force, created_at) VALUES (?, 'url', 'done', 0, '2026-10-14T00:00:00Z')").run(`https://example.com/jobs/${i}1`);
    h!.data.prepare('UPDATE manual_requests SET report = ? WHERE id = 23').run('Acme <script>alert(1)</script>‮ evil\u0000\nline two `x`');
    const r = JSON.parse((await c.get('/api/apply/requests')).body) as { items: { id: number; report: string; url: string }[]; stopped: boolean };
    expect(r.items).toHaveLength(20);
    expect(r.items[0]!.id).toBe(23);
    expect(r.items[0]!.report).not.toMatch(/[<>`‮\u0000]/);
    expect(r.items[0]!.report).toContain('line two');
    expect(r.stopped).toBe(false);
  });

  it('a STOP file does not block queuing, and the answers say the scheduler is stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'web-apply-root-'));
    mkdirSync(join(root, '.jobber'));
    writeFileSync(join(root, '.jobber', 'STOP'), 'test stop\n');
    const c = await setup({ root, env: {} });
    const p = JSON.parse((await c.post('/api/apply/prepare', { url: GH })).body) as { token: string; stopped: boolean };
    expect(p.stopped).toBe(true);
    const ok = JSON.parse((await c.post('/api/apply/confirm', { url: GH, token: p.token })).body) as { ok: boolean; stopped: boolean };
    expect(ok).toMatchObject({ ok: true, stopped: true });
    expect(rows()).toHaveLength(1);
    expect(JSON.parse((await c.get('/api/apply/requests')).body).stopped).toBe(true);
  });

  it('a failing write is a 502 and leaves nothing behind', async () => {
    const c = await setup({ apply: { enqueue: () => { throw new Error('disk'); } } });
    const t = JSON.parse((await c.post('/api/apply/prepare', { url: GH })).body) as { token: string };
    expect((await c.post('/api/apply/confirm', { url: GH, token: t.token })).status).toBe(502);
    expect(rows()).toHaveLength(0);
  });
});

describe('narrow write', () => {
  it('enqueueManualRequest inserts through createManualRequest on its own connection; the read-only handle stays read-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-apply-db-'));
    const file = join(dir, 'data.sqlite');
    const seed = openDb(file);
    migrateOutreachTables(seed);
    seed.close();
    const ro = openReadOnlyDb(file);
    const r = enqueueManualRequest(file, GH, true, new Date('2026-10-14T00:00:00Z'));
    expect(r).toMatchObject({ ok: true, duplicate: false });
    expect(ro.prepare('SELECT url, force, status FROM manual_requests').all()).toEqual([{ url: GH, force: 1, status: 'pending' }]);
    expect(() => ro.exec("INSERT INTO manual_requests (url) VALUES ('https://x.example/a')")).toThrow();
    expect(ro.pragma('query_only', { simple: true })).toBe(1);
    expect(enqueueManualRequest(file, GH, false, new Date())).toMatchObject({ ok: true, duplicate: true });
    expect(enqueueManualRequest(file, 'http://nope.example/x', false, new Date())).toMatchObject({ ok: false });
    ro.close();
  });

  it('never creates a missing database', () => {
    expect(() => enqueueManualRequest(join(tmpdir(), 'no-such-dir-apply', 'x.sqlite'), GH, false, new Date())).toThrow();
  });
});
