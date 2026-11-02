import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { enqueueOutreach, openDb, saveJob, setExternalApply, updateOutreachStatus } from '../src/db.js';
import { addEscalation } from '../src/outreach/service.js';
import { findJobByUrl, JOB_MOVED_ON_NOTE, parseApplyDetail, resolveApplyEscalationsForJob, resolveStaleApplyEscalations } from '../src/outreach/applyEscalations.js';
import { markDone, markSkip } from '../src/manual/manualApply.js';
import { markAnswered, markSkipped, pauseJobNeedsAnswer, recordQuestion } from '../src/apply/questions.js';
import { recordApplication } from '../src/applier/tools/common.js';
import { run as cleanup } from '../scripts/apply-resolve-stale-escalations.js';
import { run as releaseHeld } from '../scripts/apply-release-held.js';
import { run as requeueCompanySite } from '../scripts/apply-requeue-company-site.js';

const NOW = new Date('2026-11-02T10:00:00.000Z');
let db: BetterSqlite3.Database;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { db.close(); });

function job(id: string, url = `https://boards.greenhouse.io/acme/jobs/${id}`): void {
  saveJob(db, { id, source: 'remotive', title: `Dev ${id}`, company: `Acme ${id}`, url, apply_url: url, description: 'x' });
}
function queue(id: string, status: string | null, o: { platform?: string; url?: string } = {}): number {
  const qid = enqueueOutreach(db, {
    job_id: id, resume_pdf_path: null, email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null,
    connect_category: null, connect_company: null, apply_platform: o.platform ?? 'greenhouse', apply_url: o.url ?? `https://boards.greenhouse.io/acme/jobs/${id}`,
  });
  db.prepare('UPDATE outreach_queue SET apply_status = ? WHERE id = ?').run(status, qid);
  return qid;
}
const esc = (reason: string, detail: string, threadRef?: string): number =>
  addEscalation(db, { runId: null, platform: 'apply', reason, detail, threadRef }, NOW);
const isOpen = (id: number): boolean => (db.prepare('SELECT resolved_at FROM escalations WHERE id = ?').get(id) as { resolved_at: string | null }).resolved_at === null;
const noteOf = (id: number): string | null => (db.prepare('SELECT resolved_note FROM escalations WHERE id = ?').get(id) as { resolved_note: string | null }).resolved_note;
const driftFor = (jobId: string, host = 'boards.greenhouse.io'): number => esc('apply:drift', `reason=drift platform=greenhouse host=${host} job=${jobId}`);

describe('parseApplyDetail', () => {
  it('reads job, host and url from new and old rows', () => {
    expect(parseApplyDetail('reason=drift platform=greenhouse host=Acme.IO job=j-1')).toEqual({ jobId: 'j-1', host: 'acme.io', url: null });
    expect(parseApplyDetail('reason=drift platform=unknown host=old.example\nurl=https://old.example/apply/9 host=old.example step=form')).toEqual({ jobId: null, host: 'old.example', url: 'https://old.example/apply/9' });
    expect(parseApplyDetail('needs your answer: 2 questions for job 77 on x.io; run: npm run answers -- list').jobId).toBe('77');
    expect(parseApplyDetail('needs you on x.io (captcha): run npm run apply:assist -- 55').jobId).toBe('55');
    expect(parseApplyDetail(null, 'easyapply:123').jobId).toBe('123');
    expect(parseApplyDetail(null)).toEqual({ jobId: null, host: null, url: null });
  });
  it('finds a job by the url stored in an old row', () => {
    job('u1', 'https://old.example/apply/9');
    expect(findJobByUrl(db, 'https://old.example/apply/9')).toBe('u1');
    expect(findJobByUrl(db, 'https://nope.example/')).toBeNull();
  });
});

