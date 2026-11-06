import { describe, it, expect } from 'vitest';
import { openDb, saveJob, saveMatchResultsChecked } from '../src/db.js';
import { coDims } from './helpers/coDims.js';

const desc = 'We need 3+ years of React. Strong TypeScript required. Kubernetes is a plus. Must be based in India.';
const mk = () => {
  const db = openDb(':memory:');
  saveJob(db, { id: 'j1', source: 't', title: 'Dev', company: 'A', url: 'u', apply_url: 'u', description: desc });
  return db;
};

describe('save_match_result returns the stored (capped) scores (final review I1)', () => {
  it('Global 4.3 with unverifiable critical rows returns 3, which fails the 4.0 threshold', () => {
    const db = mk();
    const row = {
      job_id: 'j1', score: 85, reasons: 'r', missing_keywords: [], score_dims: coDims(4.3),
      requirements: [{ req: 'React', importance: 'critical', evidence: 'stated', jd_quote: 'not in the posting at all', match: 'missing' }],
    };
    const out = saveMatchResultsChecked(db, [row] as any);
    expect(out.scores).toEqual([{ job_id: 'j1', score: 3, score_cap_reason: 'evidence-ceiling:3', confidence: 'low' }]);
    expect(out.scores[0].score).toBeLessThan(4);
    expect((db.prepare("SELECT score FROM jobs WHERE id='j1'").get() as any).score).toBe(3);
  });
  it('Global 2.5 with a row score of 90 returns 2.5', () => {
    const db = mk();
    const row = {
      job_id: 'j1', score: 90, reasons: 'r', missing_keywords: [], score_dims: coDims(2.5),
      requirements: [{ req: 'React', importance: 'critical', evidence: 'stated', jd_quote: '3+ years of React', match: 'strong' }],
    };
    const out = saveMatchResultsChecked(db, [row] as any);
    expect(out.scores[0]).toMatchObject({ job_id: 'j1', score: 2.5, score_cap_reason: null });
  });
  it('error rows and unknown ids have no entry in scores', () => {
    const db = mk();
    const out = saveMatchResultsChecked(db, [{ job_id: 'j1', error: 'x' }, { job_id: 'zz', score: 0, reasons: 'expired', missing_keywords: [] }] as any);
    expect(out.scores).toEqual([]);
  });
});
