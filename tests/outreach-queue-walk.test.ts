import { describe, it, expect } from 'vitest';
import { openDb, saveJob } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { nextContactsForCompany, nextQueueContacts, addEscalation, MAX_COMPANY_FAILURES } from '../src/outreach/service.js';
import { markStaleSending, STALE_SENDING_MS } from '../src/linkedin/touches.js';
import { handleNextContacts, handleEscalate } from '../src/mcp/outreach.js';

type D = ReturnType<typeof openDb>;
const NOW = new Date('2026-10-26T10:00:00.000Z');
const cfg = { companyContactLimit: 2 };

/** A job at `company`, one person whose headline names it, and one queued connect row for that person. */
function seed(db: D, n: string, company: string, o: { headline?: string; priority?: number; score?: number; created?: string; person?: string } = {}) {
  saveJob(db, { id: `j${n}`, source: 'naukri', title: 'React Dev', company, url: `u${n}`, apply_url: `u${n}`, description: 'd', ...(o.priority ? { priority: o.priority } : {}) });
  db.prepare('UPDATE jobs SET score = ? WHERE id = ?').run(o.score ?? 80, `j${n}`);
  const slug = o.person ?? `p${n}`;
  const personId = upsertPerson(db, { platform: 'linkedin', profileKey: `linkedin.com/in/${slug}`, name: `Person ${slug}`, headline: o.headline ?? `Recruiter at ${company}`, company, category: 'recruiter' });
  db.prepare(
    `INSERT INTO outreach_queue (job_id, connect_note, connect_profile_url, connect_category, connect_company, status, created_at)
     VALUES (?, 'note', ?, 'recruiter', ?, 'queued', ?)`,
  ).run(`j${n}`, `https://www.linkedin.com/in/${slug}`, company, o.created ?? '2026-10-25 01:00:00');
  return { personId, jobId: `j${n}` };
}
const touch = (db: D, personId: number, status: string, createdAt = NOW.toISOString(), extra = {}) =>
  db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status, created_at) VALUES (?, 'connect', ?, ?, ?)").run(personId, `k${personId}${status}${Math.random()}`, status, createdAt) && extra;

describe('nextQueueContacts walks different companies', () => {
  it('returns one person per company, oldest queue row first, so quota k reaches k companies', () => {
    const db = openDb(':memory:');
    seed(db, '1', 'GitLab', { created: '2026-10-23 05:00:00' });
    seed(db, '2', 'GitLab', { created: '2026-10-23 05:01:00', person: 'p2b' });
    seed(db, '3', 'Softobiz', { created: '2026-10-25 02:00:00' });
    seed(db, '4', 'Xoriant', { created: '2026-10-26 01:00:00' });
    const r = nextQueueContacts(db, cfg, 'linkedin', { limit: 3, now: NOW });
    expect(r.map((x) => x.company)).toEqual(['GitLab', 'Softobiz', 'Xoriant']);
    expect(new Set(r.map((x) => x.company_key)).size).toBe(3);
    expect(r[0]).toMatchObject({ profile_url: 'https://www.linkedin.com/in/p1', queue_id: expect.any(Number), job_id: 'j1' });
  });

  it('a company whose people already failed goes behind fresh companies and is dropped after MAX failures', () => {
    const db = openDb(':memory:');
    const g1 = seed(db, '1', 'GitLab', { created: '2026-10-23 05:00:00' });
    seed(db, '2', 'Softobiz', { created: '2026-10-25 02:00:00' });
    touch(db, g1.personId, 'no_dialog', new Date(NOW.getTime() - 3600_000).toISOString());
    // g1 itself has one no_dialog (below the retry limit) so it is still eligible, but ordered after Softobiz
    expect(nextQueueContacts(db, cfg, 'linkedin', { limit: 5, now: NOW }).map((x) => x.company)).toEqual(['Softobiz', 'GitLab']);
    for (let i = 0; i < MAX_COMPANY_FAILURES; i++) {
      const p = upsertPerson(db, { platform: 'linkedin', profileKey: `linkedin.com/in/other${i}`, name: `O${i}`, headline: 'Engineer at GitLab', company: 'GitLab', category: 'peer' });
      touch(db, p, 'refused', new Date(NOW.getTime() - 3600_000).toISOString());
    }
    expect(nextQueueContacts(db, cfg, 'linkedin', { limit: 5, now: NOW }).map((x) => x.company)).toEqual(['Softobiz']);
  });

  it('exclude_company_keys skips companies already tried this wake', () => {
    const db = openDb(':memory:');
    seed(db, '1', 'GitLab'); seed(db, '2', 'Softobiz');
    const r = nextQueueContacts(db, cfg, 'linkedin', { limit: 5, now: NOW, excludeCompanyKeys: ['gitlab'] });
    expect(r.map((x) => x.company)).toEqual(['Softobiz']);
  });

  it('priority jobs first; excluded jobs and sent people are never offered', () => {
    const db = openDb(':memory:');
    seed(db, '1', 'Old', { created: '2026-10-20 00:00:00' });
    seed(db, '2', 'Prio', { priority: 1, created: '2026-10-26 00:00:00' });
    const x = seed(db, '3', 'Excl'); db.prepare("UPDATE jobs SET excluded_reason = 'veto' WHERE id = ?").run(x.jobId);
    const s = seed(db, '4', 'Sent'); touch(db, s.personId, 'sent');
    expect(nextQueueContacts(db, cfg, 'linkedin', { limit: 5, now: NOW }).map((r) => r.company)).toEqual(['Prio', 'Old']);
  });

  it('handleNextContacts exposes it as queue: true', () => {
    const db = openDb(':memory:');
    seed(db, '1', 'GitLab');
    const r = handleNextContacts({ db, now: () => NOW }, { platform: 'linkedin', queue: true, limit: 3 }) as unknown as { company: string }[];
    expect(r.map((x) => x.company)).toEqual(['GitLab']);
  });
});

