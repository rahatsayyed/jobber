import { describe, it, expect } from 'vitest';
import { openDb, saveJob, type Job } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { nextContactsForCompany, nextPosterContacts } from '../src/outreach/service.js';
import { handleNextContacts } from '../src/mcp/outreach.js';
import { reserveTouch, finishTouch } from '../src/linkedin/touches.js';

type D = ReturnType<typeof openDb>;
const NOW = new Date('2026-10-23T08:00:00.000Z');
const cfg = { companyContactLimit: 2 };

function post(db: D, n: string, o: Omit<Partial<Job>, 'score'> & { score?: number | null; poster?: string | null } = {}) {
  const poster = o.poster === undefined ? `https://www.linkedin.com/in/poster-${n}/` : o.poster;
  const job: Job = {
    id: `li-post:${n}`, source: 'linkedin-posts', title: o.title ?? 'React Developer', company: o.company ?? '',
    url: `https://www.linkedin.com/feed/update/urn:li:activity:${n}/`, apply_url: `https://www.linkedin.com/feed/update/urn:li:activity:${n}/`,
    description: 'We are hiring a React Developer. 3 years experience.', ...(poster ? { poster_url: poster } : {}),
    ...(o.priority ? { priority: o.priority } : {}),
  };
  saveJob(db, job);
  if (o.score !== null) db.prepare('UPDATE jobs SET score = ? WHERE id = ?').run(o.score ?? 80, job.id);
  let personId = 0;
  if (poster) personId = upsertPerson(db, { platform: 'linkedin', profileKey: `linkedin.com/in/poster-${n}`, name: `Poster ${n}`, company: o.company ?? '', category: 'hiring_manager' });
  return { id: job.id, personId };
}

describe('poster modes skip blocked people (posters and job_id)', () => {
  const mark = (db: D, personId: number, status: string, extra = '') =>
    db.prepare(`INSERT INTO touches (person_id, kind, idempotency_key, status ${extra ? ', no_dialog_count, released_at' : ''}) VALUES (?, 'connect', ?, ? ${extra ? ', 2, ?' : ''})`)
      .run(...([personId, `k${personId}${status}`, status] as (string | number)[]), ...(extra ? [extra] : []));
  it('skips unconfirmed, sending and retry_limit posters and returns the next eligible ones', () => {
    const db = openDb(':memory:');
    const a = post(db, '111111'); const b = post(db, '222222'); const c = post(db, '333333'); const d = post(db, '444444');
    mark(db, a.personId, 'unconfirmed');
    mark(db, b.personId, 'sending');
    mark(db, c.personId, 'no_dialog', new Date(NOW.getTime() - 3600_000).toISOString());
    const r = nextPosterContacts(db, cfg, 'linkedin', { minScore: 60, now: NOW });
    expect(r.map((x) => x.job_id)).toEqual([d.id]);
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60, jobId: c.id, now: NOW })).toEqual([]);
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60, jobId: a.id, now: NOW })).toEqual([]);
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60, jobId: d.id, now: NOW }).map((x) => x.job_id)).toEqual([d.id]);
    const h = handleNextContacts({ db, now: () => NOW }, { platform: 'linkedin', posters: true, limit: 5 }) as unknown as { job_id: string }[];
    expect(h.map((x) => x.job_id)).toEqual([d.id]);
  });
  it('a no_dialog poster below the retry limit stays eligible', () => {
    const db = openDb(':memory:');
    const a = post(db, '111111');
    db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status, no_dialog_count, released_at) VALUES (?, 'connect', 'k', 'no_dialog', 1, ?)").run(a.personId, new Date(NOW.getTime() - 3600_000).toISOString());
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60, now: NOW }).map((x) => x.job_id)).toEqual([a.id]);
  });
});

