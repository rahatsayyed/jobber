import { describe, it, expect } from 'vitest';
import { openDb, saveJob, listUnscoredJobs, type Job } from '../src/db.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { countDue } from '../src/scheduler/due.js';
import { PIPELINE_LIST_PAGE, PIPELINE_MAX_JOBS_PER_WAKE_CEILING, PIPELINE_WINDOW_HOURS } from '../src/scheduler/plan.js';
import { planPipelineWork, sqlTime } from '../src/pipelineWork.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const ago = (hours: number): string => sqlTime(new Date(NOW.getTime() - hours * 3600_000));
const agoDays = (days: number): string => ago(days * 24);

type Db = ReturnType<typeof openDb>;

function add(db: Db, id: string, o: { source?: string; company?: string; title?: string; apply_url?: string; at?: string } = {}): void {
  const job: Job = {
    id, source: o.source ?? 'greenhouse', title: o.title ?? 'React Developer', company: o.company ?? 'Acme',
    url: `https://x.test/${id}`, apply_url: o.apply_url ?? 'https://boards.greenhouse.io/acme/jobs/1', description: 'Location: Remote\n\nbody',
  };
  saveJob(db, job);
  db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(o.at ?? ago(1), id);
}
const ids = (db: Db, o: Parameters<typeof listUnscoredJobs>[1] = {}): string[] => listUnscoredJobs(db, { now: NOW, ...o }).map((r) => r.id);
const status = (db: Db, id: string): string | null => (db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: string | null }).status;

describe('pipeline window', () => {
  it('offers a job saved an hour inside the window and not one an hour outside it (seven days)', () => {
    const db = openDb(':memory:');
    add(db, 'in', { company: 'A', at: ago(PIPELINE_WINDOW_HOURS - 1) });
    add(db, 'out', { company: 'B', at: ago(PIPELINE_WINDOW_HOURS + 1) });
    expect(PIPELINE_WINDOW_HOURS).toBe(168);
    expect(ids(db, { kind: 'unscored' })).toEqual(['in']);
    expect(countDue(db, NOW, loadTuning({}), {}).unmatchedJobs).toBe(1);
  });
  it('is not a fixed count: 150 jobs of the window are all listed, in pages that end on a short page', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 150; i++) add(db, `j${i}`, { company: `Co${i}`, at: ago(2) });
    const seen: string[] = [];
    let pages = 0;
    for (let offset = 0; ; offset += PIPELINE_LIST_PAGE) {
      const page = ids(db, { kind: 'unscored', limit: PIPELINE_LIST_PAGE, offset });
      pages++;
      seen.push(...page);
      if (page.length < PIPELINE_LIST_PAGE) break;
    }
    expect(seen).toHaveLength(150);
    expect(new Set(seen).size).toBe(150);
    expect(pages).toBe(8); // 7 full pages and one of 10
    expect(countDue(db, NOW, loadTuning({}), {}).unmatchedJobs).toBe(150);
  });
  it('does not window already matched jobs: a matched job older than a day is still offered for preparation', () => {
    const db = openDb(':memory:');
    add(db, 'old-matched', { company: 'M', at: agoDays(5) });
    db.prepare('UPDATE jobs SET score = 80 WHERE id = ?').run('old-matched');
    expect(ids(db, { kind: 'matched', matchThreshold: 60 })).toEqual(['old-matched']);
  });
  it('stops at the safety ceiling: nothing past the ceiling is listed and the last page is clipped', () => {
    const db = openDb(':memory:');
    const n = PIPELINE_MAX_JOBS_PER_WAKE_CEILING + 15;
    const ins = db.prepare("INSERT INTO jobs (id, source, title, company, title_key, company_key, created_at) VALUES (?, 'greenhouse', ?, ?, ?, ?, ?)");
    db.transaction(() => { for (let i = 0; i < n; i++) ins.run(`c${i}`, `T${i}`, `C${i}`, `t${i}`, `c${i}`, ago(1)); })();
    expect(PIPELINE_MAX_JOBS_PER_WAKE_CEILING).toBe(400);
    expect(ids(db, { kind: 'unscored', limit: 20, offset: 380 })).toHaveLength(20);
    expect(ids(db, { kind: 'unscored', limit: 20, offset: 395 })).toHaveLength(5);
    expect(ids(db, { kind: 'unscored', limit: 20, offset: 400 })).toEqual([]);
  });
});

