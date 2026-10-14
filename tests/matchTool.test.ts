import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { openDb, saveJob } from '../src/db.js';
import { handleSaveMatchResults, matchResultsInputShape } from '../src/matchTool.js';

const desc = 'We need 3+ years of React. Strong TypeScript required. Kubernetes is a plus. Must be based in India.';
const dims = { skills: 20, seniority: 18, domain: 12, location: 25 };
const base = { reasons: 'r', missing_keywords: [] as string[] };
const call = (db: any, results: unknown[]) => {
  const args = z.object(matchResultsInputShape).parse({ results });
  return JSON.parse(handleSaveMatchResults(db, args).content[0].text);
};

describe('save_match_result tool', () => {
  it('bad typed fields reject only their own row; good rows are saved; the call succeeds', () => {
    const db = openDb(':memory:');
    for (const id of ['good', 'strdim', 'booldim', 'medium', 'noscore', 'overflow']) saveJob(db, { id, source: 'test', title: 'Dev', company: 'Acme', url: 'u', apply_url: 'u', description: desc });
    const out = call(db, [
      { job_id: 'good', score: 1, ...base, score_dims: dims,
        requirements: [{ req: 'React', importance: 'medium', evidence: 'stated', jd_quote: '3+ years of React', match: 'strong' }] },
      { job_id: 'strdim', score: 1, ...base, score_dims: { ...dims, skills: '20' } },
      { job_id: 'booldim', score: 1, ...base, score_dims: { ...dims, seniority: true } },
      { job_id: 'medium', score: 1, ...base, score_dims: { ...dims, domain: 'medium' } },
      { job_id: 'noscore', ...base },
      { job_id: 'overflow', error: 'batch over 5; resend in a new batch' },
    ]);
    expect(out.saved).toBe(1);
    expect(out.errors).toEqual([
      { job_id: 'strdim', error: 'invalid score_dims.skills: 20' },
      { job_id: 'booldim', error: 'invalid score_dims.seniority: true' },
      { job_id: 'medium', error: 'invalid score_dims.domain: medium' },
      { job_id: 'noscore', error: 'missing score_dims' },
      { job_id: 'overflow', error: 'batch over 5; resend in a new batch' },
    ]);
    expect((db.prepare("SELECT score FROM jobs WHERE id = 'good'").get() as any).score).toBe(75);
    expect(JSON.parse((db.prepare("SELECT requirements FROM jobs WHERE id = 'good'").get() as any).requirements)[0].importance).toBe('meaningful');
    for (const id of ['strdim', 'booldim', 'medium', 'noscore', 'overflow']) expect((db.prepare('SELECT score FROM jobs WHERE id = ?').get(id) as any).score).toBeNull();
  });
});
