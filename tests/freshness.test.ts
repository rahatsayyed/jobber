import { describe, it, expect } from 'vitest';
import { ageDays, classifyDeadlines, parseIsoDay, staleFlag } from '../src/freshness.js';
import { openDb, saveJob, saveMatchResult, sweepDeadlines } from '../src/db.js';

const now = new Date('2026-10-08T15:00:00Z');

describe('freshness', () => {
  it('parses strict ISO days and rejects others', () => {
    expect(parseIsoDay('2026-10-01')).toBe(Date.UTC(2026, 9, 1));
    expect(parseIsoDay('2026-10-01T23:59:00Z')).toBe(Date.UTC(2026, 9, 1));
    for (const bad of ['2023-02-29', '2026-13-01', 'ASAP', '31.08.2026', '', null, undefined]) expect(parseIsoDay(bad as any)).toBeNull();
  });
  it('ages in whole days and flags only past 30', () => {
    expect(ageDays('2026-10-08', now)).toBe(0);
    expect(ageDays('2026-09-08', now)).toBe(30);
    expect(staleFlag('2026-09-08', now)).toBeNull();
    expect(staleFlag('2026-09-07', now)).toBe('stale: posted 31 days ago');
  });
  it('no date means no flag and no guess', () => {
    expect(ageDays(undefined, now)).toBeNull();
    expect(staleFlag(null, now)).toBeNull();
  });
  it('classifies deadlines: past, closing soon (0-7 days), later, unparseable', () => {
    const out = classifyDeadlines([
      { id: 'a', deadline: '2026-10-07', source: 'x' },
      { id: 'b', deadline: '2026-10-08', source: 'x' },
      { id: 'c', deadline: '2026-10-15', source: 'x' },
      { id: 'd', deadline: '2026-10-16', source: 'x' },
      { id: 'e', deadline: 'ASAP', source: 'naukri' },
    ], now);
    expect(out).toEqual({
      expired: [{ job_id: 'a', deadline: '2026-10-07' }],
      closingSoon: [{ job_id: 'b', deadline: '2026-10-08', days_left: 0 }, { job_id: 'c', deadline: '2026-10-15', days_left: 7 }],
      unparseable: [{ job_id: 'e', deadline: 'ASAP', source: 'naukri' }],
    });
  });
});

describe('sweepDeadlines (db)', () => {
  const setup = () => {
    const db = openDb(':memory:');
    for (const id of ['old', 'unscored', 'ok', 'emailed', 'applied', 'connected', 'queuedOnly', 'asap']) saveJob(db, { id, source: 's', title: 't', company: 'c', url: 'u', apply_url: 'u', description: 'd' });
    for (const id of ['old', 'ok', 'emailed', 'applied', 'connected', 'queuedOnly', 'asap']) saveMatchResult(db, { job_id: id, score: 70, reasons: '', missing_keywords: [] });
    db.prepare("UPDATE jobs SET deadline = '2026-10-01' WHERE id IN ('old', 'unscored', 'emailed', 'applied', 'connected', 'queuedOnly')").run();
    db.prepare("UPDATE jobs SET deadline = '2026-10-10' WHERE id = 'ok'").run();
    db.prepare("UPDATE jobs SET deadline = 'ASAP' WHERE id = 'asap'").run();
    db.prepare("INSERT INTO outreach_queue (job_id, email_status) VALUES ('emailed', 'sent')").run();
    db.prepare("INSERT INTO outreach_queue (job_id, connect_status) VALUES ('connected', 'sent')").run();
    db.prepare("INSERT INTO outreach_queue (job_id, email_status) VALUES ('queuedOnly', 'queued')").run();
    db.prepare("INSERT INTO applications (job_id, platform, status) VALUES ('applied', 'linkedin', 'submitted')").run();
    return db;
  };
  const reason = (db: any, id: string) => (db.prepare('SELECT excluded_reason FROM jobs WHERE id = ?').get(id) as any).excluded_reason;
  it('excludes only scored, not-yet-excluded jobs past their deadline', () => {
    const db = setup();
    const out = sweepDeadlines(db, now);
    expect(out.expired.map((e) => e.job_id).sort()).toEqual(['old', 'queuedOnly']);
    expect(out.closingSoon).toEqual([{ job_id: 'ok', deadline: '2026-10-10', days_left: 2 }]);
    expect(reason(db, 'old')).toBe('deadline passed: 2026-10-01');
    expect(reason(db, 'unscored')).toBeNull();
  });
  it('never excludes a job that already has a sent email/connect or a submitted application (follow-ups must survive the deadline)', () => {
    const db = setup();
    const out = sweepDeadlines(db, now);
    for (const id of ['emailed', 'applied', 'connected']) {
      expect(reason(db, id)).toBeNull();
      expect(out.expired.find((e) => e.job_id === id)).toBeUndefined();
    }
  });
  it('reports an unparseable deadline once, not on every run', () => {
    const db = setup();
    expect(sweepDeadlines(db, now).unparseable).toEqual([{ job_id: 'asap', deadline: 'ASAP', source: 's' }]);
    expect(sweepDeadlines(db, now).unparseable).toEqual([]);
    db.prepare("UPDATE jobs SET deadline = 'rolling' WHERE id = 'asap'").run();
    expect(sweepDeadlines(db, now).unparseable).toEqual([{ job_id: 'asap', deadline: 'rolling', source: 's' }]);
  });
});
