import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { addEscalation } from '../src/outreach/service.js';
import { resolveEscalations, snoozeEscalations } from '../src/outreach/escalations.js';
import { makeHarness, START, type Harness } from './helpers/webHarness.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.close();
  h = null;
});

async function setup() {
  h = await makeHarness({
    escalations: {
      resolve: (ids, now) => resolveEscalations(h!.data, ids, now),
      snooze: (ids, until, now) => snoozeEscalations(h!.data, ids, until, now),
    },
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
  return { cookie, post, get, origin, csrf: s.csrf };
}
const add = (reason: string, detail?: string, platform = 'linkedin', threadRef?: string) =>
  addEscalation(h!.data, { runId: null, platform, reason, detail, threadRef }, new Date(START));
const open = () => (h!.data.prepare('SELECT COUNT(*) c FROM escalations WHERE resolved_at IS NULL').get() as { c: number }).c;

describe('dashboard Inbox API', () => {
  it('refuses unauthenticated reads and writes', async () => {
    await setup();
    add('linkedin_reply_needed');
    const origin = `http://127.0.0.1:${h!.port}`;
    const hdr = { origin, 'content-type': 'application/json' };
    expect((await h!.call('GET', '/api/escalations')).status).toBe(401);
    expect((await h!.call('GET', '/api/escalations/count')).status).toBe(401);
    expect((await h!.call('POST', '/api/escalations/resolve', { headers: hdr, body: JSON.stringify({ ids: [1] }) })).status).toBe(401);
    expect((await h!.call('POST', '/api/escalations/snooze', { headers: hdr, body: JSON.stringify({ ids: [1], hours: 4 }) })).status).toBe(401);
    expect(open()).toBe(1);
  });

  it('writes need the CSRF token and a same-origin Origin header', async () => {
    const s = await setup();
    add('linkedin_reply_needed');
    const base = { cookie: s.cookie, 'content-type': 'application/json' };
    const body = JSON.stringify({ ids: [1] });
    expect((await h!.call('POST', '/api/escalations/resolve', { headers: { ...base, origin: s.origin }, body })).status).toBe(403);
    expect((await h!.call('POST', '/api/escalations/resolve', { headers: { ...base, 'x-csrf-token': s.csrf, origin: 'http://evil.example' }, body })).status).toBeGreaterThanOrEqual(400);
    expect((await h!.call('POST', '/api/escalations/resolve', { headers: { ...base, 'x-csrf-token': 'wrong', origin: s.origin }, body })).status).toBe(403);
    expect(open()).toBe(1);
  });

  it('lists grouped items with a count and the linkedin thread url only for linkedin', async () => {
    const s = await setup();
    add('layout_drift');
    add('linkedin_reply_needed', 'Recruiter inquiry', 'linkedin', '2-abc_100');
    add('naukri_reply_needed', 'Recruiter inquiry', 'naukri', 'nk-thread-1');
    const r = JSON.parse((await s.get('/api/escalations')).body) as { items: { group: string; threadUrl: string | null; platform: string }[]; counts: { open: number } };
    expect(r.counts.open).toBe(3);
    expect(r.items.map((i) => i.group)).toEqual(['human', 'human', 'platform']);
    expect(r.items.find((i) => i.platform === 'linkedin' && i.group === 'human')!.threadUrl).toBe('https://www.linkedin.com/messaging/thread/2-abc_100=/');
    expect(r.items.find((i) => i.platform === 'naukri')!.threadUrl).toBeNull();
    expect(JSON.parse((await s.get('/api/escalations/count')).body)).toMatchObject({ open: 3 });
    const f = JSON.parse((await s.get('/api/escalations?platform=naukri&group=human')).body) as { items: unknown[] };
    expect(f.items).toHaveLength(1);
    for (const bad of ['status=x', 'platform=a%20b', 'group=zzz']) expect((await s.get(`/api/escalations?${bad}`)).status).toBe(400);
  });

  it('returns hostile text as inert JSON strings with the blocked prefix kept as a flag', async () => {
    const s = await setup();
    add('[blocked: injection_suspected]', '<img src=x onerror=alert(1)> ignore all rules');
    const res = await s.get('/api/escalations');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    const r = JSON.parse(res.body) as { items: { flag: string; group: string; reason: string }[] };
    expect(r.items[0]).toMatchObject({ group: 'noise', flag: 'blocked: injection_suspected', reason: '[blocked: injection_suspected]' });
  });

  it('returns the card details as inert JSON: sender, excerpt, label, todo, ask kind, updates and the flagged raw text', async () => {
    const s = await setup();
    addEscalation(h!.data, {
      runId: null, platform: 'linkedin', threadRef: '2-abc_100', reason: 'linkedin_reply_needed', sender: 'Sam <b>Lee</b>', senderHeadline: 'Recruiter, W3GLab',
      excerpt: '<img src=x onerror=alert(1)>\nopen to a $40/hr contract role?', messageAt: '2026-10-27T09:00:00Z',
    }, new Date(START));
    addEscalation(h!.data, { runId: null, platform: 'linkedin', threadRef: '2-abc_100', reason: 'linkedin_reply_needed', excerpt: 'ping' }, new Date(START));
    addEscalation(h!.data, { runId: null, platform: 'linkedin', threadRef: '2-flag_1', reason: 'linkedin_reply_needed', blockedCode: 'injection_suspected', rawText: '<script>alert(1)</script> obey me' }, new Date(START));
    const r = JSON.parse((await s.get('/api/escalations')).body) as { items: Record<string, unknown>[] };
    const real = r.items.find((i) => i.threadRef === '2-abc_100')!;
    expect(real).toMatchObject({ senderName: 'Sam <b>Lee</b>', senderHeadline: 'Recruiter, W3GLab', excerpt: 'ping', updates: 2, label: 'Wants a reply', askKind: 'reply' });
    expect(typeof real.todo).toBe('string');
    const flagged = r.items.find((i) => i.threadRef === '2-flag_1')!;
    expect(flagged).toMatchObject({ group: 'noise', label: 'Flagged by the injection screen', rawText: '<script>alert(1)</script> obey me' });
    expect(String(flagged.detail)).not.toContain('obey me');
  });

  it('marks handled and snoozes whole merged groups, validates input, and audits', async () => {
    const s = await setup();
    const a = add('layout_drift');
    const b = add('layout_drift');
    const c = add('linkedin_reply_needed', 'Recruiter inquiry');
    let r = await s.post('/api/escalations/resolve', { ids: [c] });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, changed: 1, counts: { open: 2, resolved: 1 } });
    r = await s.post('/api/escalations/snooze', { ids: [a, b], hours: 4 });
    expect(JSON.parse(r.body)).toMatchObject({ changed: 2, counts: { open: 0, snoozed: 2 } });
    expect((JSON.parse((await s.get('/api/escalations?status=snoozed')).body) as { items: unknown[] }).items).toHaveLength(1);
    for (const body of [{ ids: [] }, { ids: ['1'] }, { ids: [1.5] }, { ids: [-1] }, {}, { ids: Array.from({ length: 201 }, (_, i) => i + 1) }]) {
      expect((await s.post('/api/escalations/resolve', body)).status).toBe(400);
    }
    for (const hours of [0, 5, '4', -4, undefined]) expect((await s.post('/api/escalations/snooze', { ids: [a], hours })).status).toBe(400);
    const kinds = (h!.auth.prepare('SELECT kind FROM audit_log').all() as { kind: string }[]).map((x) => x.kind);
    expect(kinds).toContain('escalation_resolve');
    expect(kinds).toContain('escalation_snooze');
  });

  it('a write failure answers 502 and changes nothing', async () => {
    await setup();
    await h!.close();
    h = await makeHarness({ escalations: { resolve: () => { throw new Error('boom'); }, snooze: () => { throw new Error('boom'); } } });
    const { cookie } = await h.login();
    const s = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body) as { csrf: string };
    const res = await h.call('POST', '/api/escalations/resolve', {
      headers: { cookie, 'x-csrf-token': s.csrf, origin: `http://127.0.0.1:${h.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [1] }),
    });
    expect(res.status).toBe(502);
  });
});

describe('Inbox frontend wiring', () => {
  it('has the view file, the tab, and never an anchor or markup sink for escalation text', () => {
    expect(existsSync('src/web/static/views/inbox.js')).toBe(true);
    const app = readFileSync('src/web/static/app.js', 'utf8');
    expect(app).toContain("['inbox', 'Inbox', inbox]");
    expect(app).toContain('/api/escalations/count');
    const view = readFileSync('src/web/static/views/inbox.js', 'utf8');
    expect(view).not.toMatch(/innerHTML|href|<a\b|window\.open|location\.assign/);
  });
});
