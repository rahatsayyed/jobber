import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atsCoverageSchema, enqueueOutreach, openDb } from '../src/db.js';

const item = {
  job_id: 'j1', resume_pdf_path: null, email_subject: null, email_body: null, email_to: null,
  connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null,
  apply_platform: 'greenhouse', apply_url: 'https://boards.greenhouse.io/x/jobs/1',
};

describe('outreach_queue quality columns', () => {
  it('stores ats coverage, gaps, fact warnings and review counts', () => {
    const db = openDb(':memory:');
    const id = enqueueOutreach(db, { ...item, ats_coverage: 62, ats_gaps: ['Kubernetes'], fact_warnings: ['posting-echo:ui judgment @summary[1]'], review_applied: 3, review_rejected: 1 });
    const row = db.prepare('SELECT * FROM outreach_queue WHERE id = ?').get(id) as any;
    expect(row.ats_coverage).toBe(62);
    expect(JSON.parse(row.ats_gaps)).toEqual(['Kubernetes']);
    expect(JSON.parse(row.fact_warnings)).toEqual(['posting-echo:ui judgment @summary[1]']);
    expect([row.review_applied, row.review_rejected]).toEqual([3, 1]);
  });
  it('enqueue schema accepts ats_coverage null (tailor contract: number or null) and the helper stores NULL', () => {
    expect(atsCoverageSchema.safeParse(null).success).toBe(true);
    expect(atsCoverageSchema.safeParse(undefined).success).toBe(true);
    expect(atsCoverageSchema.safeParse(62).success).toBe(true);
    expect(atsCoverageSchema.safeParse(101).success).toBe(false);
    expect(atsCoverageSchema.safeParse(6.5).success).toBe(false);
    const db = openDb(':memory:');
    const row = db.prepare('SELECT ats_coverage FROM outreach_queue WHERE id = ?').get(enqueueOutreach(db, { ...item, ats_coverage: null })) as any;
    expect(row.ats_coverage).toBeNull();
  });
  it('defaults to NULL when not given', () => {
    const db = openDb(':memory:');
    const row = db.prepare('SELECT ats_coverage, ats_gaps FROM outreach_queue WHERE id = ?').get(enqueueOutreach(db, item)) as any;
    expect(row).toEqual({ ats_coverage: null, ats_gaps: null });
  });
  it('migrates an old database file that lacks the columns', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'queueq-')), 'old.sqlite');
    const raw = new BetterSqlite3(file);
    raw.exec('CREATE TABLE outreach_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, status TEXT)');
    raw.close();
    const db = openDb(file);
    const cols = (db.prepare('PRAGMA table_info(outreach_queue)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['ats_coverage', 'ats_gaps', 'fact_warnings', 'review_applied', 'review_rejected']));
    db.close();
  });
});
