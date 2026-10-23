import { describe, it, expect } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { enqueueOutreach, openDb, recordEmailSent, recordOutcome, saveJob } from '../src/db.js';
import {
  AUTONOMOUS_MAX, approveDraftedFollowups, claimFollowupGuarded, emailFollowupGaps, followupCheckMaxAgeMin, followupKind, followupMode,
  hasFreshCleanReplyCheck, listApprovedFollowups, listFollowupCandidates, listStale, recordReplyCheck, saveFollowupDraft, setFollowupApproval,
  type FollowupGate,
} from '../src/followups.js';
import { LIMITS } from '../src/setup/limitsCatalog.js';

const now = new Date('2026-10-20T12:00:00Z');
const pass: FollowupGate = (text) => ({ verdict: 'pass', invented: [], unsupported: [], forbidden: [], warnings: [], normalized_text: text });
const BODY = 'Hi team, I am still very interested in the Frontend Developer role at Acme and would love to contribute. In my last project I cut load time by 11 seconds, and I think that experience maps well to what your team is building. Could you share a rough timeline for the next steps in the hiring process? Thank you for your time. Best regards, Jane';
const auto = { mode: 'autonomous' as const, gapsDays: [3, 4, 5, 7] };
const daysAgo = (d: number, h = 0) => new Date(now.getTime() - d * 86_400_000 - h * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

function addJob(db: BetterSqlite3.Database, id: string, to: string, sentAt: string) {
  saveJob(db, { id, source: 's', title: 'Frontend Developer', company: 'Acme', url: 'u', apply_url: 'u', description: 'd' });
  const base = { job_id: id, resume_pdf_path: null, email_subject: 'Frontend role', email_body: 'Hi, I cut load time by 11 seconds.', email_to: to, connect_note: 'n', connect_category: 'peer', connect_company: 'Acme', apply_platform: null, apply_url: null };
  const a = enqueueOutreach(db, { ...base, connect_profile_url: `https://linkedin.com/in/${id}a` });
  db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('Acme', ?, 'hr', 1, 't', 0.9)").run(to);
  recordEmailSent(db, a, `m-${id}`);
  db.prepare('UPDATE outreach_queue SET email_sent_at = ? WHERE job_id = ?').run(sentAt, id);
}
const setup = (sentDaysAgo: number) => { const db = openDb(':memory:'); addJob(db, 'j1', 'hr@acme.dev', daysAgo(sentDaysAgo)); return db; };
const save = (db: BetterSqlite3.Database, n: number, at = now) => saveFollowupDraft(db, { job_id: 'j1', n, subject: 'Re: Frontend role', body: BODY }, at, pass, auto).id;
/** Adds a sent follow-up number n at `daysAgo` days. */
const sentFollowup = (db: BetterSqlite3.Database, n: number, ago: number) =>
  db.prepare("INSERT INTO followups (job_id, n, subject, body, status, sent_at) VALUES ('j1', ?, 's', 'b', 'sent', ?)").run(n, daysAgo(ago));
const counter = (db: BetterSqlite3.Database) => (db.prepare("SELECT coalesce(sum(count), 0) AS c FROM daily_counters WHERE key = 'send_email'").get() as { c: number }).c;
const checkAt = (db: BetterSqlite3.Database, minutesAgo: number, errors = 0) =>
  recordReplyCheck(db, { messages: 3, errors }, new Date(now.getTime() - minutesAgo * 60_000));

describe('mode and env settings', () => {
  it('autonomous only on the exact string true', () => {
    expect(followupMode({})).toBe('legacy');
    expect(followupMode({ FOLLOWUPS_AUTONOMOUS: '1' })).toBe('legacy');
    expect(followupMode({ FOLLOWUPS_AUTONOMOUS: 'true' })).toBe('autonomous');
  });
  it('kind of n: 4 is feedback', () => {
    expect([1, 2, 3, 4].map(followupKind)).toEqual(['followup', 'followup', 'followup', 'feedback']);
    expect(AUTONOMOUS_MAX).toBe(4);
  });
  it('EMAIL_FOLLOWUP_GAPS_DAYS: 4 positive integers, else default 3,4,5,7', () => {
    expect(emailFollowupGaps({})).toEqual([3, 4, 5, 7]);
    expect(emailFollowupGaps({ EMAIL_FOLLOWUP_GAPS_DAYS: '1,2,3,4' })).toEqual([1, 2, 3, 4]);
    for (const bad of ['1,2,3', '1,2,3,4,5', '1,2,x,4', '0,2,3,4', '1,2,3,400', '']) expect(emailFollowupGaps({ EMAIL_FOLLOWUP_GAPS_DAYS: bad })).toEqual([3, 4, 5, 7]);
  });
  it('FOLLOWUP_CHECK_MAX_AGE_MIN default 30, clamp 5..240', () => {
    expect(followupCheckMaxAgeMin({})).toBe(30);
    expect(followupCheckMaxAgeMin({ FOLLOWUP_CHECK_MAX_AGE_MIN: '1' })).toBe(5);
    expect(followupCheckMaxAgeMin({ FOLLOWUP_CHECK_MAX_AGE_MIN: '9999' })).toBe(240);
    expect(followupCheckMaxAgeMin({ FOLLOWUP_CHECK_MAX_AGE_MIN: 'abc' })).toBe(30);
  });
  it('the limits catalog agrees with the code defaults', () => {
    const g = LIMITS.find((l) => l.key === 'EMAIL_FOLLOWUP_GAPS_DAYS')!;
    const m = LIMITS.find((l) => l.key === 'FOLLOWUP_CHECK_MAX_AGE_MIN')!;
    expect(g.default).toBe(emailFollowupGaps({}).join(','));
    expect(m.default).toBe(followupCheckMaxAgeMin({}));
    expect([m.min, m.max]).toEqual([5, 240]);
  });
});

describe('autonomous cadence', () => {
  it('the cold email becomes a candidate after 3 quiet days, not before', () => {
    expect(listFollowupCandidates(setup(2), now, auto)).toEqual([]);
    const c = listFollowupCandidates(setup(3), now, auto);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ next_n: 1, followups_sent: 0 });
    expect(listFollowupCandidates(setup(5), now)).toEqual([]); // legacy default unchanged
  });
  it('gaps 4, 5, 7 after follow-ups 1, 2, 3; a 5th is never a candidate', () => {
    const state = (sent: number, lastAgo: number) => {
      const db = setup(40);
      for (let n = 1; n <= sent; n++) sentFollowup(db, n, n === sent ? lastAgo : 30 - n);
      return listFollowupCandidates(db, now, auto);
    };
    expect(state(1, 3)).toEqual([]);
    expect(state(1, 4)[0]).toMatchObject({ next_n: 2, followups_sent: 1 });
    expect(state(2, 4)).toEqual([]);
    expect(state(2, 5)[0]).toMatchObject({ next_n: 3 });
    expect(state(3, 6)).toEqual([]);
    expect(state(3, 7)[0]).toMatchObject({ next_n: 4, followups_sent: 3 });
    expect(state(4, 30)).toEqual([]);
  });
  it('custom gaps are honoured', () => {
    expect(listFollowupCandidates(setup(1), now, { mode: 'autonomous', gapsDays: [1, 1, 1, 1] })).toHaveLength(1);
  });
  it('stale: after 4 follow-ups and the last gap, why says 4 follow-ups; legacy still says 2', () => {
    const db = setup(40);
    for (let n = 1; n <= 4; n++) sentFollowup(db, n, 8);
    expect(listStale(db, now, auto)[0]).toMatchObject({ job_id: 'j1', followups_sent: 4, why: 'no reply after 4 follow-ups' });
    const db2 = setup(40);
    sentFollowup(db2, 1, 12);
    sentFollowup(db2, 2, 12);
    expect(listStale(db2, now)[0].why).toBe('no reply after 2 follow-ups');
    expect(listStale(db2, now, auto)).toEqual([]);
  });
  it('save accepts n 1..4 in autonomous mode and rejects the wrong n', () => {
    const db = setup(10);
    expect(() => save(db, 2)).toThrow(/expected follow-up #1/);
    const id = save(db, 1);
    expect(id).toBeGreaterThan(0);
  });
  it('legacy mode still caps n at the legacy rule (candidate list stops after 2)', () => {
    const db = setup(60 - 30);
    sentFollowup(db, 1, 20);
    sentFollowup(db, 2, 20);
    expect(listFollowupCandidates(db, now)).toEqual([]);
    expect(listFollowupCandidates(db, now, auto)[0]).toMatchObject({ next_n: 3 });
  });
});

