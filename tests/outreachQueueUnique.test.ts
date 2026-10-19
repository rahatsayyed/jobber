// Finding 13: outreach_queue holds at most one row per job and connect profile (null profile = the email/apply row).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueOutreach, enqueueOutreachClassifiedResult, enqueueOutreachResult, openDb, saveJob } from '../src/db.js';

const base = { resume_pdf_path: null, email_subject: 's', email_body: 'b', email_to: 'a@b.co', connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: 'none', apply_url: null };
const job = (db: ReturnType<typeof openDb>, id: string) => saveJob(db, { id, source: 's', title: 'Dev', company: 'Acme', url: 'u', apply_url: 'u', description: 'd' });
const count = (db: ReturnType<typeof openDb>, id: string) => (db.prepare('SELECT COUNT(*) n FROM outreach_queue WHERE job_id = ?').get(id) as { n: number }).n;

describe('enqueue_outreach uniqueness', () => {
  it('a second enqueue for the same job and profile returns the existing id and flags a duplicate', () => {
    const db = openDb(':memory:');
    job(db, 'j1');
    const a = enqueueOutreachResult(db, { job_id: 'j1', ...base });
    const b = enqueueOutreachResult(db, { job_id: 'j1', ...base, email_subject: 'other' });
    expect(a.duplicate).toBe(false);
    expect(b).toEqual({ id: a.id, duplicate: true });
    expect(enqueueOutreach(db, { job_id: 'j1', ...base })).toBe(a.id);
    expect(count(db, 'j1')).toBe(1);
    expect((db.prepare('SELECT email_subject s FROM outreach_queue WHERE id = ?').get(a.id) as { s: string }).s).toBe('s');
  });

  it('different profiles for one job, and the same profile on another job, are separate rows', () => {
    const db = openDb(':memory:');
    job(db, 'j1'); job(db, 'j2');
    const p = (u: string) => ({ ...base, connect_profile_url: u });
    const ids = [
      enqueueOutreach(db, { job_id: 'j1', ...base }),
      enqueueOutreach(db, { job_id: 'j1', ...p('https://linkedin.com/in/a') }),
      enqueueOutreach(db, { job_id: 'j1', ...p('https://linkedin.com/in/b') }),
      enqueueOutreach(db, { job_id: 'j2', ...p('https://linkedin.com/in/a') }),
    ];
    expect(new Set(ids).size).toBe(4);
    expect(enqueueOutreachResult(db, { job_id: 'j1', ...p('https://linkedin.com/in/b') }).duplicate).toBe(true);
  });

  it('the classified path (what the MCP tool calls) reports the duplicate too', () => {
    const db = openDb(':memory:');
    job(db, 'j1');
    const a = enqueueOutreachClassifiedResult(db, { job_id: 'j1', ...base });
    const b = enqueueOutreachClassifiedResult(db, { job_id: 'j1', ...base });
    expect(b).toEqual({ id: a.id, duplicate: true });
  });
});

describe('outreach_queue duplicate migration', () => {
  it('dedupes seeded duplicates keeping the most advanced then earliest row, then enforces uniqueness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oq-'));
    const file = join(dir, 'data.sqlite');
    try {
      const db = openDb(file);
      db.exec('DROP INDEX IF EXISTS idx_outreach_queue_job_profile');
      for (const j of ['a', 'b', 'c', 'd', 'e']) job(db, j);
      const ins = db.prepare(`INSERT INTO outreach_queue (id, job_id, connect_profile_url, email_status, email_sent_at, connect_status, apply_status, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      // a: queued row first, sent row later -> the sent one must survive
      ins.run(1, 'a', null, null, null, null, null, 'queued');
      ins.run(2, 'a', null, 'sent', '2026-10-01 10:00:00', null, null, 'queued');
      ins.run(3, 'a', null, null, null, null, null, 'queued');
      // b: all queued -> earliest survives
      ins.run(4, 'b', null, null, null, null, null, 'queued');
      ins.run(5, 'b', null, null, null, null, null, 'queued');
      // c: two sent -> earliest sent survives
      ins.run(6, 'c', null, 'sent', '2026-10-03 10:00:00', null, null, 'queued');
      ins.run(7, 'c', null, 'sent', '2026-10-02 10:00:00', null, null, 'queued');
      // d: connect claimed beats queued; a different profile is untouched
      ins.run(8, 'd', 'https://linkedin.com/in/x', null, null, null, null, 'queued');
      ins.run(9, 'd', 'https://linkedin.com/in/x', null, null, 'sent', null, 'queued');
      ins.run(10, 'd', 'https://linkedin.com/in/y', null, null, null, null, 'queued');
      // e: apply submitted beats queued
      ins.run(11, 'e', null, null, null, null, null, 'queued');
      ins.run(12, 'e', null, null, null, null, 'submitted', 'queued');
      db.close();

      const re = openDb(file);
      const ids = (j: string) => (re.prepare('SELECT id FROM outreach_queue WHERE job_id = ? ORDER BY id').all(j) as { id: number }[]).map((r) => r.id);
      expect(ids('a')).toEqual([2]);
      expect(ids('b')).toEqual([4]);
      expect(ids('c')).toEqual([7]);
      expect(ids('d')).toEqual([9, 10]);
      expect(ids('e')).toEqual([12]);
      expect(enqueueOutreachResult(re, { job_id: 'a', ...base }).duplicate).toBe(true);
      re.close();

      // idempotent: a third open changes nothing
      const again = openDb(file);
      expect((again.prepare('SELECT COUNT(*) n FROM outreach_queue').get() as { n: number }).n).toBe(6);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
