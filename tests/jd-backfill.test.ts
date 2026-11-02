// npm run jd:backfill: jobs prepared on a snippet are made to wait for their JD (unsent rows -> needs_reprep, score cleared); jobs already emailed,
// applied to or messaged are only flagged. Idempotent, never deletes, never touches a sent row.
import { describe, expect, it } from 'vitest';
import { openDb, saveJob } from '../src/db.js';
import { runJdBackfill } from '../src/jdBackfill.js';
import { run as runScript } from '../scripts/jd-backfill.js';
import { upsertPerson } from '../src/outreach/people.js';
import { FULL_JD } from './helpers/jdFixtures.js';

type Db = ReturnType<typeof openDb>;

function job(db: Db, id: string, o: { source?: string; desc?: string; score?: number | null; status?: string | null; excluded?: string | null } = {}): void {
  saveJob(db, { id, source: o.source ?? 'naukri', title: `Dev ${id}`, company: `Co ${id}`, url: `https://www.naukri.com/job-listings-x-${id}`, apply_url: `https://www.naukri.com/job-listings-x-${id}`, description: o.desc ?? 'India' });
  db.prepare('UPDATE jobs SET score = ?, status = ?, excluded_reason = ?, match_reasons = ?, prep_offers = 2 WHERE id = ?').run(o.score ?? null, o.status ?? null, o.excluded ?? null, o.score == null ? null : 'from title', id);
}
function queue(db: Db, jobId: string, o: Record<string, unknown> = {}): number {
  const cols = { status: 'queued', email_to: 'hr@acme.test', email_subject: 'Hi', email_body: 'Body', resume_pdf_path: '/tmp/r.pdf', ...o };
  const keys = Object.keys(cols);
  return Number(db.prepare(`INSERT INTO outreach_queue (job_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`).run(jobId, ...Object.values(cols)).lastInsertRowid);
}
const qrow = (db: Db, id: number) => db.prepare('SELECT status, email_status, apply_status FROM outreach_queue WHERE id = ?').get(id) as Record<string, unknown>;
const jrow = (db: Db, id: string) => db.prepare('SELECT status, score, match_reasons, jd_note, prep_offers FROM jobs WHERE id = ?').get(id) as Record<string, unknown>;

function seed(db: Db) {
  job(db, 'fresh', { score: 82 });
  const q1 = queue(db, 'fresh', { apply_status: 'manual_review', apply_platform: 'naukri' });
  job(db, 'owner', { score: 77 });
  const q9 = queue(db, 'owner', { apply_status: 'needs_owner' });
  job(db, 'emailed', { score: 90 });
  const q2 = queue(db, 'emailed', { email_status: 'sent', email_sent_at: '2026-10-10 10:00:00' });
  job(db, 'applied', { score: 90 });
  const q3 = queue(db, 'applied', { apply_status: 'submitted' });
  db.prepare("INSERT INTO applications (job_id, platform, status) VALUES ('applied', 'naukri', 'submitted')").run();
  job(db, 'dm', { source: 'linkedin-jobs', score: 70 });
  const q4 = queue(db, 'dm', { connect_profile_url: 'https://www.linkedin.com/in/x', connect_note: 'hi', connect_status: 'queued' });
  const pid = upsertPerson(db, { platform: 'linkedin', profileKey: 'linkedin.com/in/x', name: 'X', headline: 'HR', company: 'Co', category: 'recruiter' });
  db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key, status) VALUES (?, 'dm', 'role_ask', 'k1', 'sent')").run(pid);
  job(db, 'full', { desc: FULL_JD, score: 80 });
  const q5 = queue(db, 'full');
  job(db, 'board', { source: 'remoteok', desc: 'short', score: 80 });
  const q6 = queue(db, 'board');
  job(db, 'vetoed', { excluded: 'hard stop: x' });
  const q7 = queue(db, 'vetoed');
  job(db, 'dup', { status: 'duplicate' });
  job(db, 'unscored');
  return { q1, q2, q3, q4, q5, q6, q7, q9 };
}

