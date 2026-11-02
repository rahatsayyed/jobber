import { describe, it, expect } from 'vitest';
import { claimColdForSend, openDb, releaseEmailSend } from '../src/db.js';
import { pickDripItem, STATE_TRIED } from '../src/scheduler/mailDrip.js';
import { setState } from '../src/scheduler/runLog.js';
import { parseMaxAppliesPerDay } from '../src/lib/maxApplies.js';
import { markUnconfirmedApply } from '../src/browserctl/commitNaukri.js';

const NOW = new Date('2026-10-15T08:00:00.000Z');

function seed(status: string | null) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('C', 'a@co.example', 'hr', 1, 't', 0.9)").run();
  db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES ('j1', 't', 'T', 'C', 'u')").run();
  const id = Number(db.prepare("INSERT INTO outreach_queue (job_id, email_subject, email_body, email_to, email_status) VALUES ('j1', 's', 'b', 'a@co.example', ?)").run(status).lastInsertRowid);
  return { db, id };
}

describe('mail drip claims and picker', () => {
  it('does not pick a claimed (sending) row', () => {
    const { db } = seed('sending');
    expect(pickDripItem(db, NOW, {})).toMatchObject({ item: null });
  });
  it('picks a dry_run row only when dry-run is off', () => {
    const { db, id } = seed('dry_run');
    expect(pickDripItem(db, NOW, { JOBBER_DRY_RUN: '1' })).toMatchObject({ item: null });
    expect(pickDripItem(db, NOW, { JOBBER_DRY_RUN: '0' })).toMatchObject({ item: { kind: 'cold', id } });
  });
  it('does not re-pick an item tried in the last 3 hours', () => {
    const { db, id } = seed('queued');
    setState(db, STATE_TRIED, JSON.stringify({ [`cold:${id}`]: new Date(NOW.getTime() - 3600_000).toISOString() }), NOW);
    expect(pickDripItem(db, NOW, { JOBBER_DRY_RUN: '0' })).toMatchObject({ item: null });
    const later = new Date(NOW.getTime() + 3 * 3600_000);
    expect(pickDripItem(db, later, { JOBBER_DRY_RUN: '0' })).toMatchObject({ item: { id } });
  });
  it('claimColdForSend claims a queued or empty row once, refuses sending, sent and excluded rows', () => {
    for (const st of ['queued', null] as const) {
      const { db, id } = seed(st);
      expect(claimColdForSend(db, id)).toBe(true);
      expect(claimColdForSend(db, id)).toBe(false);
      expect((db.prepare('SELECT email_status s FROM outreach_queue WHERE id = ?').get(id) as { s: string }).s).toBe('sending');
    }
    for (const st of ['sending', 'sent', 'failed']) {
      const { db, id } = seed(st);
      expect(claimColdForSend(db, id)).toBe(false);
    }
    const ex = seed('queued');
    ex.db.prepare("UPDATE jobs SET excluded_reason = 'x' WHERE id = 'j1'").run();
    expect(claimColdForSend(ex.db, ex.id)).toBe(false);
    expect(claimColdForSend(ex.db, 9999)).toBe(false);
  });
  it('releaseEmailSend frees a claimed sending row and gives the slot back', () => {
    const { db } = seed('sending');
    db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'send_email', 1)").run();
    expect(releaseEmailSend(db, 'j1')).toEqual({ rows: 1, slot_released: true });
  });
});

describe('MAX_APPLIES_PER_DAY parser', () => {
  it('blank or invalid is the default 5, a number is kept, 0 stays 0', () => {
    expect(parseMaxAppliesPerDay({ MAX_APPLIES_PER_DAY: '' })).toBe(5);
    expect(parseMaxAppliesPerDay({})).toBe(5);
    expect(parseMaxAppliesPerDay({ MAX_APPLIES_PER_DAY: 'x' })).toBe(5);
    expect(parseMaxAppliesPerDay({ MAX_APPLIES_PER_DAY: '3' })).toBe(3);
    expect(parseMaxAppliesPerDay({ MAX_APPLIES_PER_DAY: '0' })).toBe(0);
  });
});

describe('unconfirmed apply marker', () => {
  it('writes one manual_review row', () => {
    const db = openDb(':memory:');
    markUnconfirmedApply(db, 'j1', 'naukri');
    markUnconfirmedApply(db, 'j1', 'naukri');
    const n = db.prepare("SELECT COUNT(*) AS n FROM applications WHERE job_id = 'j1' AND status = 'manual_review'").get() as { n: number };
    expect(n.n).toBe(1);
  });
});
