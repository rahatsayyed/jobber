import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { profileKeyOf } from '../src/linkedin/urls.js';
import {
  personByProfileKey, idempotencyKey, reserveTouch, finishTouch, pauseContact,
} from '../src/linkedin/touches.js';

const URL1 = 'https://www.linkedin.com/in/jane-doe';
let db: ReturnType<typeof openDb>;
let pid: number;
const now = new Date('2026-10-14T10:00:00Z');
const args = (text: string, over: Record<string, unknown> = {}) => ({
  personId: pid, kind: 'connect', body: text, key: idempotencyKey('connect', profileKeyOf(URL1), text),
  now, dryRun: false, ...over,
});

beforeEach(() => {
  db = openDb(':memory:');
  pid = upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(URL1), name: 'Jane Doe', headline: 'Technical Recruiter at Acme', company: 'Acme', category: 'recruiter' });
});

describe('touch ledger', () => {
  it('reserve then in_progress then already_sent', () => {
    const r1 = reserveTouch(db, args('hi'));
    expect(r1.ok).toBe(true);
    expect(reserveTouch(db, args('hi'))).toMatchObject({ ok: false, reason: 'in_progress' });
    if (r1.ok) finishTouch(db, r1.touchId, 'sent', now);
    expect(reserveTouch(db, args('hi'))).toMatchObject({ ok: false, reason: 'already_sent' });
    const row = db.prepare('SELECT sent_at FROM touches WHERE id = ?').get((r1 as any).touchId) as any;
    expect(row.sent_at).toBeTruthy();
  });
  it('different connect text is duplicate_kind', () => {
    expect(reserveTouch(db, args('one')).ok).toBe(true);
    expect(reserveTouch(db, args('two'))).toMatchObject({ ok: false, reason: 'duplicate_kind' });
  });
  it('followup with different text is allowed', () => {
    expect(reserveTouch(db, args('one')).ok).toBe(true);
    const k = idempotencyKey('followup', profileKeyOf(URL1), 'two');
    expect(reserveTouch(db, args('two', { kind: 'followup', key: k })).ok).toBe(true);
  });
  it('a differently worded message after an unconfirmed or sending message is in_progress', () => {
    const m = (text: string, kind: string, over: Record<string, unknown> = {}) =>
      args(text, { kind, key: idempotencyKey(kind, profileKeyOf(URL1), text), ...over });
    const r1 = reserveTouch(db, m('first wording', 'rapport'));
    expect(r1.ok).toBe(true);
    // still 'sending': another wording and another message kind are both blocked
    expect(reserveTouch(db, m('second wording', 'rapport'))).toMatchObject({ ok: false, reason: 'in_progress' });
    expect(reserveTouch(db, m('other kind', 'followup'))).toMatchObject({ ok: false, reason: 'in_progress' });
    // unconfirmed keeps blocking
    db.prepare("UPDATE touches SET status = 'unconfirmed' WHERE id = ?").run((r1 as any).touchId);
    expect(reserveTouch(db, m('third wording', 'role_ask'))).toMatchObject({ ok: false, reason: 'in_progress' });
    // a dry run is never blocked
    expect(reserveTouch(db, m('dry wording', 'rapport', { dryRun: true })).ok).toBe(true);
    // once it is SENT, a followup is allowed again
    db.prepare("UPDATE touches SET status = 'sent' WHERE id = ?").run((r1 as any).touchId);
    expect(reserveTouch(db, m('after sent', 'followup')).ok).toBe(true);
  });
  it('dry run twice ok and never blocks real', () => {
    const a = reserveTouch(db, args('hi', { dryRun: true }));
    const b = reserveTouch(db, args('hi', { dryRun: true }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.touchId).toBe(a.touchId);
    const row = db.prepare('SELECT status, idempotency_key FROM touches WHERE id = ?').get((a as any).touchId) as any;
    expect(row.status).toBe('dry_run');
    expect(row.idempotency_key.endsWith(':dry')).toBe(true);
    expect(reserveTouch(db, args('hi')).ok).toBe(true);
  });
  it('personByProfileKey normalizes url', () => {
    const p = personByProfileKey(db, profileKeyOf('HTTPS://WWW.LinkedIn.com/in/Jane-Doe/?utm_source=x'));
    expect(p?.id).toBe(pid);
    expect(p?.stage).toBe('new');
    expect(personByProfileKey(db, 'linkedin.com/in/nobody')).toBeNull();
  });
  it('pauseContact writes paused_reason', () => {
    pauseContact(db, pid, 'replied', now);
    expect(personByProfileKey(db, profileKeyOf(URL1))?.paused_reason).toBe('replied');
  });
  it('sequential reserves of same key cannot both be ok', () => {
    const a = reserveTouch(db, args('x'));
    const b = reserveTouch(db, args('x'));
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
  it('failed then reserve reuses row with sent_at null and original created_at', () => {
    const r1 = reserveTouch(db, args('hi')) as any;
    finishTouch(db, r1.touchId, 'failed', now);
    const r2 = reserveTouch(db, args('hi', { now: new Date('2026-10-15T00:00:00Z') })) as any;
    expect(r2).toMatchObject({ ok: true, touchId: r1.touchId });
    const row = db.prepare('SELECT sent_at, created_at, status FROM touches WHERE id = ?').get(r1.touchId) as any;
    expect(row.sent_at).toBeNull();
    expect(row.status).toBe('sending');
    expect(row.created_at).toBe(now.toISOString());
  });
  it('unconfirmed is in_progress', () => {
    const r1 = reserveTouch(db, args('hi')) as any;
    finishTouch(db, r1.touchId, 'unconfirmed', now);
    expect(reserveTouch(db, args('hi'))).toMatchObject({ ok: false, reason: 'in_progress' });
  });
  it('retrying a failed connect after another connect was sent is duplicate_kind', () => {
    const a = reserveTouch(db, args('A')) as any;
    finishTouch(db, a.touchId, 'failed', now);
    const b = reserveTouch(db, args('B')) as any;
    expect(b.ok).toBe(true);
    finishTouch(db, b.touchId, 'sent', now);
    expect(reserveTouch(db, args('A'))).toMatchObject({ ok: false, reason: 'duplicate_kind' });
    const row = db.prepare('SELECT status FROM touches WHERE id = ?').get(a.touchId) as any;
    expect(row.status).toBe('failed');
  });
  it('finishTouch cannot downgrade sent', () => {
    const r = reserveTouch(db, args('hi')) as any;
    finishTouch(db, r.touchId, 'sent', now);
    finishTouch(db, r.touchId, 'failed', new Date('2026-10-16T00:00:00Z'));
    const row = db.prepare('SELECT status, sent_at FROM touches WHERE id = ?').get(r.touchId) as any;
    expect(row.status).toBe('sent');
    expect(row.sent_at).toBe(now.toISOString());
  });
});
