import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';
import { addEscalation } from '../src/outreach/service.js';
import {
  classifyEscalation, countEscalations, linkedinThreadUrl, listEscalations, resolveEscalations, snoozeEscalations,
} from '../src/outreach/escalations.js';

const T0 = new Date('2026-10-27T10:00:00.000Z');
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);

function setup() {
  const db = openDb(':memory:');
  migrateOutreachTables(db);
  return db;
}
const person = (db: ReturnType<typeof setup>, name: string, company: string): number =>
  Number(db.prepare(
    "INSERT INTO people (platform, profile_key, name, company, company_key, category) VALUES ('linkedin', ?, ?, ?, ?, 'recruiter')",
  ).run(`k-${name}`, name, company, company.toLowerCase()).lastInsertRowid);

describe('classifyEscalation', () => {
  it('puts replies, inquiries and apply rows first, tool problems second, blocked noise last', () => {
    expect(classifyEscalation('linkedin', 'linkedin_reply_needed', 'x').group).toBe('human');
    expect(classifyEscalation('linkedin', 'salary_question', null).group).toBe('human');
    expect(classifyEscalation('linkedin', 'x', 'Recruiter inquiry from Sam').group).toBe('human');
    expect(classifyEscalation('apply', 'apply:captcha', null).group).toBe('human');
    expect(classifyEscalation('linkedin', 'layout_drift', null).group).toBe('platform');
    expect(classifyEscalation('linkedin', 'custom_note_limit_reached', null).group).toBe('platform');
    expect(classifyEscalation('scheduler', 'apply-operator cannot read queue', null).group).toBe('platform');
    const n = classifyEscalation('linkedin', '[blocked: injection_suspected]', 'recruiter asks salary');
    expect(n.group).toBe('noise');
    expect(n.flag).toBe('blocked: injection_suspected');
    expect(classifyEscalation('linkedin', '[unscreened]', null)).toMatchObject({ group: 'noise', flag: 'unscreened' });
    expect(classifyEscalation('linkedin', 'injection_suspect', null).group).toBe('noise');
  });
});

describe('linkedinThreadUrl', () => {
  it('builds the messaging url for linkedin thread refs only', () => {
    expect(linkedinThreadUrl('linkedin', '2-N2U1OWM3NjYtNjYz_100')).toBe('https://www.linkedin.com/messaging/thread/2-N2U1OWM3NjYtNjYz_100/');
    expect(linkedinThreadUrl('naukri', 'abc')).toBeNull();
    expect(linkedinThreadUrl('wellfound', 'abc')).toBeNull();
    expect(linkedinThreadUrl('linkedin', null)).toBeNull();
    expect(linkedinThreadUrl('linkedin', 'a/../b?x=1')).toBeNull();
  });
});

