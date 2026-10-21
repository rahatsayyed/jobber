import { describe, it, expect } from 'vitest';
import { enqueueOutreach, openDb, recordEmailSent, releaseEmailSend } from '../src/db.js';
import { checkAndIncrement } from '../src/lib/rateLimit.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO jobs (id, source, title, company, url, apply_url, description, created_at) VALUES ('j','greenhouse','t','Acme','u','u','d','2026-10-01')").run();
  const base = { job_id: 'j', resume_pdf_path: null, email_subject: 'S', email_body: 'B', email_to: 'a@acme.com', connect_note: 'n', connect_category: 'peer', connect_company: 'Acme', apply_platform: null, apply_url: null };
  const a = enqueueOutreach(db, { ...base, connect_profile_url: 'https://linkedin.com/in/a' });
  const b = enqueueOutreach(db, { ...base, connect_profile_url: 'https://linkedin.com/in/b' });
  return { db, a, b };
}
const status = (db: ReturnType<typeof openDb>) => (db.prepare('SELECT id, email_status FROM outreach_queue ORDER BY id').all() as Array<{ id: number; email_status: string | null }>);
const used = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM daily_counters WHERE key = 'send_email'").get() as { n: number }).n;

describe('releaseEmailSend (a send the hook denied never left the machine)', () => {
  it('puts every failed row of the job back to sendable and gives the counter slot back, once', () => {
    const { db } = setup();
    expect(checkAndIncrement(db, 'send_email', 1)).toBe(true);
    db.prepare("UPDATE outreach_queue SET email_status = 'failed' WHERE job_id = 'j'").run();
    expect(used(db)).toBe(1);
    expect(releaseEmailSend(db, 'j')).toEqual({ rows: 2, slot_released: true });
    expect(status(db).map((r) => r.email_status)).toEqual([null, null]);
    expect(used(db)).toBe(0);
    // a second call changes nothing and never drives the counter below zero
    expect(releaseEmailSend(db, 'j')).toEqual({ rows: 0, slot_released: false });
    expect(used(db)).toBe(0);
    expect(checkAndIncrement(db, 'send_email', 1)).toBe(true);
  });
  it('never touches a sent row, a row with a message id, or another job', () => {
    const { db, a } = setup();
    db.prepare("INSERT INTO jobs (id, source, title, company, url, apply_url, description, created_at) VALUES ('k','greenhouse','t','Beta','u','u','d','2026-10-01')").run();
    enqueueOutreach(db, { job_id: 'k', resume_pdf_path: null, email_subject: 'S', email_body: 'B', email_to: 'b@beta.com', connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: null, apply_url: null });
    checkAndIncrement(db, 'send_email', 5);
    recordEmailSent(db, a, 'm-1');
    db.prepare("UPDATE outreach_queue SET email_status = 'failed' WHERE job_id = 'k'").run();
    expect(releaseEmailSend(db, 'j')).toEqual({ rows: 0, slot_released: false });
    expect(status(db).filter((r) => r.email_status === 'sent')).toHaveLength(2);
    expect(used(db)).toBe(1);
    expect(status(db).find((r) => r.id === 3)?.email_status).toBe('failed');
  });
  it('does not touch a dry_run or queued row', () => {
    const { db } = setup();
    db.prepare("UPDATE outreach_queue SET email_status = 'dry_run' WHERE id = 1").run();
    checkAndIncrement(db, 'send_email', 5);
    expect(releaseEmailSend(db, 'j')).toEqual({ rows: 0, slot_released: false });
    expect(used(db)).toBe(1);
  });
});
