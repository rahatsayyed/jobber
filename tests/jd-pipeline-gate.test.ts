// The JD gate in the pipeline: a job from a snippet-only source (Naukri, LinkedIn jobs) is not offered, matched, prepared or queued until its full
// job description was fetched. Boards and APIs are unchanged. Rows are never deleted; status jd_pending marks the waiting ones.
import { describe, expect, it } from 'vitest';
import {
  enqueueOutreach, listQueuedOutreach, listQueuedOutreachCompact, listUnscoredJobs, openDb, saveJob, saveMatchResultsChecked, type Job,
} from '../src/db.js';
import { sqlTime, planPipelineWork } from '../src/pipelineWork.js';
import { jdBlocksPrepare, jdStats, markJdPending, saveFetchedJd } from '../src/jdStore.js';
import { countDue } from '../src/scheduler/due.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { composeManualReport } from '../src/manual/report.js';
import { pickDripItem } from '../src/scheduler/mailDrip.js';
import { easyApplyRows } from '../src/scheduler/linkedinDrip.js';
import { FULL_JD } from './helpers/jdFixtures.js';

type Db = ReturnType<typeof openDb>;
const NOW = new Date('2026-10-15T12:00:00.000Z');
const ago = (hours: number): string => sqlTime(new Date(NOW.getTime() - hours * 3600_000));

function add(db: Db, id: string, o: { source?: string; desc?: string; company?: string; title?: string; at?: string; priority?: number; score?: number } = {}): void {
  const job: Job = {
    id, source: o.source ?? 'naukri', title: o.title ?? `React Developer ${id}`, company: o.company ?? `Co ${id}`,
    url: `https://www.naukri.com/job-listings-react-developer-${id}-0123456789${id.length}`, apply_url: `https://www.naukri.com/job-listings-react-developer-${id}-0123456789${id.length}`,
    description: o.desc ?? 'India (Remote)', ...(o.priority ? { priority: o.priority } : {}),
  };
  saveJob(db, job);
  db.prepare('UPDATE jobs SET created_at = ?, score = ? WHERE id = ?').run(o.at ?? ago(2), o.score ?? null, id);
}
const status = (db: Db, id: string): string | null => (db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: string | null }).status;
const row = (db: Db, id: string) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown>;
const unscored = (db: Db, o: Parameters<typeof listUnscoredJobs>[1] = {}) => listUnscoredJobs(db, { now: NOW, kind: 'unscored', ...o });

