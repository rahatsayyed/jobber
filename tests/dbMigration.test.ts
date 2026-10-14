import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openDb, saveJob, getJob, enqueueOutreach, setJobExcluded, markExcluded,
  recordOutcomeChecked, saveMatchResults, listJobs,
} from '../src/db.js';

const cols = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

const job = (id: string) => ({
  id, source: 't', title: 'T', company: 'C', url: `u-${id}`, apply_url: `a-${id}`, description: 'd',
});

describe('openDb migrations (old-shape database)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('adds new jobs / outreach_queue columns to an old-shape db and keeps existing rows', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jobber-mig-'));
    dirs.push(dir);
    const file = path.join(dir, 'old.sqlite');

    const old = new Database(file);
    old.exec(`
      CREATE TABLE jobs (id TEXT PRIMARY KEY, source TEXT, title TEXT, company TEXT, url TEXT,
        apply_url TEXT, description TEXT, score INTEGER, status TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE outreach_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
        resume_pdf_path TEXT, email_subject TEXT, email_body TEXT, email_to TEXT, email_status TEXT,
        connect_note TEXT, connect_profile_url TEXT, connect_category TEXT, connect_status TEXT,
        apply_platform TEXT, apply_url TEXT, apply_status TEXT, status TEXT DEFAULT 'queued',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      INSERT INTO jobs (id, source, title, company, url, apply_url, description, score)
        VALUES ('old-1', 's', 'Old Job', 'OldCo', 'u', 'a', 'd', 77);
      INSERT INTO outreach_queue (job_id, email_subject) VALUES ('old-1', 'hello');
    `);
    old.close();

    const probe = new Database(file, { readonly: true });
    expect(cols(probe, 'jobs')).not.toContain('match_reasons');
    probe.close();

    const db = openDb(file);
    try {
      const jobCols = cols(db, 'jobs');
      for (const c of ['match_reasons', 'match_missing', 'location_verdict', 'language_gate', 'excluded_reason']) {
        expect(jobCols).toContain(c);
      }
      const qCols = cols(db, 'outreach_queue');
      expect(qCols).toContain('resume_json');
      expect(qCols).toContain('connect_company');

      expect(getJob(db, 'old-1')).toMatchObject({ title: 'Old Job', score: 77 });
      expect(db.prepare('SELECT email_subject FROM outreach_queue WHERE job_id = ?').get('old-1')).toEqual({
        email_subject: 'hello',
      });

      // Re-opening an already migrated db is a no-op.
      db.close();
      const again = openDb(file);
      expect(cols(again, 'jobs').filter((c) => c === 'excluded_reason')).toHaveLength(1);
      again.close();
    } finally {
      if (db.open) db.close();
    }
  });
});

describe('db helpers', () => {
  it('round-trips resume_json through enqueueOutreach', () => {
    const db = openDb(':memory:');
    const id = enqueueOutreach(db, {
      job_id: 'j1', resume_pdf_path: null, email_subject: null, email_body: null, email_to: null,
      connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null,
      apply_platform: null, apply_url: null, resume_json: '{"name":"Test User"}',
    });
    const row = db.prepare('SELECT resume_json FROM outreach_queue WHERE id = ?').get(id) as any;
    expect(row.resume_json).toBe('{"name":"Test User"}');
  });

  it('creates idx_job_outcomes_job', () => {
    const db = openDb(':memory:');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_job_outcomes_job'").get();
    expect(idx).toBeDefined();
  });

  it('setJobExcluded persists a reason and reports unknown ids', () => {
    const db = openDb(':memory:');
    saveJob(db, job('x1'));
    expect((db.prepare('SELECT excluded_reason FROM jobs WHERE id = ?').get('x1') as any).excluded_reason).toBeNull();
    expect(setJobExcluded(db, 'x1', 'location FAIL')).toBe(true);
    expect((db.prepare('SELECT excluded_reason FROM jobs WHERE id = ?').get('x1') as any).excluded_reason).toBe('location FAIL');
    expect(setJobExcluded(db, 'nope', 'r')).toBe(false);
  });

  it('markExcluded marks known jobs and lists unknown ones', () => {
    const db = openDb(':memory:');
    saveJob(db, job('a'));
    saveJob(db, job('b'));
    const r = markExcluded(db, [
      { job_id: 'a', reason: 'deal-breaker: unpaid' },
      { job_id: 'ghost', reason: 'x' },
    ]);
    expect(r).toEqual({ marked: 1, unknown: ['ghost'] });
    const rows = db.prepare('SELECT id, excluded_reason FROM jobs ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'a', excluded_reason: 'deal-breaker: unpaid' },
      { id: 'b', excluded_reason: null },
    ]);
  });

  it('recordOutcomeChecked warns for an unknown job_id but still records', () => {
    const db = openDb(':memory:');
    saveJob(db, job('k'));
    expect(recordOutcomeChecked(db, 'k', 'interview')).toEqual({ recorded: true });
    expect(recordOutcomeChecked(db, 'ghost', 'rejected', 'n')).toEqual({ recorded: true, warning: 'unknown job_id' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM job_outcomes').get() as any).n).toBe(2);
  });

  it('saveMatchResults is atomic: a failing row rolls back the whole batch', () => {
    const db = openDb(':memory:');
    saveJob(db, job('m1'));
    saveJob(db, job('m2'));
    const good = { job_id: 'm1', score: 80, reasons: 'r', missing_keywords: [] as string[] };
    const bad = { job_id: 'm2', score: 70, reasons: {} as any, missing_keywords: [] as string[] };
    expect(() => saveMatchResults(db, [good, bad])).toThrow();
    expect(getJob(db, 'm1')!.score).toBeNull();
    expect(saveMatchResults(db, [good, { ...bad, reasons: 'ok' }])).toBe(2);
    expect(getJob(db, 'm1')!.score).toBe(80);
    expect(getJob(db, 'm2')!.score).toBe(70);
  });
});

describe('listJobs', () => {
  const mk = () => {
    const db = openDb(':memory:');
    saveJob(db, job('a'));
    saveJob(db, job('b'));
    setJobExcluded(db, 'b', 'veto: location');
    return db;
  };

  it('includes excluded_reason in each row', () => {
    const rows = listJobs(mk());
    expect(rows.find((r) => r.id === 'a')!.excluded_reason).toBeNull();
    expect(rows.find((r) => r.id === 'b')!.excluded_reason).toBe('veto: location');
  });

  it('exclude_vetoed hides vetoed jobs; default keeps them', () => {
    const db = mk();
    expect(listJobs(db).map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(listJobs(db, { excludeVetoed: true }).map((r) => r.id)).toEqual(['a']);
  });
});