describe('auto-resolve when a job moves on (one test per status writer)', () => {
  it('leaves a card open while the job is still failing', () => {
    job('1'); queue('1', 'manual_review');
    const e = driftFor('1');
    expect(resolveApplyEscalationsForJob(db, '1', NOW)).toBe(0);
    expect(isOpen(e)).toBe(true);
  });

  it('update_outreach_status path (updateOutreachStatus) resolves with the note "job moved on"', () => {
    job('2'); const q = queue('2', 'needs_owner');
    const e = driftFor('2'); const other = driftFor('999');
    updateOutreachStatus(db, q, 'apply_status', 'submitted');
    expect(isOpen(e)).toBe(false);
    expect(noteOf(e)).toBe(JOB_MOVED_ON_NOTE);
    expect(isOpen(other)).toBe(true);
    // the row stays in the database
    expect((db.prepare('SELECT COUNT(*) c FROM escalations').get() as { c: number }).c).toBe(2);
  });

  it('a requeue to NULL or queued resolves, a move to another failing state does not', () => {
    job('3'); const q = queue('3', 'needs_human');
    const e = driftFor('3');
    updateOutreachStatus(db, q, 'apply_status', 'manual_review');
    expect(isOpen(e)).toBe(true);
    updateOutreachStatus(db, q, 'apply_status', 'queued');
    expect(isOpen(e)).toBe(false);
  });

  it('markDone (I applied) and markSkip resolve', () => {
    job('4'); job('5');
    const q4 = queue('4', 'manual_review'); const q5 = queue('5', 'manual_review');
    const e4 = driftFor('4'); const e5 = driftFor('5');
    expect(markDone(db, q4, {}, NOW).ok).toBe(true);
    expect(isOpen(e4)).toBe(false);
    expect(markSkip(db, q5, {}).ok).toBe(true);
    expect(isOpen(e5)).toBe(false);
    expect(noteOf(e5)).toBe(JOB_MOVED_ON_NOTE);
  });

  it('the applier recording a submitted application resolves, a manual_review one does not', () => {
    job('6'); queue('6', 'needs_owner');
    const e = driftFor('6');
    recordApplication(db, { jobId: '6', platform: 'greenhouse' } as never, 'manual_review', 'x', NOW);
    expect(isOpen(e)).toBe(true);
    recordApplication(db, { jobId: '6', platform: 'greenhouse' } as never, 'submitted', null, NOW);
    expect(isOpen(e)).toBe(false);
  });

  it('answering or skipping the questions of a host closes the "needs your answer" card', () => {
    job('7'); queue('7', null);
    const q = recordQuestion(db, { jobId: '7', host: 'forms.acme.io', label: 'Why us?', maxLength: null, options: [], kind: 'text' }, NOW);
    pauseJobNeedsAnswer(db, '7');
    const e = esc('apply:needs_answer', 'needs your answer: 1 question for job 7 on forms.acme.io', 'answers:forms.acme.io');
    expect(resolveApplyEscalationsForJob(db, '7', NOW)).toBe(0);
    expect(isOpen(e)).toBe(true);
    markAnswered(db, q.id, 'Because', 'once', NOW);
    expect(isOpen(e)).toBe(false);

    job('8'); queue('8', null);
    const q2 = recordQuestion(db, { jobId: '8', host: 'forms.beta.io', label: 'Why?', maxLength: null, options: [], kind: 'text' }, NOW);
    pauseJobNeedsAnswer(db, '8');
    const e2 = esc('apply:needs_answer', 'needs your answer: 1 question for job 8 on forms.beta.io', 'answers:forms.beta.io');
    markSkipped(db, q2.id, NOW);
    expect(isOpen(e2)).toBe(false);
  });

  it('a resolved company-site link that requeues the job resolves its cards', () => {
    job('9'); queue('9', 'manual_review');
    const e = driftFor('9');
    expect(setExternalApply(db, '9', 'https://boards.greenhouse.io/acme/jobs/9', { platform: 'greenhouse', tier: 'browser' })).toBeGreaterThan(0);
    expect(isOpen(e)).toBe(false);
  });

  it('apply:release-held and apply:requeue-company-site resolve the cards of the jobs they release', () => {
    job('10');
    const q = queue('10', 'held');
    db.prepare("UPDATE outreach_queue SET status = 'queued' WHERE id = ?").run(q);
    const e = driftFor('10');
    expect(releaseHeld([], { db }).code).toBe(0);
    expect(isOpen(e)).toBe(false);

    job('11'); queue('11', 'manual_review', { platform: 'naukri' });
    const e2 = driftFor('11');
    requeueCompanySite([], { db });
    expect(isOpen(e2)).toBe(false);
  });
});

describe('npm run apply:resolve-stale-escalations', () => {
  function seed(): { stale: number; failing: number; oldStale: number; oldUnknown: number; hostStale: number } {
    job('s1'); queue('s1', 'submitted');
    job('s2'); queue('s2', 'manual_review');
    job('s3', 'https://old.example/apply/3'); queue('s3', 'skipped_by_owner', { url: 'https://old.example/apply/3' });
    const stale = driftFor('s1');
    const failing = driftFor('s2');
    // an old row: no job id, only host and url of a job that moved on
    const oldStale = esc('apply:drift', 'reason=drift platform=unknown host=old.example\nurl=https://old.example/apply/3 host=old.example step=form block=none');
    const oldUnknown = esc('apply:drift', 'reason=drift platform=unknown host=nowhere.example');
    const hostStale = esc('apply:needs_answer', 'needs your answer: 1 question for job s1 on gone.example', 'answers:gone.example');
    return { stale, failing, oldStale, oldUnknown, hostStale };
  }

  it('--dry reports and changes nothing', () => {
    const ids = seed();
    const r = cleanup(['--dry'], { db });
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^dry: 3 of 5 open apply escalation\(s\) would be marked "job moved on"/);
    for (const id of Object.values(ids)) expect(isOpen(id)).toBe(true);
  });

  it('resolves exactly the stale rows, keeps failing and unknown ones, deletes nothing, and a second run finds nothing', () => {
    const ids = seed();
    const r = cleanup([], { db, now: () => NOW });
    expect(r.lines[0]).toMatch(/^resolved 3 of 5/);
    expect([ids.stale, ids.oldStale, ids.hostStale].map(isOpen)).toEqual([false, false, false]);
    expect(noteOf(ids.stale)).toBe(JOB_MOVED_ON_NOTE);
    expect([ids.failing, ids.oldUnknown].map(isOpen)).toEqual([true, true]);
    expect((db.prepare('SELECT COUNT(*) c FROM escalations').get() as { c: number }).c).toBe(5);
    const again = cleanup([], { db });
    expect(again.lines[0]).toMatch(/^resolved 0 of 2/);
    expect(resolveStaleApplyEscalations(db, { dry: true }).stale).toBe(0);
  });

  it('rejects unknown arguments', () => {
    expect(cleanup(['--nope'], { db }).code).toBe(2);
  });
});
