import { describe, it, expect } from 'vitest';
import { openDb, saveJob, setJobExcluded, getExcludedReason, unexcludeJob } from '../src/db.js';

const mk = () => {
  const db = openDb(':memory:');
  saveJob(db, { id: 'j1', source: 't', title: 'Dev', company: 'A', url: 'u', apply_url: 'u', description: 'd' });
  return db;
};

describe('unexcludeJob (final review I3)', () => {
  it('clears excluded_reason, logs the previous reason and returns it', () => {
    const db = mk();
    setJobExcluded(db, 'j1', 'deadline passed: 2026-10-01');
    expect(unexcludeJob(db, 'j1')).toEqual({ ok: true, job_id: 'j1', previous_reason: 'deadline passed: 2026-10-01' });
    expect(getExcludedReason(db, 'j1')).toBeNull();
    const log = db.prepare('SELECT job_id, previous_reason, cleared_at FROM job_exclusion_log').all() as any[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ job_id: 'j1', previous_reason: 'deadline passed: 2026-10-01' });
    expect(typeof log[0].cleared_at).toBe('string');
  });
  it('an unknown job is an error row and writes nothing', () => {
    const db = mk();
    expect(unexcludeJob(db, 'nope')).toEqual({ ok: false, job_id: 'nope', error: 'unknown job_id' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM job_exclusion_log').get() as any).n).toBe(0);
  });
  it('a job that is not excluded is an error row and writes nothing', () => {
    const db = mk();
    expect(unexcludeJob(db, 'j1')).toEqual({ ok: false, job_id: 'j1', error: 'job is not excluded' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM job_exclusion_log').get() as any).n).toBe(0);
  });
  it('a second un-exclude after the first is an error (nothing left to clear)', () => {
    const db = mk();
    setJobExcluded(db, 'j1', 'location FAIL');
    expect(unexcludeJob(db, 'j1').ok).toBe(true);
    expect(unexcludeJob(db, 'j1').ok).toBe(false);
  });
  it('the log table is created by openDb (guarded CREATE IF NOT EXISTS)', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(job_exclusion_log)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'job_id', 'previous_reason', 'cleared_at']);
  });
});