describe('list_unscored_jobs: the unscored list', () => {
  it('does not offer a Naukri or LinkedIn-jobs job with an incomplete JD, marks it jd_pending, and offers boards and full JDs as before', () => {
    const db = openDb(':memory:');
    add(db, 'nk-snippet', { source: 'naukri' });
    add(db, 'li-snippet', { source: 'linkedin-jobs', desc: 'Pune' });
    add(db, 'nk-full', { source: 'naukri', desc: FULL_JD });
    add(db, 'remoteok', { source: 'remoteok', desc: 'd' });
    add(db, 'gh', { source: 'greenhouse', desc: 'Location: Remote\n\nshort board text' });
    const ids = unscored(db).map((j) => j.id).sort();
    expect(ids).toEqual(['gh', 'nk-full', 'remoteok']);
    expect(status(db, 'nk-snippet')).toBe('jd_pending');
    expect(status(db, 'li-snippet')).toBe('jd_pending');
    expect(status(db, 'nk-full')).toBeNull();
    expect(status(db, 'remoteok')).toBeNull();
    // rows are kept, and a second listing is stable
    expect((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(5);
    expect(unscored(db).map((j) => j.id).sort()).toEqual(['gh', 'nk-full', 'remoteok']);
  });

  it('the planner count (countDue) agrees with the listing and marks nothing', () => {
    const db = openDb(':memory:');
    add(db, 'a'); add(db, 'b', { source: 'linkedin-jobs' }); add(db, 'c', { desc: FULL_JD }); add(db, 'd', { source: 'remotive', desc: 'x' });
    const due = countDue(db, NOW, loadTuning({}), {});
    expect(due.unmatchedJobs).toBe(2);
    expect(status(db, 'a')).toBeNull();
    const work = planPipelineWork(db, { now: NOW, failLimit: 2 });
    expect(work.skips.filter((s) => s.reason === 'jd_pending').map((s) => s.job_id).sort()).toEqual(['a', 'b']);
    expect(due.jdWaiting).toEqual({ naukri: 1, linkedin: 1 });
  });

  it('a JD that arrives returns the job to unscored, cleared of its old score, even when it is older than the window', () => {
    const db = openDb(':memory:');
    add(db, 'old', { at: ago(24 * 20), score: 77 });
    db.prepare("UPDATE jobs SET match_reasons = 'title only', requirements = '[]', prep_offers = 3, match_fails = 1 WHERE id = 'old'").run();
    expect(markJdPending(db, 'old')).toBe(true);
    const r = saveFetchedJd(db, 'old', FULL_JD, NOW);
    expect(r).toEqual({ saved: true, reset: true });
    expect(row(db, 'old')).toMatchObject({ status: null, score: null, match_reasons: null, requirements: null, prep_offers: 0, match_fails: 0, description: FULL_JD });
    expect(unscored(db).map((j) => j.id)).toEqual(['old']);
    expect(unscored(db)[0].description).toContain('full stack engineer');
  });

  it('refuses to store an incomplete text as the JD', () => {
    const db = openDb(':memory:');
    add(db, 'x');
    expect(saveFetchedJd(db, 'x', 'too short', NOW)).toEqual({ saved: false, reset: false });
    expect(saveFetchedJd(db, 'x', `${FULL_JD}...`, NOW)).toEqual({ saved: false, reset: false });
    expect(row(db, 'x').description).toBe('India (Remote)');
  });
});

describe('list_unscored_jobs: the matched list and manual priority jobs', () => {
  it('does not hand back a matched job whose score was a title guess; a matched job with a full JD still comes back', () => {
    const db = openDb(':memory:');
    add(db, 'guess', { score: 80 });
    add(db, 'real', { score: 80, desc: FULL_JD });
    const m = listUnscoredJobs(db, { now: NOW, kind: 'matched', matchThreshold: 3 });
    expect(m.map((j) => j.id)).toEqual(['real']);
    expect(m[0].already_matched).toBe(true);
    expect(status(db, 'guess')).toBe('jd_pending');
  });

  it('a manual priority job also waits for its JD, and is offered first once it has it', () => {
    const db = openDb(':memory:');
    add(db, 'manual', { source: 'manual:naukri', priority: 1 });
    add(db, 'normal', { desc: FULL_JD });
    expect(listUnscoredJobs(db, { now: NOW, kind: 'unscored' }).map((j) => j.id)).toEqual(['normal']);
    expect(status(db, 'manual')).toBe('jd_pending');
    expect(saveFetchedJd(db, 'manual', FULL_JD, NOW).reset).toBe(true);
    const list = listUnscoredJobs(db, { now: NOW, kind: 'unscored' });
    expect(list.map((j) => j.id)).toEqual(['manual', 'normal']);
    expect(list[0].priority).toBe(1);
  });

  it('the owner report says the job waits for its description', () => {
    const db = openDb(':memory:');
    add(db, 'manual', { source: 'manual:naukri', priority: 1, title: 'Senior React Dev', company: 'Acme' });
    listUnscoredJobs(db, { now: NOW, kind: 'unscored' });
    db.prepare(`INSERT INTO manual_requests (url, status, job_ids) VALUES ('https://www.naukri.com/job-listings-x-1', 'running', '["manual"]')`).run();
    const req = db.prepare('SELECT * FROM manual_requests').get() as any;
    const text = composeManualReport(db, req).join('\n');
    expect(text).toContain('waiting for the job description');
    expect(text).toContain('Senior React Dev');
  });
});

describe('save_match_result and enqueue_outreach refuse a job without its JD', () => {
  const rowFor = (id: string) => ({
    job_id: id, score: 80, reasons: 'r', missing_keywords: [], score_dims: { rubric: 'career_ops_v1', cv_match: 4, north_star: 4, comp: 4, culture: 4, red_flags: 0, global: 4 },
    requirements: [{ req: 'React', importance: 'critical', evidence: 'structural', jd_quote: null, match: 'strong' }],
  });
  it('rejects a score for a snippet-only job in code, marks it waiting and does not count a failed match', () => {
    const db = openDb(':memory:');
    add(db, 'nk');
    const out = saveMatchResultsChecked(db, [rowFor('nk')] as any);
    expect(out.saved).toBe(0);
    expect(out.errors).toEqual([{ job_id: 'nk', error: 'jd_incomplete' }]);
    expect(row(db, 'nk')).toMatchObject({ score: null, status: 'jd_pending', match_fails: 0 });
  });
  it('the matcher error row jd_incomplete marks the job waiting and is not a failed match', () => {
    const db = openDb(':memory:');
    add(db, 'nk', { desc: FULL_JD });
    const out = saveMatchResultsChecked(db, [{ job_id: 'nk', error: 'jd_incomplete' }] as any);
    expect(out.errors).toEqual([{ job_id: 'nk', error: 'jd_incomplete' }]);
    expect(row(db, 'nk')).toMatchObject({ status: 'jd_pending', match_fails: 0 });
    // any other error row still counts as a failed match
    add(db, 'other', { desc: FULL_JD });
    saveMatchResultsChecked(db, [{ job_id: 'other', error: 'batch over 5' }] as any);
    expect(row(db, 'other').match_fails).toBe(1);
  });
  it('scores a board job and a full-JD Naukri job as before', () => {
    const db = openDb(':memory:');
    add(db, 'board', { source: 'remoteok', desc: 'short but a board' });
    add(db, 'full', { desc: FULL_JD });
    const out = saveMatchResultsChecked(db, [rowFor('board'), rowFor('full')] as any);
    expect(out.saved).toBe(2);
  });
  it('jdBlocksPrepare is what the enqueue_outreach tool checks', () => {
    const db = openDb(':memory:');
    add(db, 'snippet'); add(db, 'full', { desc: FULL_JD }); add(db, 'board', { source: 'lever', desc: 'x' });
    expect(jdBlocksPrepare(db, 'snippet')).toBe(true);
    expect(jdBlocksPrepare(db, 'full')).toBe(false);
    expect(jdBlocksPrepare(db, 'board')).toBe(false);
    markJdPending(db, 'full');
    expect(jdBlocksPrepare(db, 'full')).toBe(true);
    expect(jdBlocksPrepare(db, 'nope')).toBe(false);
  });
});

describe('queue readers: needs_reprep and jd_pending are not sendable and not applicable', () => {
  const item = (job_id: string, over: Record<string, unknown> = {}) => ({
    job_id, resume_pdf_path: '/tmp/r.pdf', email_subject: 'Hello', email_body: 'Body', email_to: 'hr@acme.test', connect_note: null, connect_profile_url: null,
    connect_category: null, connect_company: null, apply_platform: 'naukri', apply_url: `https://www.naukri.com/job-listings-x-${job_id}`, ...over,
  });
  it('listQueuedOutreach and the compact apply read skip them', () => {
    const db = openDb(':memory:');
    add(db, 'ok', { desc: FULL_JD });
    add(db, 'rep', { desc: FULL_JD });
    add(db, 'pend', { desc: FULL_JD });
    for (const j of ['ok', 'rep', 'pend']) enqueueOutreach(db, item(j));
    db.prepare("UPDATE outreach_queue SET status = 'needs_reprep' WHERE job_id = 'rep'").run();
    db.prepare("UPDATE jobs SET status = 'jd_pending' WHERE id = 'pend'").run();
    expect(listQueuedOutreach(db).map((r) => r.job_id)).toEqual(['ok']);
    expect(listQueuedOutreachCompact(db).rows.map((r) => r.job_id)).toEqual(['ok']);
    expect(listQueuedOutreachCompact(db, { onlyPendingApply: true }).rows.map((r) => r.job_id)).toEqual(['ok']);
    const due = countDue(db, NOW, loadTuning({}), {});
    expect(due.emailQueued).toBe(1);
    expect(due.applyQueued).toBe(1);
  });

  it('a needs_reprep row does not count as an outreach row: the matched job is handed back again, and enqueue rebuilds that row in place', () => {
    const db = openDb(':memory:');
    add(db, 'job', { desc: FULL_JD, score: 82 });
    const id = enqueueOutreach(db, item('job', { email_subject: 'Old', email_body: 'Old body' }));
    db.prepare("UPDATE outreach_queue SET status = 'needs_reprep', apply_status = 'manual_review', apply_note = 'x' WHERE id = ?").run(id);
    expect(listUnscoredJobs(db, { now: NOW, kind: 'matched', matchThreshold: 3 }).map((j) => j.id)).toEqual(['job']);
    const again = enqueueOutreach(db, item('job', { email_subject: 'New subject', email_body: 'New body' }));
    expect(again).toBe(id);
    const q = db.prepare('SELECT status, email_subject, email_body, apply_status, apply_note FROM outreach_queue WHERE id = ?').get(id);
    expect(q).toEqual({ status: 'queued', email_subject: 'New subject', email_body: 'New body', apply_status: null, apply_note: null });
    expect((db.prepare('SELECT COUNT(*) AS n FROM outreach_queue').get() as { n: number }).n).toBe(1);
    expect(listQueuedOutreach(db).map((r) => r.job_id)).toEqual(['job']);
  });
});

describe('mail drip: a row waiting for its re-prepare is never picked', () => {
  it('picks a queued row and skips needs_reprep and a jd_pending job', () => {
    const db = openDb(':memory:');
    for (const [j, addr] of [['ok', 'a@ok.example'], ['rep', 'b@rep.example'], ['pend', 'c@pend.example']] as const) {
      add(db, j, { desc: FULL_JD });
      db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('C', ?, 'hr', 1, 't', 0.9)").run(addr);
      enqueueOutreach(db, { job_id: j, resume_pdf_path: null, email_subject: 'S', email_body: 'B', email_to: addr, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: 'none', apply_url: null });
    }
    db.prepare("UPDATE outreach_queue SET status = 'needs_reprep' WHERE job_id = 'rep'").run();
    db.prepare("UPDATE jobs SET status = 'jd_pending' WHERE id = 'pend'").run();
    expect(pickDripItem(db, NOW, {}).item).toMatchObject({ kind: 'cold', job_id: 'ok' });
    db.prepare("UPDATE outreach_queue SET email_status = 'sent' WHERE job_id = 'ok'").run();
    expect(pickDripItem(db, NOW, {}).item).toBeNull();
  });
});

describe('LinkedIn Easy Apply picker', () => {
  it('skips a needs_reprep row and a jd_pending job', () => {
    const db = openDb(':memory:');
    const url = 'https://www.linkedin.com/jobs/view/4011111111/';
    add(db, 'li-job:4011111111', { source: 'linkedin-jobs', desc: FULL_JD });
    db.prepare('UPDATE jobs SET url = ?, apply_url = ? WHERE id = ?').run(url, url, 'li-job:4011111111');
    db.prepare("INSERT INTO outreach_queue (job_id, status, resume_pdf_path, apply_url, apply_platform) VALUES (?, 'queued', '/tmp/r.pdf', ?, 'linkedin_easy')").run('li-job:4011111111', url);
    const env = { APPLY_LINKEDIN_EASY: 'true' } as NodeJS.ProcessEnv;
    expect(easyApplyRows(db, env).map((r) => r.job_id)).toEqual(['li-job:4011111111']);
    db.prepare("UPDATE outreach_queue SET status = 'needs_reprep'").run();
    expect(easyApplyRows(db, env)).toEqual([]);
    db.prepare("UPDATE outreach_queue SET status = 'queued'").run();
    db.prepare("UPDATE jobs SET status = 'jd_pending'").run();
    expect(easyApplyRows(db, env)).toEqual([]);
  });
});

describe('stats', () => {
  it('count waiting, fetched in the last 24 hours and unavailable', () => {
    const db = openDb(':memory:');
    add(db, 'a'); add(db, 'b'); add(db, 'c');
    unscored(db);
    saveFetchedJd(db, 'a', FULL_JD, NOW);
    db.prepare("UPDATE jobs SET excluded_reason = 'jd_unavailable' WHERE id = 'c'").run();
    expect(jdStats(db, NOW)).toEqual({ pending: 2, unavailable: 1, fetched24h: 1, waiting: 1 });
  });
});
