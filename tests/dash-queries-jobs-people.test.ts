// tests/dash-queries-jobs-people.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';
import { listJobs, jobCounts, jobDetail } from '../src/dash/queries/jobs.js';
import { funnelStats } from '../src/funnel.js';
import { listPeople, personThread } from '../src/dash/queries/people.js';

let db: BetterSqlite3.Database;
function job(id: string, o: Record<string, unknown> = {}) {
  const r: Record<string, unknown> = { source: 'remotive', title: `Title ${id}`, company: `Co ${id}`, score: 80, excluded_reason: null, description: 'SECRET DESC', jd_snapshot: 'SECRET SNAP', ...o };
  db.prepare('INSERT INTO jobs (id, source, title, company, score, excluded_reason, description, jd_snapshot, strengths, gaps, requirements) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, r.source, r.title, r.company, r.score, r.excluded_reason, r.description, r.jd_snapshot, r.strengths ?? null, r.gaps ?? null, r.requirements ?? null);
}
beforeEach(() => { db = openDb(':memory:'); migrateOutreachTables(db); });

describe('jobs queries', () => {
  it('counts buckets and a job can sit in several', () => {
    job('a'); job('b', { score: 30 }); job('c', { excluded_reason: 'vetoed' }); job('d'); job('e');
    db.prepare("INSERT INTO applications (job_id, status) VALUES ('a','submitted')").run();
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('a','queued')").run();
    db.prepare("INSERT INTO applications (job_id, status) VALUES ('d','failed')").run();
    db.prepare("INSERT INTO applications (job_id, status) VALUES ('e','needs_answer')").run();
    expect(jobCounts(db, 60)).toEqual({ discovered: 5, matched: 3, applied: 1, pending: 2, failed: 1 });
    const a = listJobs(db, { bucket: 'applied', threshold: 60 }).items;
    expect(a.map((j) => j.id)).toEqual(['a']);
    expect(a[0].bucket).toEqual(expect.arrayContaining(['discovered', 'matched', 'applied', 'pending']));
    expect(listJobs(db, { bucket: 'failed', threshold: 60 }).items.map((j) => j.id)).toEqual(['d']);
  });
  it('matched agrees with funnelStats for an excluded but contacted job', () => {
    job('a', { excluded_reason: 'vetoed' }); job('b', { excluded_reason: 'vetoed' }); job('c');
    db.prepare("INSERT INTO outreach_queue (job_id, status, email_status) VALUES ('a','done','sent')").run();
    expect(jobCounts(db, 60).matched).toBe(funnelStats(db, 60).matched);
    expect(jobCounts(db, 60).matched).toBe(2);
    expect(listJobs(db, { bucket: 'matched', threshold: 60 }).items.map((j) => j.id).sort()).toEqual(['a', 'c']);
  });
  it('q matches % literally', () => {
    job('a', { title: '100% Remote' }); job('b', { title: 'Plain' });
    expect(listJobs(db, { q: '%' }).items.map((j) => j.id)).toEqual(['a']);
    expect(listJobs(db, { q: '100% R' }).items.map((j) => j.id)).toEqual(['a']);
  });
  it('clamps limit to 100', () => {
    const ins = db.prepare('INSERT INTO jobs (id, title, company) VALUES (?,?,?)');
    for (let i = 0; i < 120; i++) ins.run(`j${i}`, 't', 'c');
    expect(listJobs(db, { limit: 1000 }).items.length).toBe(100);
  });
  it('cursor paging is disjoint and terminates', () => {
    for (const i of ['a', 'b', 'c']) job(i);
    const p1 = listJobs(db, { limit: 2 });
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = listJobs(db, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.length).toBe(1);
    expect(p2.nextCursor).toBeNull();
    const ids = [...p1.items, ...p2.items].map((j) => j.id);
    expect(new Set(ids).size).toBe(3);
  });
  it('cleans untrusted text and never returns description or snapshot', () => {
    job('a', { company: 'Evil‮txt', title: 'x‮y', strengths: '["s1"]', gaps: 'not json', requirements: '["r"]' });
    const l = listJobs(db, {}).items[0];
    expect(l.title).toBe('xy');
    expect(l.company).toBe('Eviltxt');
    const d = jobDetail(db, 'a')!;
    expect(d.strengths).toEqual(['s1']);
    expect(d.gaps).toEqual([]);
    const all = JSON.stringify([l, d]);
    expect(all).not.toContain('SECRET');
    expect('description' in d).toBe(false);
    expect('jd_snapshot' in d).toBe(false);
  });
  it('returns HTML-looking text verbatim as inert data (escaping is the renderer job)', () => {
    job('a', { company: '<b>Evil</b>' });
    expect(listJobs(db, {}).items[0].company).toBe('<b>Evil</b>');
  });
  it('detail joins queue, applications, outcomes; unknown id is null', () => {
    job('a');
    db.prepare("INSERT INTO outreach_queue (job_id, status, email_status, ats_coverage, email_body) VALUES ('a','queued','sent',70,'BODYTEXT')").run();
    db.prepare("INSERT INTO applications (job_id, platform, status) VALUES ('a','greenhouse','submitted')").run();
    db.prepare("INSERT INTO job_outcomes (job_id, outcome) VALUES ('a','replied')").run();
    const d = jobDetail(db, 'a')!;
    expect(d.queue[0]).toMatchObject({ status: 'queued', email_status: 'sent', ats_coverage: 70 });
    expect(d.applications[0]).toMatchObject({ platform: 'greenhouse', status: 'submitted' });
    expect(d.outcomes[0].outcome).toBe('replied');
    expect(JSON.stringify(d)).not.toContain('BODYTEXT');
    expect(jobDetail(db, 'nope')).toBeNull();
  });
  it('tolerates missing tables', () => {
    const bare = openDb(':memory:');
    bare.exec('DROP TABLE jobs; DROP TABLE applications; DROP TABLE outreach_queue; DROP TABLE job_outcomes;');
    expect(listJobs(bare, {})).toEqual({ items: [], nextCursor: null });
    expect(jobCounts(bare, 60)).toEqual({ discovered: 0, matched: 0, applied: 0, pending: 0, failed: 0 });
    expect(jobDetail(bare, 'a')).toBeNull();
    const half = openDb(':memory:');
    half.exec('DROP TABLE applications; DROP TABLE outreach_queue; DROP TABLE job_outcomes;');
    half.prepare("INSERT INTO jobs (id, title, company, score) VALUES ('a','t','c',90)").run();
    expect(listJobs(half, { bucket: 'applied' }).items).toEqual([]);
    expect(listJobs(half, {}).items.length).toBe(1);
    expect(jobDetail(half, 'a')!.queue).toEqual([]);
  });
});

describe('people queries', () => {
  function person(id: number, name: string, stage = 'active') {
    db.prepare('INSERT INTO people (id, platform, profile_key, name, company, company_key, category) VALUES (?,?,?,?,?,?,?)').run(id, 'linkedin', `k${id}`, name, `Co${id}`, `co${id}`, 'recruiter');
    db.prepare('INSERT INTO contact_state (person_id, stage) VALUES (?,?)').run(id, stage);
  }
  it('lists, filters by stage and q, pages', () => {
    person(1, 'Ann'); person(2, '50% Bob', 'closed'); person(3, 'Cy');
    expect(listPeople(db, {}).items.map((p) => p.id)).toEqual([3, 2, 1]);
    expect(listPeople(db, { stage: 'closed' }).items.map((p) => p.id)).toEqual([2]);
    expect(listPeople(db, { q: '%' }).items.map((p) => p.id)).toEqual([2]);
    const p1 = listPeople(db, { limit: 2 });
    expect(p1.nextCursor).toBe(2);
    const p2 = listPeople(db, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((p) => p.id)).toEqual([1]);
    expect(p2.nextCursor).toBeNull();
    expect(listPeople(db, { limit: 5000 }).items.length).toBe(3);
  });
  it('thread returns touches, cleaned; unknown person null', () => {
    person(1, 'Ann');
    const ins = db.prepare("INSERT INTO touches (person_id, job_id, kind, body, idempotency_key, status) VALUES (1,'j',?,?,?,?)");
    ins.run('connect', 'hi‮ there', 'k1', 'sent'); ins.run('followup', 'again', 'k2', 'queued');
    const t = personThread(db, 1, { limit: 1 })!;
    expect(t.person.name).toBe('Ann');
    expect(t.touches.items.length).toBe(1);
    expect(t.touches.nextCursor).not.toBeNull();
    const t2 = personThread(db, 1, { cursor: t.touches.nextCursor })!;
    expect(t2.touches.items[0].body).toBe('hi there');
    expect(t2.touches.nextCursor).toBeNull();
    expect(personThread(db, 99, {})).toBeNull();
  });
  it('tolerates missing tables', () => {
    const bare = openDb(':memory:');
    expect(listPeople(bare, {})).toEqual({ items: [], nextCursor: null });
    expect(personThread(bare, 1, {})).toBeNull();
  });
});
