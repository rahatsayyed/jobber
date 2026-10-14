import { describe, it, expect } from 'vitest';
import { enqueueOutreach, openDb, recordEmailSent, recordOutcome, saveApplication, saveJob, saveMatchResult } from '../src/db.js';
import { BENCHMARKS, funnelStats } from '../src/funnel.js';

function setup() {
  const db = openDb(':memory:');
  for (let i = 1; i <= 6; i++) saveJob(db, { id: `j${i}`, source: 's', title: 't', company: `C${i}`, url: 'u', apply_url: 'u', description: 'd' });
  for (const [id, score] of [['j1', 80], ['j2', 70], ['j3', 65], ['j4', 61], ['j5', 40]] as const) saveMatchResult(db, { job_id: id, score, reasons: '', missing_keywords: [] });
  const q = (job_id: string, profile: string | null) => enqueueOutreach(db, { job_id, resume_pdf_path: null, email_subject: 's', email_body: 'b', email_to: `hr@${job_id}.dev`, connect_note: profile ? 'n' : null, connect_profile_url: profile, connect_category: profile ? 'peer' : null, connect_company: null, apply_platform: null, apply_url: null });
  recordEmailSent(db, q('j1', 'p1'), 'm1');
  q('j1', 'p2');
  recordEmailSent(db, q('j2', null), 'm2');
  recordEmailSent(db, q('j3', null), 'm3');
  saveApplication(db, { job_id: 'j4', platform: 'greenhouse', status: 'submitted' });
  db.prepare("UPDATE outreach_queue SET email_sent_at = '2026-09-01 10:00:00'").run();
  recordOutcome(db, 'j1', 'interview');
  recordOutcome(db, 'j1', 'rejected');
  recordOutcome(db, 'j2', 'replied');
  recordOutcome(db, 'j3', 'no_response');
  db.prepare("UPDATE job_outcomes SET created_at = '2026-09-08 10:00:00' WHERE job_id = 'j1'").run();
  db.prepare("UPDATE job_outcomes SET created_at = '2026-09-04 10:00:00' WHERE job_id = 'j2'").run();
  return db;
}

describe('funnelStats', () => {
  it('counts each job once and uses stage history', () => {
    const f = funnelStats(setup(), 60);
    expect([f.discovered, f.matched, f.contacted, f.replied, f.interview, f.offer]).toEqual([6, 4, 4, 2, 1, 0]);
    expect(f.rates).toEqual({ match: 0.667, reply: 0.5, interview: 0.25, rejection: 1 });
    expect(f.first_response_days_median).toBe(5);
    expect(f.benchmarks).toBe(BENCHMARKS);
  });
  it('uses the stored reply date, not the time the outcome was recorded, for the median response time', () => {
    const db = setup();
    db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, action, reply_date) VALUES ('x', 'j2', 'replied', 'approved', '2026-09-02 10:00:00')").run();
    expect(funnelStats(db, 60).first_response_days_median).toBe(4); // j1 took 7 days, j2 took 1 day (not 3)
  });
  it('uses the reply date of an auto-recorded reply too (action recorded) and ignores merely proposed ones', () => {
    const db = setup();
    db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, action, reply_date) VALUES ('y', 'j2', 'replied', 'recorded', '2026-09-02 10:00:00')").run();
    db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, action, reply_date) VALUES ('z', 'j1', 'interview', 'proposed', '2026-09-02 10:00:00')").run();
    expect(funnelStats(db, 60).first_response_days_median).toBe(4); // j1 stays 7 days, j2 is 1 day
  });
  it('matched skips an excluded job that was never contacted but keeps an excluded job that was (plan 2 AF1/W9)', () => {
    const db = setup();
    saveJob(db, { id: 'jx', source: 's', title: 't', company: 'CX', url: 'u', apply_url: 'u', description: 'd' });
    saveMatchResult(db, { job_id: 'jx', score: 90, reasons: '', missing_keywords: [] });
    db.prepare("UPDATE jobs SET excluded_reason = 'hard stop: visa' WHERE id = 'jx'").run();
    db.prepare("UPDATE jobs SET excluded_reason = 'deadline passed: 2026-10-01' WHERE id = 'j2'").run();
    const f = funnelStats(db, 60);
    expect(f.discovered).toBe(7);
    expect(f.matched).toBe(4); // j1-j4: jx is excluded and never contacted; j2 is excluded but was emailed
    expect(f.contacted).toBe(4);
  });
  it('an empty database gives zeros and null rates, never NaN', () => {
    const f = funnelStats(openDb(':memory:'));
    expect([f.discovered, f.contacted]).toEqual([0, 0]);
    expect(f.rates).toEqual({ match: null, reply: null, interview: null, rejection: null });
    expect(f.first_response_days_median).toBeNull();
  });
});