describe('nextPosterContacts', () => {
  it('returns the poster of a company-less post, with job context and no company', () => {
    const db = openDb(':memory:');
    const a = post(db, '111111');
    const r = nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ personId: a.personId, job_id: a.id, company: null, category: 'hiring_manager', profile_url: 'https://www.linkedin.com/in/poster-111111' });
    expect(r[0].post_text).toContain('React Developer');
  });

  it('never invents a company and applies no per-company limit without one', () => {
    const db = openDb(':memory:');
    for (const n of ['111111', '222222', '333333']) post(db, n);
    // two active people with the empty company key must not count as a company at its limit
    for (const n of ['111111', '222222']) db.prepare("UPDATE contact_state SET stage = 'active' WHERE person_id = (SELECT id FROM people WHERE profile_key = ?)").run(`linkedin.com/in/poster-${n}`);
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 }).map((c) => c.job_id)).toEqual(['li-post:333333']);
  });

  it('enforces the per-company limit and the company pause when the job has a company', () => {
    const db = openDb(':memory:');
    post(db, '111111', { company: 'Acme Corp' });
    for (const k of ['x', 'y']) {
      const id = upsertPerson(db, { platform: 'linkedin', profileKey: `linkedin.com/in/${k}`, company: 'Acme Corp', category: 'recruiter' });
      db.prepare("UPDATE contact_state SET stage = 'active' WHERE person_id = ?").run(id);
    }
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 })).toEqual([]);
    db.prepare("UPDATE contact_state SET stage = 'closed' WHERE person_id IN (SELECT id FROM people WHERE profile_key LIKE '%/x')").run();
    const r = nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 });
    expect(r).toHaveLength(1);
    expect(r[0].company).toBe('Acme Corp');
    db.prepare("UPDATE contact_state SET stage = 'replied_positive' WHERE person_id = (SELECT id FROM people WHERE profile_key LIKE '%/y')").run();
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 })).toEqual([]);
  });

  it('is once-only per person: a sending, sent or paused poster is not offered again', () => {
    const db = openDb(':memory:');
    const a = post(db, '111111');
    const b = post(db, '222222');
    const c = post(db, '333333');
    const key = (n: string) => `li:connect:linkedin.com/in/poster-${n}:abc`;
    const r1 = reserveTouch(db, { personId: a.personId, kind: 'connect', jobId: a.id, body: 'hi', key: key('111111'), now: NOW, dryRun: false });
    expect(r1.ok).toBe(true);
    // still 'sending': not offered even though the stage is still new
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 }).map((x) => x.personId)).toEqual([b.personId, c.personId]);
    if (r1.ok) finishTouch(db, r1.touchId, 'sent', NOW);
    // the ledger refuses a second connect for the same person
    const again = reserveTouch(db, { personId: a.personId, kind: 'connect', jobId: a.id, body: 'hi again', key: key('111111') + 'z', now: NOW, dryRun: false });
    expect(again.ok).toBe(false);
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 }).map((x) => x.personId)).toEqual([b.personId, c.personId]);
    db.prepare("UPDATE contact_state SET paused_reason = 'replied' WHERE person_id = ?").run(b.personId);
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 }).map((x) => x.personId)).toEqual([c.personId]);
  });

  it('one offer per person even when the same poster wrote two posts', () => {
    const db = openDb(':memory:');
    post(db, '111111');
    saveJob(db, { id: 'li-post:999999', source: 'linkedin-posts', title: 'Node Developer', company: '', url: 'https://www.linkedin.com/feed/update/urn:li:activity:999999/', apply_url: 'https://www.linkedin.com/feed/update/urn:li:activity:999999/', description: 'hiring', poster_url: 'https://www.linkedin.com/in/poster-111111/' });
    db.prepare('UPDATE jobs SET score = 90 WHERE id = ?').run('li-post:999999');
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 })).toHaveLength(1);
  });

  it('orders priority jobs first, then oldest first', () => {
    const db = openDb(':memory:');
    post(db, '111111');
    post(db, '222222');
    post(db, '333333', { priority: 1 });
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 }).map((x) => x.job_id)).toEqual(['li-post:333333', 'li-post:111111', 'li-post:222222']);
  });

  it('skips unscored, below-threshold, excluded and poster-less jobs and other platforms', () => {
    const db = openDb(':memory:');
    post(db, '111111', { score: null });
    post(db, '222222', { score: 40 });
    const ex = post(db, '333333');
    db.prepare("UPDATE jobs SET excluded_reason = 'location FAIL' WHERE id = ?").run(ex.id);
    post(db, '444444', { poster: null });
    const ok = post(db, '555555');
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 }).map((x) => x.job_id)).toEqual([ok.id]);
    expect(nextPosterContacts(db, cfg, 'naukri', { minScore: 60 })).toEqual([]);
  });

  it('job_id mode returns only that job poster; a non-post job returns nothing', () => {
    const db = openDb(':memory:');
    post(db, '111111');
    const b = post(db, '222222');
    saveJob(db, { id: 'x1', source: 'adzuna', title: 'T', company: '', url: 'u', apply_url: 'u', description: 'd', poster_url: 'https://www.linkedin.com/in/poster-111111/' });
    db.prepare('UPDATE jobs SET score = 90 WHERE id = ?').run('x1');
    expect(nextPosterContacts(db, cfg, 'linkedin', { jobId: b.id, minScore: 60 }).map((x) => x.job_id)).toEqual([b.id]);
    expect(nextPosterContacts(db, cfg, 'linkedin', { jobId: 'x1', minScore: 60 })).toEqual([]);
  });

  it('a poster whose job company was later resolved reports that company', () => {
    const db = openDb(':memory:');
    const a = post(db, '111111');
    db.prepare("UPDATE jobs SET company = 'Globex', company_key = 'globex' WHERE id = ?").run(a.id);
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 60 })[0].company).toBe('Globex');
  });
});

describe('next_contacts handler', () => {
  it('company_key path is unchanged and never returns a company-less poster', () => {
    const db = openDb(':memory:');
    post(db, '111111');
    expect(nextContactsForCompany(db, cfg, 'linkedin', 'Acme')).toEqual([]);
    expect(handleNextContacts({ db }, { platform: 'linkedin', company_key: 'Acme' })).toEqual([]);
  });
  it('posters mode and job_id mode return poster candidates; no selector is an error', () => {
    const db = openDb(':memory:');
    const a = post(db, '111111');
    post(db, '222222');
    expect(handleNextContacts({ db }, { platform: 'linkedin', posters: true })).toHaveLength(2);
    expect((handleNextContacts({ db }, { platform: 'linkedin', job_id: a.id }) as any[]).map((x) => x.job_id)).toEqual([a.id]);
    expect(() => handleNextContacts({ db }, { platform: 'linkedin' })).toThrow(/company_key|job_id|posters/);
  });
  it('honours limit', () => {
    const db = openDb(':memory:');
    post(db, '111111'); post(db, '222222'); post(db, '333333');
    expect(handleNextContacts({ db }, { platform: 'linkedin', posters: true, limit: 2 })).toHaveLength(2);
  });
});
