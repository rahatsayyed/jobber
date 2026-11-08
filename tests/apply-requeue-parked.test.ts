import { describe, it, expect } from 'vitest';
import { enqueueOutreach, openDb, saveJob } from '../src/db.js';
import { run } from '../scripts/apply-requeue-parked.js';

const ENV = { APPLY_SUBMIT_MODE: 'submit', APPLY_ALLOW_UNKNOWN_HOSTS: 'true' } as NodeJS.ProcessEnv;

function seed(db: ReturnType<typeof openDb>, id: string, platform: string, url: string, status: string, note: string | null, source = 'remotive') {
  saveJob(db, { id, source, title: id, company: id, url: `https://x.example/${id}`, apply_url: url, description: 'd', posted_at: null } as any);
  enqueueOutreach(db, { job_id: id, resume_pdf_path: '/x.pdf', email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: platform, apply_tier: 'agent', apply_url: url, resume_json: '{}' } as any);
  db.prepare('UPDATE outreach_queue SET apply_status = ?, apply_note = ? WHERE job_id = ?').run(status, note, id);
}

function build() {
  const db = openDb(':memory:');
  seed(db, 'a', 'greenhouse', 'https://boards.greenhouse.io/a/jobs/1', 'manual_review', null);
  seed(db, 'b', 'browser', 'https://careers.acme-corp.io/job/2', 'needs_owner', '');
  seed(db, 'c', 'lever', 'https://jobs.lever.co/c/3', 'needs_owner', 'captcha'); // has a note
  seed(db, 'd', 'greenhouse', 'https://boards.greenhouse.io/d/jobs/4', 'manual_review', null); // already applied
  db.prepare("INSERT INTO applications (job_id, platform, status) VALUES ('d','greenhouse','manual_review')").run();
  seed(db, 'e', 'greenhouse', 'https://boards.greenhouse.io/e/jobs/5', 'manual_review', null); // excluded
  db.prepare("UPDATE jobs SET excluded_reason = 'role: x' WHERE id = 'e'").run();
  seed(db, 'f', 'greenhouse', 'https://boards.greenhouse.io/f/jobs/6', 'manual_review', null); // outcome
  db.prepare("INSERT INTO job_outcomes (job_id, outcome) VALUES ('f','rejected')").run();
  seed(db, 'g', 'workday', 'https://x.wd1.myworkdayjobs.com/g', 'manual_review', null, 'workday'); // discover-only source: parked again
  db.prepare("UPDATE outreach_queue SET apply_platform = 'workday' WHERE job_id = 'g'").run(); // enqueue forces none, old rows kept the platform
  seed(db, 'h', 'greenhouse', 'https://boards.greenhouse.io/h/jobs/8', 'manual_review', null);
  seed(db, 'i', 'naukri', 'https://www.naukri.com/job-listings-9', 'manual_review', null); // other platform
  return db;
}
const state = (db: ReturnType<typeof openDb>) => db.prepare('SELECT job_id, apply_status, apply_note FROM outreach_queue ORDER BY job_id').all();

describe('apply:requeue-parked', () => {
  it('dry (default) writes nothing and reports', () => {
    const db = build();
    const before = state(db);
    const r = run([], { db, env: ENV });
    expect(r.lines.join('\n')).toContain('dry: would release 3');
    expect(r.lines.join('\n')).toContain('would be parked again: workday');
    expect(run(['--dry'], { db, env: ENV }).code).toBe(0);
    expect(state(db)).toEqual(before);
  });

  it('--yes releases eligible rows only, then is idempotent', () => {
    const db = build();
    expect(run(['--yes'], { db, env: ENV }).lines.join('\n')).toContain('released 3');
    const s = Object.fromEntries((state(db) as any[]).map((x) => [x.job_id, x.apply_status]));
    expect(s).toEqual({ a: null, b: null, c: 'needs_owner', d: 'manual_review', e: 'manual_review', f: 'manual_review', g: 'manual_review', h: null, i: 'manual_review' });
    expect(run(['--yes'], { db, env: ENV }).lines.join('\n')).toContain('released 0');
  });

  it('respects --limit and --platform, rejects bad args', () => {
    const db = build();
    expect(run(['--yes', '--limit', '2'], { db, env: ENV }).lines.join('\n')).toContain('released 2');
    expect((db.prepare('SELECT COUNT(*) n FROM outreach_queue WHERE apply_status IS NULL').get() as any).n).toBe(2);
    expect(run(['--yes', '--platform', 'greenhouse'], { db, env: ENV }).lines.join('\n')).toContain('released 1');
    expect(run(['--platform', 'naukri'], { db, env: ENV }).code).toBe(2);
    expect(run(['--limit', '0'], { db, env: ENV }).code).toBe(2);
    expect(run(['--yes', '--dry'], { db, env: ENV }).code).toBe(2);
    expect(run(['--x'], { db, env: ENV }).code).toBe(2);
  });

  it('a company-site row is "parked again" when unknown hosts are not allowed', () => {
    const db = build();
    const r = run(['--yes', '--platform', 'browser'], { db, env: {} as NodeJS.ProcessEnv });
    expect(r.lines.join('\n')).toContain('released 0');
    expect(r.lines.join('\n')).toContain('would be parked again: browser');
  });
});
