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
  pid = upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(URL1), name: 'Jane Doe', company: 'Acme', category: 'recruiter' });
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
    const a = db.transaction(() => reserveTouch(db, args('x')))();
    const b = db.transaction(() => reserveTouch(db, args('x')))();
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});