describe('pipeline duplicates', () => {
  it('of the same posting from two sources only the ATS-hosted one is offered, the other is marked duplicate and kept', () => {
    const db = openDb(':memory:');
    add(db, 'agg', { source: 'remotive', apply_url: 'https://acme.example/j', at: ago(5) }); // older, but not an ATS host
    add(db, 'ats', { source: 'greenhouse', at: ago(2) });
    expect(ids(db, { kind: 'unscored' })).toEqual(['ats']);
    expect(status(db, 'agg')).toBe('duplicate');
    expect(status(db, 'ats')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 2 });
    expect(ids(db, { kind: 'unscored' })).toEqual(['ats']); // stable on the next call
  });
  it('with no ATS host in the group the oldest wins', () => {
    const db = openDb(':memory:');
    add(db, 'newer', { source: 'remotive', apply_url: 'https://acme.example/n', at: ago(2) });
    add(db, 'older', { source: 'remoteok', apply_url: 'https://acme.example/o', at: ago(9) });
    expect(ids(db, { kind: 'unscored' })).toEqual(['older']);
    expect(status(db, 'newer')).toBe('duplicate');
  });
  it('title and company are compared by key, so casing and a legal suffix do not hide a duplicate', () => {
    const db = openDb(':memory:');
    add(db, 'a', { company: 'Acme Inc', title: 'React Developer', at: ago(4) });
    add(db, 'b', { source: 'lever', company: 'ACME', title: 'developer react', at: ago(3), apply_url: 'https://jobs.lever.co/acme/1' });
    expect(ids(db, { kind: 'unscored' })).toHaveLength(1);
  });
  it('a job whose twin is already scored is a duplicate, even from another source', () => {
    const db = openDb(':memory:');
    add(db, 'scored', { at: agoDays(3) });
    db.prepare('UPDATE jobs SET score = 30 WHERE id = ?').run('scored');
    add(db, 'twin', { source: 'lever', apply_url: 'https://jobs.lever.co/acme/2', at: ago(1) });
    expect(ids(db, { kind: 'unscored' })).toEqual([]);
    expect(status(db, 'twin')).toBe('duplicate');
  });
  it('different companies or titles are not duplicates', () => {
    const db = openDb(':memory:');
    add(db, 'a', { company: 'Acme', title: 'React Developer' });
    add(db, 'b', { company: 'Globex', title: 'React Developer' });
    add(db, 'c', { company: 'Acme', title: 'Staff Backend Engineer' });
    expect(ids(db, { kind: 'unscored' }).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('pipeline repeated contact', () => {
  it('skips a job whose company and title already has an outreach row, with the reason in jobs.status', () => {
    const db = openDb(':memory:');
    add(db, 'done', { at: agoDays(10) });
    db.prepare("UPDATE jobs SET score = 80 WHERE id = 'done'").run();
    db.prepare("INSERT INTO outreach_queue (job_id, status, email_status) VALUES ('done', 'queued', 'sent')").run();
    add(db, 'again', { source: 'lever', apply_url: 'https://jobs.lever.co/acme/3', at: ago(1) });
    expect(ids(db, { kind: 'unscored' })).toEqual([]);
    expect(status(db, 'again')).toBe('repeat_contact');
    const plan = planPipelineWork(openDb(':memory:'), { now: NOW, failLimit: 2 });
    expect(plan).toEqual({ offer: [], matchedOffer: [], skips: [] });
  });
  it('a connection or an application on file counts the same', () => {
    const db = openDb(':memory:');
    add(db, 'c1', { company: 'ConnCo' });
    db.prepare("UPDATE jobs SET score = 70 WHERE id = 'c1'").run();
    db.prepare("INSERT INTO connections (job_id, company, status) VALUES ('c1', 'ConnCo', 'sent')").run();
    add(db, 'c2', { company: 'ConnCo', source: 'lever', apply_url: 'https://jobs.lever.co/c/1' });
    add(db, 'a1', { company: 'AppCo' });
    db.prepare("UPDATE jobs SET score = 70 WHERE id = 'a1'").run();
    db.prepare("INSERT INTO applications (job_id, platform, status) VALUES ('a1', 'greenhouse', 'submitted')").run();
    add(db, 'a2', { company: 'AppCo', source: 'lever', apply_url: 'https://jobs.lever.co/a/1' });
    expect(ids(db, { kind: 'unscored' })).toEqual([]);
    expect(status(db, 'c2')).toBe('repeat_contact');
    expect(status(db, 'a2')).toBe('repeat_contact');
  });
  it('a contact older than 90 days does not block the job', () => {
    const db = openDb(':memory:');
    add(db, 'old', { at: agoDays(120) });
    db.prepare("UPDATE jobs SET score = 80 WHERE id = 'old'").run();
    db.prepare('INSERT INTO outreach_queue (job_id, status, email_status, created_at) VALUES (?, ?, ?, ?)').run('old', 'sent', 'sent', agoDays(100));
    add(db, 'new', { source: 'lever', apply_url: 'https://jobs.lever.co/acme/4', at: ago(1) });
    expect(ids(db, { kind: 'unscored' })).toEqual(['new']);
  });
  it('a skipped queue row is not a contact', () => {
    const db = openDb(':memory:');
    add(db, 's', { at: agoDays(10) }); // unscored and outside the window, so neither a duplicate source nor offered itself
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('s', 'skipped')").run();
    add(db, 'n', { source: 'lever', apply_url: 'https://jobs.lever.co/acme/5', at: ago(1) });
    expect(ids(db, { kind: 'unscored' })).toEqual(['n']);
  });
  it('a matched job without an outreach row is dropped from the carry-over once a twin was contacted', () => {
    const db = openDb(':memory:');
    add(db, 'pending', { at: agoDays(2) });
    db.prepare("UPDATE jobs SET score = 75 WHERE id = 'pending'").run();
    add(db, 'twin', { source: 'lever', apply_url: 'https://jobs.lever.co/acme/6', at: agoDays(2) });
    db.prepare("UPDATE jobs SET score = 75 WHERE id = 'twin'").run();
    db.prepare("INSERT INTO outreach_queue (job_id, status, email_status) VALUES ('twin', 'queued', 'sent')").run();
    expect(ids(db, { kind: 'matched', matchThreshold: 60 })).toEqual([]);
    expect(status(db, 'pending')).toBe('repeat_contact');
  });
  it('countDue plans the pipeline only for real work and writes nothing', () => {
    const db = openDb(':memory:');
    add(db, 'done', { at: agoDays(10) });
    db.prepare("UPDATE jobs SET score = 80 WHERE id = 'done'").run();
    db.prepare("INSERT INTO outreach_queue (job_id, status, email_status) VALUES ('done', 'queued', 'sent')").run();
    add(db, 'dup1', { source: 'lever', apply_url: 'https://jobs.lever.co/acme/7', at: ago(1) });
    add(db, 'real', { company: 'Other', at: ago(1) });
    add(db, 'stale', { company: 'Third', at: ago(PIPELINE_WINDOW_HOURS + 6) });
    expect(countDue(db, NOW, loadTuning({}), {}).unmatchedJobs).toBe(1);
    expect(status(db, 'dup1')).toBeNull();
  });
});
