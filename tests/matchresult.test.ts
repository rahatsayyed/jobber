import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, saveJob, getJob, saveMatchResult } from '../src/db.js';

describe('saveMatchResult', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 'test', title: 'Dev', company: 'Acme', url: 'u', apply_url: 'u', description: 'd' });
  });

  it('persists score, reasons, missing keywords and verdicts', () => {
    saveMatchResult(db, { job_id: 'j1', score: 72, reasons: 'good skills', missing_keywords: ['kafka'], location_verdict: 'PASS', language_gate: 'FLAG' });
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get('j1') as any;
    expect(row.score).toBe(72);
    expect(row.match_reasons).toBe('good skills');
    expect(JSON.parse(row.match_missing)).toEqual(['kafka']);
    expect(row.location_verdict).toBe('PASS');
    expect(row.language_gate).toBe('FLAG');
  });

  it('is a no-op for an unknown job id', () => {
    expect(() => saveMatchResult(db, { job_id: 'nope', score: 1, reasons: '', missing_keywords: [] })).not.toThrow();
    expect(getJob(db, 'nope')).toBeUndefined();
  });
});