describe('jd:backfill', () => {
  it('makes unsent snippet jobs wait for their JD and leaves everything already done alone', () => {
    const db = openDb(':memory:');
    const q = seed(db);
    const r = runJdBackfill(db);
    expect(r).toEqual({ candidates: 7, marked_pending: 3, scores_cleared: 2, rows_needs_reprep: 2, flagged_prepared_without_jd: 3, skipped_other_status: 1 });

    expect(jrow(db, 'fresh')).toMatchObject({ status: 'jd_pending', score: null, match_reasons: null, jd_note: 'reprep', prep_offers: 0 });
    expect(qrow(db, q.q1)).toMatchObject({ status: 'needs_reprep', apply_status: 'manual_review' });
    expect(jrow(db, 'owner')).toMatchObject({ status: 'jd_pending', score: null });
    expect(qrow(db, q.q9).status).toBe('needs_reprep');
    expect(jrow(db, 'unscored')).toMatchObject({ status: 'jd_pending', jd_note: 'reprep' });

    // emailed, applied, messaged: flagged only, nothing else changes
    for (const id of ['emailed', 'applied', 'dm']) expect(jrow(db, id)).toMatchObject({ status: null, jd_note: 'prepared_without_jd', prep_offers: 2 });
    expect(jrow(db, 'emailed').score).toBe(90);
    expect(qrow(db, q.q2)).toMatchObject({ status: 'queued', email_status: 'sent' });
    expect(qrow(db, q.q3)).toMatchObject({ status: 'queued', apply_status: 'submitted' });
    expect(qrow(db, q.q4).status).toBe('queued');

    // full JD, board, vetoed and duplicate jobs are untouched
    expect(jrow(db, 'full')).toMatchObject({ status: null, score: 80, jd_note: null });
    expect(qrow(db, q.q5).status).toBe('queued');
    expect(jrow(db, 'board')).toMatchObject({ status: null, score: 80, jd_note: null });
    expect(qrow(db, q.q6).status).toBe('queued');
    expect(jrow(db, 'vetoed')).toMatchObject({ status: null, jd_note: null });
    expect(qrow(db, q.q7).status).toBe('queued');
    expect(jrow(db, 'dup')).toMatchObject({ status: 'duplicate' });
    // rows are never deleted
    expect((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(10);
    expect((db.prepare('SELECT COUNT(*) AS n FROM outreach_queue').get() as { n: number }).n).toBe(8);
  });

  it('--dry reports the same counts and writes nothing', () => {
    const db = openDb(':memory:');
    seed(db);
    const before = JSON.stringify([db.prepare('SELECT * FROM jobs ORDER BY id').all(), db.prepare('SELECT * FROM outreach_queue ORDER BY id').all()]);
    const dry = runJdBackfill(db, { dry: true });
    expect(dry).toEqual({ candidates: 7, marked_pending: 3, scores_cleared: 2, rows_needs_reprep: 2, flagged_prepared_without_jd: 3, skipped_other_status: 1 });
    expect(JSON.stringify([db.prepare('SELECT * FROM jobs ORDER BY id').all(), db.prepare('SELECT * FROM outreach_queue ORDER BY id').all()])).toBe(before);
  });

  it('is idempotent: a second run changes nothing', () => {
    const db = openDb(':memory:');
    seed(db);
    runJdBackfill(db);
    const after1 = JSON.stringify([db.prepare('SELECT * FROM jobs ORDER BY id').all(), db.prepare('SELECT * FROM outreach_queue ORDER BY id').all()]);
    const again = runJdBackfill(db);
    expect(again).toEqual({ candidates: 7, marked_pending: 0, scores_cleared: 0, rows_needs_reprep: 0, flagged_prepared_without_jd: 0, skipped_other_status: 1 });
    expect(JSON.stringify([db.prepare('SELECT * FROM jobs ORDER BY id').all(), db.prepare('SELECT * FROM outreach_queue ORDER BY id').all()])).toBe(after1);
  });

  it('a sent row is never touched even when the job also has an unsent row (the whole job counts as done)', () => {
    const db = openDb(':memory:');
    job(db, 'mixed', { score: 80 });
    const sent = queue(db, 'mixed', { email_status: 'sent', email_sent_at: '2026-10-10 10:00:00', connect_profile_url: 'https://www.linkedin.com/in/a' });
    const unsent = queue(db, 'mixed', { connect_profile_url: 'https://www.linkedin.com/in/b', connect_note: 'hi' });
    runJdBackfill(db);
    expect(qrow(db, sent).status).toBe('queued');
    expect(qrow(db, unsent).status).toBe('queued');
    expect(jrow(db, 'mixed')).toMatchObject({ status: null, jd_note: 'prepared_without_jd', score: 80 });
  });

  it('the script wraps it: usage error, dry and real output', () => {
    const db = openDb(':memory:');
    seed(db);
    expect(runScript(['--bad'], db).code).toBe(2);
    const dry = runScript(['--dry'], db);
    expect(dry.code).toBe(0);
    expect(dry.lines[0]).toMatch(/dry run/);
    expect(dry.lines.join('\n')).toContain('would mark 3 job(s) jd_pending');
    const real = runScript([], db);
    expect(real.lines.join('\n')).toContain('mark 3 job(s) jd_pending');
    expect(real.lines.join('\n')).not.toContain('would');
  });
});
