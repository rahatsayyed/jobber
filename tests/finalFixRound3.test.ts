// Plan 3 final fix round: C1 (real replies filed as ignored), I1 (chunked reply queries), I2 (candidate xor stale), I4 (claim before send),
// M1 (cancelled vs skipped), M5 (ambiguous blocks every candidate), M6 (funnel/patterns contacted set). Synthetic data only, :memory: databases.
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enqueueOutreach, listSentEmails, openDb, recordEmailSent, recordOutcome, saveApplication, saveJob, setEmailThread, type SentEmail } from '../src/db.js';
import { buildReplyQueries, classifyReplyDetail, QUERY_MAX_TERMS, REPLY_WINDOW_DAYS, STALE_DAYS } from '../src/replies.js';
import { triageReplies } from '../src/replyTriage.js';
import {
  blockedJobIds, claimFollowupForSend, listApprovedFollowups, listFollowupCandidates, listStale, listStuckSending, markFollowupFailed, markFollowupSent,
  replyWatchQueries, saveFollowupDraft, setFollowupApproval, type FollowupGate,
} from '../src/followups.js';
import { funnelStats } from '../src/funnel.js';
import { patternStats } from '../src/patterns.js';

const now = new Date('2026-10-20T12:00:00Z');
const OFF = { auto_record_enabled: false };
const ON = { auto_record_enabled: true };
const pass: FollowupGate = (text) => ({ verdict: 'pass', invented: [], unsupported: [], forbidden: [], warnings: [], normalized_text: text });
const BODY = 'Hi team, I am still very interested in the Frontend Developer role at Acme and would love to contribute. In my last project I cut load time by 11 seconds, and I think that experience maps well to what your team is building. Could you share a rough timeline for the next steps in the hiring process? Thank you for your time. Best regards, Jane';

function addJob(db: BetterSqlite3.Database, id: string, to: string, sentAt: string, company = 'Zentrix') {
  saveJob(db, { id, source: 's', title: 'Frontend Developer', company, url: 'u', apply_url: 'u', description: 'd' });
  const q = enqueueOutreach(db, { job_id: id, resume_pdf_path: null, email_subject: 'Frontend role', email_body: 'Hi, I cut load time by 11 seconds.', email_to: to, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: null, apply_url: null });
  recordEmailSent(db, q, `m-${id}`);
  setEmailThread(db, `m-${id}`, `t-${id}`);
  db.prepare('UPDATE outreach_queue SET email_sent_at = ? WHERE job_id = ?').run(sentAt, id);
}
const approved = (db: BetterSqlite3.Database, jobId = 'j1') => {
  const id = saveFollowupDraft(db, { job_id: jobId, n: 1, subject: 'Re: Frontend role', body: BODY }, now, pass).id;
  setFollowupApproval(db, [id], true);
  return id;
};
const status = (db: BetterSqlite3.Database, id: number) => (db.prepare('SELECT status FROM followups WHERE id = ?').get(id) as { status: string }).status;

const PRIYA = 'Priya Sharma <priya@zentrix.in>';
const PROBES: Array<[string, string, string]> = [
  ['1 availability + webinar footer', 'Hi Jane,\n\nThanks for reaching out. Are you available Tuesday at 3pm for a call?\n\nBest,\nPriya\n\n--\nJoin our upcoming webinar on hiring trends! Register at zentrix.in/events', 'interview'],
  ['2 schedule interview + newsletter footer', 'Hi Jane,\n\nWe would like to schedule an interview. Please share your availability for this week.\n\nRegards,\nPriya\nTalent Acquisition, Zentrix\n\nSubscribe to our newsletter for product updates.', 'interview'],
  ['3 travelling but Monday 11am', "Hi Jane, I'm currently travelling but would love to chat. Could we do Monday 11am?\n\nPriya", 'interview'],
  ['4 back on Monday, set up a call', "Hi Jane, thanks for the note. I'm back on Monday, let's set up a call.\n\nPriya", 'interview'],
  ['5 forwarded to hiring manager', 'Hi Jane, I have forwarded your resume to the hiring manager. We will be in touch if there is a fit.\n\nPriya', 'replied'],
  ['6 lead out of office, talk next Monday', 'Hi Jane, our engineering lead is out of office this week, can we talk next Monday?\n\nPriya', 'interview'],
];

