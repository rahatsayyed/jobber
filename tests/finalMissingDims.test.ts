import { describe, it, expect } from 'vitest';
import { openDb, saveJob, saveMatchResultsChecked } from '../src/db.js';
import { normalizeMatchRow } from '../src/score.js';

const mk = () => {
  const db = openDb(':memory:');
  saveJob(db, { id: 'j1', source: 't', title: 'Dev', company: 'A', url: 'u', apply_url: 'u', description: 'd' });
  return db;
};

describe('rows without score_dims (final review M1)', () => {
  it('an expired row (score 0, reasons "expired") is accepted and saved with score 0', () => {
    const db = mk();
    const out = saveMatchResultsChecked(db, [{ job_id: 'j1', score: 0, reasons: 'expired', missing_keywords: [] }] as any);
    expect(out.saved).toBe(1);
    expect(out.errors).toEqual([]);
    expect(out.scores[0]).toMatchObject({ job_id: 'j1', score: 0 });
    expect((db.prepare("SELECT score FROM jobs WHERE id='j1'").get() as any).score).toBe(0);
  });
  it('a row with a high score and no score_dims is a per-row error "missing score_dims" and writes nothing', () => {
    const db = mk();
    const out = saveMatchResultsChecked(db, [{ job_id: 'j1', score: 90, reasons: 'great', missing_keywords: [] }] as any);
    expect(out.saved).toBe(0);
    expect(out.errors).toEqual([{ job_id: 'j1', error: 'missing score_dims' }]);
    expect((db.prepare("SELECT score FROM jobs WHERE id='j1'").get() as any).score).toBeNull();
  });
  it('score 0 with a reason other than expired, or score > 0 labelled expired, is also rejected', () => {
    expect(normalizeMatchRow({ job_id: 'j', score: 0, reasons: 'no fit', missing_keywords: [] } as any, 'd')).toEqual({ ok: false, error: 'missing score_dims' });
    expect(normalizeMatchRow({ job_id: 'j', score: 80, reasons: 'expired', missing_keywords: [] } as any, 'd')).toEqual({ ok: false, error: 'missing score_dims' });
  });
  it('expired matching is case-insensitive and trimmed', () => {
    expect(normalizeMatchRow({ job_id: 'j', score: 0, reasons: ' Expired ', missing_keywords: [] } as any, 'd').ok).toBe(true);
  });
});