describe('listEscalations', () => {
  it('orders groups human, platform, noise; newest first; joins the person; dedups identical rows', () => {
    const db = setup();
    const p = person(db, 'Sam Recruiter', 'Globex');
    addEscalation(db, { runId: null, platform: 'linkedin', reason: 'layout_drift' }, at(0));
    addEscalation(db, { runId: null, platform: 'linkedin', reason: '[blocked: injection_suspected]', detail: 'x' }, at(1));
    const a = addEscalation(db, { runId: null, platform: 'linkedin', personId: p, threadRef: '2-abc_100', reason: 'linkedin_reply_needed', detail: 'asks salary' }, at(2));
    // A repeat for the same open thread updates the row instead of adding one.
    const b = addEscalation(db, { runId: null, platform: 'linkedin', personId: p, threadRef: '2-abc_100', reason: 'linkedin_reply_needed', detail: 'asks salary' }, at(3));
    expect(b).toBe(a);
    addEscalation(db, { runId: null, platform: 'linkedin', reason: 'layout_drift' }, at(4));
    const r = listEscalations(db, { now: at(10) });
    expect(r.items.map((i) => i.group)).toEqual(['human', 'platform', 'noise']);
    const human = r.items[0];
    expect(human.updates).toBe(2);
    expect(human.ids).toEqual([a]);
    expect(human.id).toBe(a);
    expect(human.personName).toBe('Sam Recruiter');
    expect(human.personCompany).toBe('Globex');
    expect(human.threadUrl).toBe('https://www.linkedin.com/messaging/thread/2-abc_100=/');
    // base64 padding is restored: an unpadded LinkedIn thread id shows "conversation failed to load"
    expect(linkedinThreadUrl('linkedin', '2-ZjRlMzhmXzEwMA')).toBe('https://www.linkedin.com/messaging/thread/2-ZjRlMzhmXzEwMA==/');
    expect(r.items[1].count).toBe(2);
    expect(r.items[2].flag).toBe('blocked: injection_suspected');
    // dedup is display only: every row is still there
    expect((db.prepare('SELECT COUNT(*) c FROM escalations').get() as { c: number }).c).toBe(4);
  });

  it('finds the person through inbound_messages when the row has no person_id', () => {
    const db = setup();
    const p = person(db, 'Ann', 'Initech');
    db.prepare("INSERT INTO inbound_messages (platform, thread_ref, person_id, text_hash, klass, escalated, created_at) VALUES ('linkedin','2-t_1',?,?,'reply',1,?)")
      .run(p, 'a'.repeat(32), T0.toISOString());
    addEscalation(db, { runId: null, platform: 'linkedin', threadRef: '2-t_1', reason: 'linkedin_reply_needed' }, at(0));
    expect(listEscalations(db, { now: at(1) }).items[0].personName).toBe('Ann');
  });

  it('shows the job of the latest touch when known', () => {
    const db = setup();
    const p = person(db, 'Bo', 'Hooli');
    db.prepare("INSERT INTO jobs (id, source, title, company) VALUES ('j1','x','React Dev','Hooli')").run();
    db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key, status) VALUES (?, 'j1', 'connect_note', 'k1', 'sent')").run(p);
    addEscalation(db, { runId: null, platform: 'linkedin', personId: p, reason: 'linkedin_reply_needed' }, at(0));
    expect(listEscalations(db, { now: at(1) }).items[0].jobTitle).toBe('React Dev at Hooli');
  });

  it('filters by platform, group and status; resolve and snooze move rows between statuses', () => {
    const db = setup();
    const a = addEscalation(db, { runId: null, platform: 'linkedin', reason: 'linkedin_reply_needed' }, at(0));
    const b = addEscalation(db, { runId: null, platform: 'naukri', reason: 'layout_drift' }, at(1));
    const c = addEscalation(db, { runId: null, platform: 'apply', reason: 'apply:captcha' }, at(2));
    const now = at(10);
    expect(listEscalations(db, { now, platform: 'naukri' }).items.map((i) => i.id)).toEqual([b]);
    expect(listEscalations(db, { now, group: 'human' }).items.map((i) => i.id).sort()).toEqual([a, c].sort());
    expect(resolveEscalations(db, [a], now)).toBe(1);
    expect(resolveEscalations(db, [a], now)).toBe(0); // already resolved
    expect(snoozeEscalations(db, [b], new Date(now.getTime() + 3600_000), now)).toBe(1);
    expect(listEscalations(db, { now }).items.map((i) => i.id)).toEqual([c]);
    expect(listEscalations(db, { now, status: 'resolved' }).items.map((i) => i.id)).toEqual([a]);
    expect(listEscalations(db, { now, status: 'snoozed' }).items.map((i) => i.id)).toEqual([b]);
    // snooze ends by itself
    expect(listEscalations(db, { now: at(200) }).items.map((i) => i.id).sort()).toEqual([b, c].sort());
    expect(countEscalations(db, now)).toMatchObject({ open: 1, snoozed: 1, resolved: 1 });
    // resolved rows cannot be snoozed
    expect(snoozeEscalations(db, [a], new Date(now.getTime() + 3600_000), now)).toBe(0);
  });

  it('works on an old database without the snoozed_until column (read-only handle)', () => {
    const db = setup();
    addEscalation(db, { runId: null, platform: 'linkedin', reason: 'linkedin_reply_needed' }, at(0));
    db.exec('ALTER TABLE escalations DROP COLUMN snoozed_until');
    expect(listEscalations(db, { now: at(1) }).items).toHaveLength(1);
    expect(countEscalations(db, at(1)).open).toBe(1);
  });

  it('cleans untrusted text: no control characters, bounded length', () => {
    const db = setup();
    addEscalation(db, { runId: null, platform: 'linkedin', reason: 'linkedin_reply_needed', detail: `hi\u0007 <img src=x onerror=1> ${'z'.repeat(900)}` }, at(0));
    const d = listEscalations(db, { now: at(1) }).items[0].detail ?? '';
    expect(d).not.toMatch(/\u0007/);
    expect(d.length).toBeLessThanOrEqual(600);
  });
});