describe('C1: the six probe replies', () => {
  it.each(PROBES)('classifier: %s is never noise or auto_ack', (_name, body, expected) => {
    const d = classifyReplyDetail('Re: Frontend role', body, PRIYA);
    expect(d.cls).toBe(expected);
  });
  it('an out-of-office phrase next to the scheduling ask makes the mail proposal-only (never auto-record eligible)', () => {
    for (const [, body] of [PROBES[2], PROBES[3], PROBES[5]]) expect(classifyReplyDetail('Re: Frontend role', body, PRIYA).eligible).toBe(false);
  });
  it('a footer still cannot turn a plain out-of-office or newsletter into a reply', () => {
    expect(classifyReplyDetail('Automatic reply: Frontend role', 'I am out of the office until Monday with limited access to email.\n\nBest,\nPriya', PRIYA).cls).toBe('auto_ack');
    expect(classifyReplyDetail('Our newsletter', 'Join our upcoming webinar on hiring trends.', 'news@zentrix.in').cls).toBe('noise');
  });
  it.each(PROBES)('end to end (thread match, auto-record off and on): after triage, %s leaves no follow-up candidate', (_name, body) => {
    for (const config of [OFF, ON]) {
      const db = openDb(':memory:');
      addJob(db, 'j1', 'priya@zentrix.in', '2026-10-05 09:00:00');
      expect(listFollowupCandidates(db, now).map((c) => c.job_id)).toEqual(['j1']);
      const r = triageReplies(db, [{ message_id: 'p', thread_id: 't-j1', from: PRIYA, subject: 'Re: Frontend role', body }], { config });
      expect(r.ignored).toBe(0);
      expect(r.proposals.length + r.auto_recorded.length).toBe(1);
      expect(listFollowupCandidates(db, now)).toEqual([]);
    }
  });
  it('a high-confidence human match whose text looks like noise is upgraded to a replied proposal', () => {
    const db = openDb(':memory:');
    addJob(db, 'j1', 'priya@zentrix.in', '2026-10-05 09:00:00');
    const r = triageReplies(db, [{ message_id: 'n', thread_id: 't-j1', from: PRIYA, subject: 'Re: Frontend role', body: 'Join our upcoming webinar.' }], { config: OFF });
    expect(r.proposals).toMatchObject([{ job_id: 'j1', outcome: 'replied' }]);
    expect(listFollowupCandidates(db, now)).toEqual([]);
  });
  it('matched_ignored lists ignored mail matched with high/medium confidence; an automated sender does not block the follow-up', () => {
    const db = openDb(':memory:');
    addJob(db, 'j1', 'priya@zentrix.in', '2026-10-05 09:00:00');
    const r = triageReplies(db, [
      { message_id: 'a', thread_id: 't-j1', from: 'no-reply@zentrix.in', subject: 'Re: Frontend role', body: 'We have received your application. This is an automated message.' },
      { message_id: 'b', from: 'x@unrelated.io', subject: 'Webinar', body: 'Join our webinar.' },
    ], { config: OFF });
    expect(r.matched_ignored).toEqual([{ message_id: 'a', job_id: 'j1', from: 'no-reply@zentrix.in', subject: 'Re: Frontend role', class: 'auto_ack' }]);
    expect(r.ignored).toBe(2);
    expect(listFollowupCandidates(db, now).map((c) => c.job_id)).toEqual(['j1']);
  });
  it('a dry run lists matched_ignored too but writes nothing', () => {
    const db = openDb(':memory:');
    addJob(db, 'j1', 'priya@zentrix.in', '2026-10-05 09:00:00');
    const r = triageReplies(db, [{ message_id: 'a', thread_id: 't-j1', from: 'no-reply@zentrix.in', subject: 'Re: x', body: 'We have received your application.' }], { dry_run: true, config: OFF });
    expect(r.matched_ignored).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM processed_messages').get()).toEqual({ n: 0 });
  });
});

