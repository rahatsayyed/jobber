import { describe, it, expect } from 'vitest';
import { openDb, saveJob, saveMatchResultsChecked } from '../src/db.js';

const desc = 'We need 3+ years of React. Strong TypeScript required. Kubernetes is a plus. Must be based in India.';
const mk = () => {
  const db = openDb(':memory:');
  saveJob(db, { id: 'j1', source: 't', title: 'Dev', company: 'A', url: 'u', apply_url: 'u', description: desc });
  return db;
};

describe('save_match_result returns the stored (capped) scores (final review I1)', () => {
  it('dims 22/21/21/21 (=85) with unverifiable critical rows returns 59, which fails a 60 threshold', () => {
    const db = mk();
    const row = {
      job_id: 'j1', score: 85, reasons: 'r', missing_keywords: [], score_dims: { skills: 22, seniority: 21, domain: 21, location: 21 },
      requirements: [{ req: 'React', importance: 'critical', evidence: 'stated', jd_quote: 'not in the posting at all', match: 'missing' }],
    };
    const out = saveMatchResultsChecked(db, [row] as any);
    expect(out.scores).toEqual([{ job_id: 'j1', score: 59, score_cap_reason: 'evidence-ceiling:59', confidence: 'low' }]);
    expect(out.scores[0].score).toBeLessThan(60);
    expect((db.prepare("SELECT score FROM jobs WHERE id='j1'").get() as any).score).toBe(59);
  });
  it('dims summing to 40 with a row score of 90 returns 40', () => {
    const db = mk();
    const row = {
      job_id: 'j1', score: 90, reasons: 'r', missing_keywords: [], score_dims: { skills: 10, seniority: 10, domain: 10, location: 10 },
      requirements: [{ req: 'React', importance: 'critical', evidence: 'stated', jd_quote: '3+ years of React', match: 'strong' }],
    };
    const out = saveMatchResultsChecked(db, [row] as any);
    expect(out.scores[0]).toMatchObject({ job_id: 'j1', score: 40, score_cap_reason: null });
  });
  it('error rows and unknown ids have no entry in scores', () => {
    const db = mk();
    const out = saveMatchResultsChecked(db, [{ job_id: 'j1', error: 'x' }, { job_id: 'zz', score: 0, reasons: 'expired', missing_keywords: [] }] as any);
    expect(out.scores).toEqual([]);
  });
});