describe('employer mismatch is remembered', () => {
  it('a person whose headline names another employer is never offered (company path and queue path)', () => {
    const db = openDb(':memory:');
    const a = seed(db, '1', 'GitLab', { headline: 'Recruiter at Acme' });
    expect(a.personId).toBeGreaterThan(0);
    expect(nextContactsForCompany(db, cfg, 'linkedin', 'gitlab', NOW)).toEqual([]);
    expect(nextQueueContacts(db, cfg, 'linkedin', { limit: 3, now: NOW })).toEqual([]);
  });
  it('escalating a person with an employer/profile mismatch reason pauses them', async () => {
    const db = openDb(':memory:');
    const a = seed(db, '1', 'GitLab');
    expect(nextContactsForCompany(db, cfg, 'linkedin', 'gitlab', NOW)).toHaveLength(1);
    await handleEscalate({ db, now: () => NOW, screen: async (t) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' }) as never }, { platform: 'linkedin', person_id: a.personId, reason: 'employer_mismatch' });
    expect(nextContactsForCompany(db, cfg, 'linkedin', 'gitlab', NOW)).toEqual([]);
    expect(nextQueueContacts(db, cfg, 'linkedin', { limit: 3, now: NOW })).toEqual([]);
  });
  it('an unrelated escalation does not pause', () => {
    const db = openDb(':memory:');
    const a = seed(db, '1', 'GitLab');
    addEscalation(db, { runId: null, platform: 'linkedin', personId: a.personId, reason: 'no_dialog_after_connect' }, NOW);
    expect(nextContactsForCompany(db, cfg, 'linkedin', 'gitlab', NOW)).toHaveLength(1);
  });
});

describe('stale sending touches', () => {
  it('sending older than 30 minutes becomes unconfirmed (never re-sent), younger stays; only that person is blocked', () => {
    const db = openDb(':memory:');
    const a = seed(db, '1', 'GitLab', { person: 'a' });
    const b = upsertPerson(db, { platform: 'linkedin', profileKey: 'linkedin.com/in/b', name: 'B', headline: 'Engineer at GitLab', company: 'GitLab', category: 'peer' });
    touch(db, a.personId, 'sending', new Date(NOW.getTime() - STALE_SENDING_MS - 60_000).toISOString());
    const fresh = upsertPerson(db, { platform: 'linkedin', profileKey: 'linkedin.com/in/c', name: 'C', headline: 'Engineer at GitLab', company: 'GitLab', category: 'peer' });
    touch(db, fresh, 'sending', new Date(NOW.getTime() - 60_000).toISOString());
    expect(markStaleSending(db, NOW)).toBe(1);
    const st = (id: number) => (db.prepare('SELECT status FROM touches WHERE person_id = ?').get(id) as { status: string }).status;
    expect(st(a.personId)).toBe('unconfirmed');
    expect(st(fresh)).toBe('sending');
    expect(markStaleSending(db, NOW)).toBe(0);
    const offered = nextContactsForCompany(db, cfg, 'linkedin', 'gitlab', NOW).map((x) => x.personId);
    expect(offered).toContain(b);
    expect(offered).not.toContain(a.personId);
    expect(offered).not.toContain(fresh);
  });
});
