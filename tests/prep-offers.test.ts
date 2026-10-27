import { describe, it, expect } from 'vitest';
import { openDb, listUnscoredJobs, PREP_OFFER_LIMIT, PREP_OFFER_LIMIT_APPLY } from '../src/db.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { countDue } from '../src/scheduler/due.js';
import { planPipelineWork, prepOfferLimitFor } from '../src/pipelineWork.js';

const NOW = new Date('2026-10-27T12:00:00.000Z');
type Db = ReturnType<typeof openDb>;

function addMatched(db: Db, id: string, o: { source: string; apply_url: string | null; offers: number; score?: number }): void {
  db.prepare(
    'INSERT INTO jobs (id, source, title, company, apply_url, score, prep_offers, created_at, company_key, title_key) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(id, o.source, `Role ${id}`, `Co ${id}`, o.apply_url, o.score ?? 75, o.offers, '2026-10-20 00:00:00', `co${id}`, `role${id}`);
}
const offered = (db: Db): string[] => listUnscoredJobs(db, { kind: 'matched', limit: 15, matchThreshold: 60, now: NOW }).map((r) => r.id);

describe('prep offers: apply-capable matched jobs are not dropped at the plain limit', () => {
  it('limit per job: apply-capable (Naukri, Wellfound, ATS form) get the larger one, the rest the plain one', () => {
    expect(PREP_OFFER_LIMIT_APPLY).toBeGreaterThan(PREP_OFFER_LIMIT);
    expect(prepOfferLimitFor({ source: 'naukri', apply_url: 'https://www.naukri.com/job-listings-full-stack-1' })).toBe(PREP_OFFER_LIMIT_APPLY);
    expect(prepOfferLimitFor({ source: 'wellfound', apply_url: 'https://wellfound.com/jobs/1-react' })).toBe(PREP_OFFER_LIMIT_APPLY);
    expect(prepOfferLimitFor({ source: 'greenhouse', apply_url: 'https://boards.greenhouse.io/acme/jobs/1' })).toBe(PREP_OFFER_LIMIT_APPLY);
    expect(prepOfferLimitFor({ source: 'remoteok', apply_url: 'https://acme.example/jobs/1' })).toBe(PREP_OFFER_LIMIT);
    expect(prepOfferLimitFor({ source: 'linkedin-jobs', apply_url: 'https://www.linkedin.com/jobs/view/1' })).toBe(PREP_OFFER_LIMIT);
    expect(prepOfferLimitFor({ source: 'naukri', apply_url: null })).toBe(PREP_OFFER_LIMIT);
  });

  it('a Naukri job that already used the plain limit is still offered, until the larger limit', () => {
    const db = openDb(':memory:');
    addMatched(db, 'nk', { source: 'naukri', apply_url: 'https://www.naukri.com/job-listings-full-stack-1', offers: PREP_OFFER_LIMIT });
    for (let n = PREP_OFFER_LIMIT; n < PREP_OFFER_LIMIT_APPLY; n++) expect(offered(db)).toEqual(['nk']);
    expect(offered(db)).toEqual([]);
    expect((db.prepare("SELECT prep_offers FROM jobs WHERE id = 'nk'").get() as { prep_offers: number }).prep_offers).toBe(PREP_OFFER_LIMIT_APPLY);
  });

  it('a job with no apply path keeps the plain limit', () => {
    const db = openDb(':memory:');
    addMatched(db, 'rok', { source: 'remoteok', apply_url: 'https://acme.example/jobs/1', offers: PREP_OFFER_LIMIT });
    expect(offered(db)).toEqual([]);
  });

  it('the planner counts the same jobs (matchedAwaitingPrepare and matchedOffer)', () => {
    const db = openDb(':memory:');
    addMatched(db, 'nk', { source: 'naukri', apply_url: 'https://www.naukri.com/job-listings-full-stack-1', offers: PREP_OFFER_LIMIT });
    addMatched(db, 'rok', { source: 'remoteok', apply_url: 'https://acme.example/jobs/1', offers: PREP_OFFER_LIMIT });
    expect(planPipelineWork(db, { now: NOW, failLimit: 3, matchThreshold: 60 }).matchedOffer).toEqual(['nk']);
    expect(countDue(db, NOW, loadTuning({}), {}).matchedAwaitingPrepare).toBe(1);
  });
});
