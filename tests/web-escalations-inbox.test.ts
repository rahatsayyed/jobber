import { afterEach, describe, expect, it } from 'vitest';
import { addEscalation } from '../src/outreach/service.js';
import { countOpenCards, listEscalations, reopenEscalations, resolveEscalations, snoozeEscalations } from '../src/outreach/escalations.js';
import { makeHarness, START, type Harness } from './helpers/webHarness.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.close();
  h = null;
});
async function setup() {
  h = await makeHarness({
    escalations: {
      resolve: (ids, now, note) => resolveEscalations(h!.data, ids, now, note),
      reopen: (ids) => reopenEscalations(h!.data, ids),
      snooze: (ids, until, now) => snoozeEscalations(h!.data, ids, until, now),
    },
  });
  const { cookie } = await h.login();
  const s = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body) as { csrf: string };
  const origin = `http://127.0.0.1:${h.port}`;
  const post = (path: string, body: unknown) =>
    h!.call('POST', path, { headers: { cookie, 'x-csrf-token': s.csrf, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = (path: string) => h!.call('GET', path, { headers: { cookie } });
  return { cookie, post, get, origin, csrf: s.csrf };
}
const add = (reason: string, threadRef?: string, platform = 'linkedin') =>
  addEscalation(h!.data, { runId: null, platform, reason, detail: 'synthetic detail', threadRef }, new Date(START));
const row = (id: number) => h!.data.prepare('SELECT resolved_at, resolved_note FROM escalations WHERE id = ?').get(id) as { resolved_at: string | null; resolved_note: string | null };

describe('Inbox query additions', () => {
  it('returns resolvedNote and jobId fields (null when unknown) and counts open cards', async () => {
    await setup();
    const a = add('dialog_controls_missing');
    add('linkedin_reply_needed', '2-abc_1');
    add('linkedin_reply_needed', '2-abc_1');
    resolveEscalations(h!.data, [a], new Date(START), 'done by hand');
    const r = listEscalations(h!.data, { now: new Date(START), status: 'all' });
    expect(r.items).toHaveLength(2);
    const handled = r.items.find((i) => i.id === a)!;
    expect(handled).toMatchObject({ resolvedNote: 'done by hand', jobId: null });
    expect(handled.resolved_at).not.toBeNull();
    expect(countOpenCards(h!.data, new Date(START))).toBe(1);
    // A repeat for one thread updates the same open row, so one open row exists for the thread.
    expect(h!.data.prepare('SELECT COUNT(*) c FROM escalations WHERE resolved_at IS NULL').get()).toMatchObject({ c: 1 });
  });
});

describe('Inbox mutate routes', () => {
  it('mark handled stores a cleaned note, reopen clears it, the count route reports cards', async () => {
    const s = await setup();
    const a = add('linkedin_reply_needed', '2-abc_1');
    const b = add('dialog_controls_missing');
    let r = await s.post('/api/escalations/resolve', { ids: [a], note: 'replied <b>by hand</b>' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, changed: 1 });
    expect(row(a).resolved_at).not.toBeNull();
    expect(row(a).resolved_note).toContain('replied');
    expect(JSON.parse((await s.get('/api/escalations/count')).body)).toMatchObject({ open: 1, resolved: 1, cards: 1 });
    r = await s.post('/api/escalations/reopen', { ids: [a, b] });
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, changed: 1 });
    expect(row(a)).toEqual({ resolved_at: null, resolved_note: null });
    expect(JSON.parse((await s.get('/api/escalations/count')).body)).toMatchObject({ open: 2, cards: 2 });
  });

  it('bulk resolve changes every id and a second call changes nothing', async () => {
    const s = await setup();
    const ids = [add('dialog_controls_missing'), add('modal_refs_missing'), add('unresolvable_point')];
    expect(JSON.parse((await s.post('/api/escalations/resolve', { ids })).body)).toMatchObject({ changed: 3 });
    expect(JSON.parse((await s.post('/api/escalations/resolve', { ids })).body)).toMatchObject({ changed: 0 });
  });

  it('validates input', async () => {
    const s = await setup();
    const a = add('dialog_controls_missing');
    for (const body of [{ ids: [] }, { ids: ['1'] }, {}, { ids: [a], note: 5 }, { ids: [a], note: 'x'.repeat(501) }]) {
      expect((await s.post('/api/escalations/resolve', body)).status).toBe(400);
    }
    for (const body of [{ ids: [] }, { ids: [0] }, {}]) expect((await s.post('/api/escalations/reopen', body)).status).toBe(400);
    expect(row(a).resolved_at).toBeNull();
  });

  it('refuses without a session, without CSRF and from a foreign origin', async () => {
    const s = await setup();
    const a = add('dialog_controls_missing');
    const body = JSON.stringify({ ids: [a] });
    const hdr = { 'content-type': 'application/json' };
    for (const path of ['/api/escalations/resolve', '/api/escalations/reopen']) {
      expect((await h!.call('POST', path, { headers: { ...hdr, origin: s.origin }, body })).status).toBe(401);
      expect((await h!.call('POST', path, { headers: { ...hdr, cookie: s.cookie, origin: s.origin }, body })).status).toBe(403);
      expect((await h!.call('POST', path, { headers: { ...hdr, cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'http://evil.example' }, body })).status).toBeGreaterThanOrEqual(400);
    }
    expect(row(a).resolved_at).toBeNull();
  });

  it('audits the kind and ids only, never the note', async () => {
    const s = await setup();
    const a = add('dialog_controls_missing');
    await s.post('/api/escalations/resolve', { ids: [a], note: 'secret owner note' });
    await s.post('/api/escalations/reopen', { ids: [a] });
    const rows = h!.auth.prepare("SELECT kind, note FROM audit_log WHERE kind LIKE 'escalation_%'").all() as { kind: string; note: string | null }[];
    expect(rows.map((x) => x.kind)).toEqual(['escalation_resolve', 'escalation_reopen']);
    expect(JSON.stringify(rows)).not.toContain('secret owner note');
  });

  it('reopen without a writer answers 502', async () => {
    await setup();
    await h!.close();
    h = await makeHarness({ escalations: { resolve: () => 0, snooze: () => 0 } });
    const { cookie } = await h.login();
    const s = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body) as { csrf: string };
    const res = await h.call('POST', '/api/escalations/reopen', {
      headers: { cookie, 'x-csrf-token': s.csrf, origin: `http://127.0.0.1:${h.port}`, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [1] }),
    });
    expect(res.status).toBe(502);
  });
});