describe('reply_checks', () => {
  it('a clean check is fresh at 30 minutes and stale at 31', () => {
    const db = openDb(':memory:');
    checkAt(db, 30);
    expect(hasFreshCleanReplyCheck(db, now, 30)).toBe(true);
    const db2 = openDb(':memory:');
    checkAt(db2, 31);
    expect(hasFreshCleanReplyCheck(db2, now, 30)).toBe(false);
  });
  it('errors > 0 is not clean, and the latest check wins', () => {
    const db = openDb(':memory:');
    expect(recordReplyCheck(db, { messages: 0, errors: 2 }, new Date(now.getTime() - 40 * 60_000)).clean).toBe(false);
    expect(hasFreshCleanReplyCheck(db, now, 60)).toBe(false);
    checkAt(db, 20);
    expect(hasFreshCleanReplyCheck(db, now, 30)).toBe(true);
    recordReplyCheck(db, { messages: 1, errors: 1 }, now);
    expect(hasFreshCleanReplyCheck(db, now, 30)).toBe(false);
  });
  it('no check at all is not fresh', () => {
    expect(hasFreshCleanReplyCheck(openDb(':memory:'), now, 30)).toBe(false);
  });
});

describe('claimFollowupGuarded', () => {
  const g = (over: Partial<{ maxAgeMin: number; sendLimit: number }> = {}) => ({ now, maxAgeMin: 30, sendLimit: 1, ...over });
  function approved() {
    const db = setup(10);
    const id = save(db, 1);
    setFollowupApproval(db, [id], true);
    return { db, id };
  }
  it('refuses a row that is not approved', () => {
    const db = setup(10);
    const id = save(db, 1);
    checkAt(db, 1);
    expect(claimFollowupGuarded(db, id, g())).toEqual({ claimed: false, reason: 'not_approved' });
    expect(claimFollowupGuarded(db, 9999, g())).toEqual({ claimed: false, reason: 'not_approved' });
    expect(counter(db)).toBe(0);
  });
  it('refuses without a fresh clean reply check and consumes nothing', () => {
    const { db, id } = approved();
    expect(claimFollowupGuarded(db, id, g())).toEqual({ claimed: false, reason: 'no_clean_reply_check' });
    checkAt(db, 45);
    expect(claimFollowupGuarded(db, id, g())).toEqual({ claimed: false, reason: 'no_clean_reply_check' });
    checkAt(db, 1, 1);
    expect(claimFollowupGuarded(db, id, g())).toEqual({ claimed: false, reason: 'no_clean_reply_check' });
    expect(counter(db)).toBe(0);
    expect(db.prepare('SELECT status FROM followups WHERE id = ?').get(id)).toEqual({ status: 'approved' });
  });
  it('claims once, consuming the shared counter exactly once', () => {
    const { db, id } = approved();
    checkAt(db, 5);
    expect(claimFollowupGuarded(db, id, g())).toEqual({ claimed: true });
    expect(counter(db)).toBe(1);
    expect(db.prepare('SELECT status FROM followups WHERE id = ?').get(id)).toEqual({ status: 'sending' });
    expect(claimFollowupGuarded(db, id, g())).toEqual({ claimed: false, reason: 'not_approved' });
    expect(counter(db)).toBe(1);
  });
  it('cap leaves the row approved and the counter untouched', () => {
    const { db, id } = approved();
    checkAt(db, 5);
    const day = (db.prepare("SELECT date('now') AS d").get() as { d: string }).d;
    db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (?, 'send_email', 1)").run(day);
    expect(claimFollowupGuarded(db, id, g({ sendLimit: 1 }))).toEqual({ claimed: false, reason: 'cap' });
    expect(counter(db)).toBe(1);
    expect(db.prepare('SELECT status FROM followups WHERE id = ?').get(id)).toEqual({ status: 'approved' });
  });
  it('a job that got an outcome, a reply or a bounce is never claimed', () => {
    for (const mk of [
      (db: BetterSqlite3.Database) => recordOutcome(db, 'j1', 'replied'),
      (db: BetterSqlite3.Database) => db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, action, from_addr) VALUES ('x', 'j1', 'reply', 'proposed', 'hr@acme.dev')").run(),
      (db: BetterSqlite3.Database) => db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, action, from_addr) VALUES ('x', 'j1', 'bounce', 'bounced', 'mailer-daemon@x.com')").run(),
    ]) {
      const { db, id } = approved();
      checkAt(db, 1);
      mk(db);
      expect(listApprovedFollowups(db)).toEqual([]);
      expect(claimFollowupGuarded(db, id, g()).claimed).toBe(false);
      expect(counter(db)).toBe(0);
    }
  });
});

describe('approveDraftedFollowups', () => {
  it('approves unblocked drafts and skips blocked ones', () => {
    const db = setup(10);
    addJob(db, 'j2', 'hr@beta.dev', daysAgo(10));
    const a = save(db, 1);
    const b = Number(db.prepare("INSERT INTO followups (job_id, n, subject, body, status) VALUES ('j2', 1, 's', 'b', 'drafted')").run().lastInsertRowid);
    db.prepare("INSERT INTO job_outcomes (job_id, outcome) VALUES ('j2', 'rejected')").run();
    expect(approveDraftedFollowups(db, now)).toEqual({ approved: [a], skipped: [b] });
    const st = (id: number) => (db.prepare('SELECT status FROM followups WHERE id = ?').get(id) as { status: string }).status;
    expect(st(a)).toBe('approved');
    expect(st(b)).toBe('skipped');
  });
});