describe('M5: an ambiguous bounce or reply blocks every candidate job', () => {
  const setup = () => {
    const db = openDb(':memory:');
    addJob(db, 'j1', 'hr@acme.dev', '2026-10-05 09:00:00', 'Acme');
    addJob(db, 'j2', 'jobs@acme.io', '2026-10-05 09:00:00', 'Acme');
    addJob(db, 'j3', 'hr@acme.dev', '2026-10-05 09:00:00', 'Initech'); // sibling at a candidate's address
    addJob(db, 'j4', 'other@globex.io', '2026-10-05 09:00:00', 'Globex');
    return db;
  };
  it('ambiguous bounce: stores the candidates, blocks both candidates and every job at their addresses', () => {
    const db = setup();
    const r = triageReplies(db, [{ message_id: 'b', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)', body: 'Your message to Acme was not delivered: address not found.' }], { config: OFF });
    expect(r.bounced).toHaveLength(1);
    expect(r.ambiguous[0].candidates.sort()).toEqual(['j1', 'j2']);
    expect(JSON.parse((db.prepare("SELECT candidates FROM processed_messages WHERE message_id = 'b'").get() as { candidates: string }).candidates).sort()).toEqual(['j1', 'j2']);
    expect(listFollowupCandidates(db, now).map((c) => c.job_id)).toEqual(['j4']);
  });
  it('ambiguous human reply blocks both candidates', () => {
    const db = setup();
    triageReplies(db, [{ message_id: 'r', from: 'someone@gmail.com', subject: 'Your note to Acme', body: 'Hi, can we talk tomorrow at 4pm?' }], { config: OFF });
    expect(listFollowupCandidates(db, now).map((c) => c.job_id).sort()).toEqual(['j3', 'j4']);
  });
  it('ambiguous automated noise does not block', () => {
    const db = setup();
    triageReplies(db, [{ message_id: 'n', from: 'alerts@linkedin.com', subject: 'Jobs at Acme', body: 'Recommended jobs for you at Acme.' }], { config: OFF });
    expect(listFollowupCandidates(db, now)).toHaveLength(4);
  });
  it('the candidates column is added to an old-shape processed_messages table', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jobber-pm-'));
    try {
      const file = path.join(dir, 'old.sqlite');
      const old = new Database(file);
      old.exec('CREATE TABLE processed_messages (message_id TEXT PRIMARY KEY, job_id TEXT, classification TEXT, action TEXT, proposed_outcome TEXT, from_addr TEXT, subject TEXT, reply_date TEXT, processed_at TEXT)');
      old.prepare("INSERT INTO processed_messages (message_id, job_id, classification, action) VALUES ('x', 'j1', 'replied', 'proposed')").run();
      old.close();
      const db = openDb(file);
      expect((db.prepare('PRAGMA table_info(processed_messages)').all() as { name: string }[]).map((c) => c.name)).toContain('candidates');
      expect(db.prepare("SELECT job_id, candidates FROM processed_messages WHERE message_id = 'x'").get()).toEqual({ job_id: 'j1', candidates: null });
      db.close();
      openDb(file).close(); // idempotent
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('I1: reply queries cover every sent email', () => {
  const sent = (i: number, over: Partial<SentEmail> = {}): SentEmail => ({ job_id: `k${i}`, company: `Co${i}`, title: 't', email_to: `a@co${i}.dev`, subject: 's', body: 'b', message_id: `m${i}`, thread_id: null, sent_at: `2026-09-${String((i % 28) + 1).padStart(2, '0')} 10:00:00`, ...over });
  it('35 sent emails: every company and domain appears, each query has at most 15 terms, and all use the one window', () => {
    const many = Array.from({ length: 35 }, (_, i) => sent(i));
    many.push(sent(99, { company: 'Initech', email_to: 'candidate@gmail.com' }));
    const qs = buildReplyQueries(many);
    expect(qs.length).toBeGreaterThan(1);
    const all = qs.join(' ');
    for (let i = 0; i < 35; i++) {
      expect(all).toContain(`"Co${i}"`);
      expect(all).toContain(`from:co${i}.dev`);
    }
    expect(all).toContain('from:candidate@gmail.com');
    expect(all).not.toContain('from:gmail.com');
    expect(all).toContain('from:greenhouse.io');
    for (const q of qs) {
      const terms = /\{(.*)\}/.exec(q)![1].match(/"[^"]*"|\S+/g)!;
      expect(terms.length).toBeLessThanOrEqual(QUERY_MAX_TERMS);
      expect(q.startsWith(`newer_than:${REPLY_WINDOW_DAYS}d -in:sent -in:drafts {`)).toBe(true);
      expect(q).not.toContain('in:inbox');
    }
  });
  it('a small set is a single query; no sent emails still searches the ATS senders', () => {
    expect(buildReplyQueries([sent(1)])).toHaveLength(1);
    expect(buildReplyQueries([])).toHaveLength(1);
  });
  it('replyWatchQueries adds an old but still open job (stale, outside the since window) and leaves out a blocked one', () => {
    const db = openDb(':memory:');
    addJob(db, 'old', 'hr@oldco.dev', '2026-01-05 09:00:00', 'OldCo');
    addJob(db, 'done', 'hr@doneco.dev', '2026-01-05 09:00:00', 'DoneCo');
    recordOutcome(db, 'done', 'rejected');
    const qs = replyWatchQueries(db, listSentEmails(db, 30)).join(' ');
    expect(qs).toContain('"OldCo"');
    expect(qs).toContain('from:oldco.dev');
    expect(qs).not.toContain('DoneCo');
  });
});

describe('I2: a job is a follow-up candidate or stale, never both', () => {
  it('one constant: the reply window reaches past the stale threshold', () => {
    expect(STALE_DAYS).toBe(60);
    expect(REPLY_WINDOW_DAYS).toBe(Math.max(60, STALE_DAYS + 10));
  });
  it('59 quiet days: candidate, not stale; 60: stale, not candidate', () => {
    const at = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    for (const [days, cand, stale] of [[59, 1, 0], [60, 0, 1], [80, 0, 1], [10, 1, 0]] as const) {
      const db = openDb(':memory:');
      addJob(db, 'j1', 'priya@zentrix.in', at(days));
      expect(listFollowupCandidates(db, now), `${days}d candidate`).toHaveLength(cand);
      expect(listStale(db, now), `${days}d stale`).toHaveLength(stale);
    }
  });
  it('saveFollowupDraft refuses a stale job', () => {
    const db = openDb(':memory:');
    addJob(db, 'j1', 'priya@zentrix.in', '2026-08-01 09:00:00');
    expect(() => saveFollowupDraft(db, { job_id: 'j1', n: 1, subject: 'Re: Frontend role', body: BODY }, now, pass)).toThrow(/not a follow-up candidate/);
  });
});

describe('I4: claim before send', () => {
  const setup = () => { const db = openDb(':memory:'); addJob(db, 'j1', 'priya@zentrix.in', '2026-09-20 09:00:00'); return db; };
  it('claims once: approved -> sending; a double claim is refused; the claimed row leaves the approved list', () => {
    const db = setup();
    const id = approved(db);
    expect(claimFollowupForSend(db, id)).toBe(true);
    expect(status(db, id)).toBe('sending');
    expect(claimFollowupForSend(db, id)).toBe(false);
    expect(listApprovedFollowups(db)).toEqual([]);
    expect(markFollowupSent(db, id, 'fm')).toEqual({ ok: true, late_block: false });
    expect(claimFollowupForSend(db, id)).toBe(false);
  });
  it('refuses to claim a row whose job is blocked by a reply, and an unknown id', () => {
    const db = setup();
    const id = approved(db);
    db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, action, from_addr) VALUES ('x', 'j1', 'auto_ack', 'ignored', 'priya@zentrix.in')").run();
    expect(claimFollowupForSend(db, id)).toBe(false);
    expect(status(db, id)).toBe('approved');
    expect(claimFollowupForSend(db, 9999)).toBe(false);
  });
  it('a stuck sending row is reported, never re-listed for sending, and blocks a new draft', () => {
    const db = setup();
    const id = approved(db);
    claimFollowupForSend(db, id);
    expect(listStuckSending(db)).toEqual([{ id, job_id: 'j1', n: 1 }]);
    expect(listApprovedFollowups(db)).toEqual([]);
    expect(listFollowupCandidates(db, now)).toEqual([]);
  });
  it('an outcome after the claim leaves the row sending; the send is recorded with late_block', () => {
    const db = setup();
    const id = approved(db);
    claimFollowupForSend(db, id);
    recordOutcome(db, 'j1', 'rejected');
    expect(status(db, id)).toBe('sending');
    expect(markFollowupSent(db, id, 'fm')).toEqual({ ok: true, late_block: true });
    expect(status(db, id)).toBe('sent');
  });
  it('markFollowupFailed accepts a sending row', () => {
    const db = setup();
    const id = approved(db);
    claimFollowupForSend(db, id);
    expect(markFollowupFailed(db, id)).toBe(true);
    expect(status(db, id)).toBe('failed');
  });
});

describe('M1: skipped and cancelled rows can never become sent', () => {
  it('a user-skipped draft is not marked sent', () => {
    const db = openDb(':memory:');
    addJob(db, 'j1', 'priya@zentrix.in', '2026-09-20 09:00:00');
    const id = saveFollowupDraft(db, { job_id: 'j1', n: 1, subject: 'Re: Frontend role', body: BODY }, now, pass).id;
    setFollowupApproval(db, [id], false);
    expect(markFollowupSent(db, id, 'm')).toEqual({ ok: false, late_block: false });
    expect(status(db, id)).toBe('skipped');
  });
  it('an outcome cancels an approved row (drafted -> skipped) and the cancelled row cannot be claimed or sent', () => {
    const db = openDb(':memory:');
    addJob(db, 'j1', 'priya@zentrix.in', '2026-09-20 09:00:00');
    const id = approved(db);
    recordOutcome(db, 'j1', 'replied');
    expect(status(db, id)).toBe('cancelled');
    expect(claimFollowupForSend(db, id)).toBe(false);
    expect(markFollowupSent(db, id, 'm')).toEqual({ ok: false, late_block: false });
    expect(blockedJobIds(db).has('j1')).toBe(true);
  });
});

describe('M6: funnel and patterns use the same contacted set', () => {
  it('an outcome on a never-contacted job does not count as replied; reply rate never exceeds 1', () => {
    const db = openDb(':memory:');
    addJob(db, 'j1', 'priya@zentrix.in', '2026-09-20 09:00:00');
    saveJob(db, { id: 'never', source: 's', title: 't', company: 'X', url: 'u', apply_url: 'u', description: 'd' });
    recordOutcome(db, 'never', 'interview');
    recordOutcome(db, 'ghost', 'offer');
    recordOutcome(db, 'j1', 'replied');
    const f = funnelStats(db);
    expect([f.contacted, f.replied, f.interview, f.offer]).toEqual([1, 1, 0, 0]);
    expect(f.rates.reply).toBe(1);
  });
  it('a contacted job without a jobs row is counted in an unknown bucket', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 5; i++) addJob(db, `j${i}`, `a@co${i}.dev`, '2026-09-20 09:00:00');
    saveApplication(db, { job_id: 'ghost', platform: 'greenhouse', status: 'submitted' });
    const p = patternStats(db);
    expect(p.contacted).toBe(6);
    expect(funnelStats(db).contacted).toBe(6);
    for (const dim of ['score_band', 'ats_vendor', 'remote', 'seniority', 'source'] as const) expect(p.by[dim].find((b) => b.key === 'unknown')?.n, dim).toBeGreaterThanOrEqual(1);
  });
});
