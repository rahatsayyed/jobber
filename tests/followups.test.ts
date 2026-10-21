import { describe, it, expect } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { enqueueOutreach, openDb, recordEmailSent, recordOutcome, recordOutcomeChecked, saveJob, unexcludeJob } from '../src/db.js';
import { resolveReplyProposals, triageReplies } from '../src/replyTriage.js';
import { BANNED_FOLLOWUP, listApprovedFollowups, listFollowupCandidates, listStale, makeGate, markFollowupSent, resolveStale, saveFollowupDraft, setFollowupApproval, type FollowupGate } from '../src/followups.js';

const now = new Date('2026-10-20T12:00:00Z');
const pass: FollowupGate = (text) => ({ verdict: 'pass', invented: [], unsupported: [], forbidden: [], warnings: [], normalized_text: text });
const BODY = 'Hi team, I am still very interested in the Frontend Developer role at Acme and would love to contribute. In my last project I cut load time by 11 seconds, and I think that experience maps well to what your team is building. Could you share a rough timeline for the next steps in the hiring process? Thank you for your time. Best regards, Jane';
const draft = (over: Partial<{ job_id: string; n: number; subject: string; body: string }> = {}) => ({ job_id: 'j1', n: 1, subject: 'Re: Frontend role', body: BODY, ...over });
const save = (db: BetterSqlite3.Database, over: Parameters<typeof draft>[0] = {}, gate: FollowupGate = pass) => saveFollowupDraft(db, draft(over), now, gate);

/** Adds a job whose cold email (and a duplicate recruiter/peer queue row) was sent at `sentAt`. */
function addJob(db: BetterSqlite3.Database, id: string, to: string, sentAt: string) {
  saveJob(db, { id, source: 's', title: 'Frontend Developer', company: 'Acme', url: 'u', apply_url: 'u', description: 'd' });
  const base = { job_id: id, resume_pdf_path: null, email_subject: 'Frontend role', email_body: 'Hi, I cut load time by 11 seconds.', email_to: to, connect_note: 'n', connect_category: 'peer', connect_company: 'Acme', apply_platform: null, apply_url: null };
  const a = enqueueOutreach(db, { ...base, connect_profile_url: `https://linkedin.com/in/${id}a` });
  enqueueOutreach(db, { ...base, connect_profile_url: `https://linkedin.com/in/${id}b` });
  recordEmailSent(db, a, `m-${id}`);
  db.prepare('UPDATE outreach_queue SET email_sent_at = ? WHERE job_id = ?').run(sentAt, id);
}
function setup(sentAt = '2026-10-05 09:00:00') {
  const db = openDb(':memory:');
  addJob(db, 'j1', 'hr@acme.dev', sentAt);
  return db;
}
const processed = (db: BetterSqlite3.Database, message_id: string, job_id: string | null, classification: string, from_addr: string, action = 'ignored') =>
  db.prepare('INSERT INTO processed_messages (message_id, job_id, classification, action, from_addr) VALUES (?, ?, ?, ?, ?)').run(message_id, job_id, classification, action, from_addr);

describe('follow-up candidates', () => {
  it('a job is eligible once after 10 quiet days, counted once despite two queue rows', () => {
    const c = listFollowupCandidates(setup(), now);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ job_id: 'j1', email_to: 'hr@acme.dev', followups_sent: 0, next_n: 1, days_quiet: 15 });
  });
  it('not before 10 days, not after any outcome', () => {
    expect(listFollowupCandidates(setup('2026-10-12 09:00:00'), now)).toEqual([]);
    const db = setup();
    recordOutcome(db, 'j1', 'replied');
    expect(listFollowupCandidates(db, now)).toEqual([]);
  });
  it('a pending draft blocks another; sending resets the clock; a third is never offered', () => {
    const db = setup('2026-09-01 09:00:00');
    const id1 = save(db).id;
    expect(listFollowupCandidates(db, now)).toEqual([]);
    expect(() => save(db)).toThrow(/not a follow-up candidate/);
    expect(setFollowupApproval(db, [id1], true)).toBe(1);
    expect(listApprovedFollowups(db)).toEqual([{ id: id1, job_id: 'j1', n: 1, subject: 'Re: Frontend role', body: BODY, body_html: expect.stringContaining('<p'), email_to: 'hr@acme.dev', thread_id: null }]);
    expect(markFollowupSent(db, id1, 'fm1')).toEqual({ ok: true, late_block: false });
    expect(markFollowupSent(db, id1, 'fm1')).toEqual({ ok: false, late_block: false });
    db.prepare("UPDATE followups SET sent_at = '2026-10-01 09:00:00' WHERE id = ?").run(id1);
    const c2 = listFollowupCandidates(db, now);
    expect(c2[0]).toMatchObject({ next_n: 2, followups_sent: 1, days_quiet: 19 });
    const id2 = save(db, { n: 2 }).id;
    setFollowupApproval(db, [id2], true);
    markFollowupSent(db, id2, 'fm2');
    db.prepare("UPDATE followups SET sent_at = '2026-10-02 09:00:00' WHERE id = ?").run(id2);
    expect(listFollowupCandidates(db, now)).toEqual([]);
  });
  it('a skipped draft counts the skip time as the last contact, so the job is not re-drafted at once', () => {
    const db = setup('2026-09-01 09:00:00');
    const id = save(db).id;
    setFollowupApproval(db, [id], false);
    db.prepare("UPDATE followups SET decided_at = '2026-10-15 09:00:00' WHERE id = ?").run(id);
    expect(listFollowupCandidates(db, now)).toEqual([]);
    db.prepare("UPDATE followups SET decided_at = '2026-10-05 09:00:00' WHERE id = ?").run(id);
    expect(listFollowupCandidates(db, now)[0]).toMatchObject({ job_id: 'j1', next_n: 1, days_quiet: 15 });
  });
  it('rejects a draft with the wrong n', () => {
    expect(() => save(setup(), { n: 2 })).toThrow(/expected follow-up #1/);
  });
  it('a deadline-excluded job (Plan 2 excluded_reason) that was emailed keeps its follow-up, whatever the reason, and a manual include override changes nothing (plan 2 AF1/W9)', () => {
    const db = setup();
    db.prepare("UPDATE jobs SET excluded_reason = 'deadline passed: 2026-10-01' WHERE id = 'j1'").run();
    expect(listFollowupCandidates(db, now)).toHaveLength(1);
    db.prepare("UPDATE jobs SET excluded_reason = 'legitimacy: suspicious' WHERE id = 'j1'").run();
    expect(listFollowupCandidates(db, now)).toHaveLength(1);
    expect(unexcludeJob(db, 'j1')).toMatchObject({ ok: true });
    expect(db.prepare('SELECT count(*) AS n FROM job_exclusion_log WHERE job_id = ?').get('j1')).toEqual({ n: 1 });
    expect(listFollowupCandidates(db, now)).toHaveLength(1);
    const id = save(db).id;
    setFollowupApproval(db, [id], true);
    db.prepare("UPDATE jobs SET excluded_reason = 'deadline passed: 2026-10-01' WHERE id = 'j1'").run();
    expect(listApprovedFollowups(db).map((a) => a.id)).toEqual([id]);
  });
});

describe('who must never get a follow-up', () => {
  it('a non-noise processed reply for the job blocks it (even an unresolved or skipped proposal, or a bounce); an ignored auto-ack or noise blocks only when the sender is a human (C1)', () => {
    for (const cls of ['replied', 'rejected', 'offer', 'interview', 'bounce', 'unknown']) {
      const db = setup();
      processed(db, 'x', 'j1', cls, 'hr@acme.dev', 'proposed');
      expect(listFollowupCandidates(db, now), cls).toEqual([]);
    }
    // Final fix round C1 (expectation changed): an ignored auto_ack/noise matched to the job from a HUMAN address now blocks (was: did not).
    for (const cls of ['auto_ack', 'noise']) {
      const db = setup();
      processed(db, 'x', 'j1', cls, 'hr@acme.dev');
      expect(listFollowupCandidates(db, now), cls).toEqual([]);
    }
    // Automated senders keep the old behaviour: an ignored auto-ack/noise from them does not block.
    for (const [cls, from] of [['auto_ack', 'no-reply@acme.dev'], ['noise', 'alerts@linkedin.com'], ['auto_ack', 'notifications@greenhouse.io']]) {
      const db = setup();
      processed(db, 'x', 'j1', cls, from);
      expect(listFollowupCandidates(db, now), `${cls} ${from}`).toHaveLength(1);
    }
  });
  it('an unmatched human reply from the exact address blocks every job sent to that address', () => {
    const db = setup();
    processed(db, 'x', null, 'replied', 'hr@acme.dev');
    expect(listFollowupCandidates(db, now)).toEqual([]);
  });
  it('a contact who rejected job A is not followed up for job B at the same address', () => {
    const db = setup();
    addJob(db, 'j2', 'HR@acme.dev', '2026-10-05 09:00:00');
    recordOutcome(db, 'j1', 'rejected');
    expect(listFollowupCandidates(db, now)).toEqual([]);
  });
  it('a bounced address blocks other jobs sent to it, but not jobs at other addresses', () => {
    const db = setup();
    addJob(db, 'j2', 'hr@acme.dev', '2026-10-05 09:00:00');
    addJob(db, 'j3', 'other@globex.io', '2026-10-05 09:00:00');
    processed(db, 'b', 'j1', 'bounce', 'mailer-daemon@googlemail.com', 'bounced');
    expect(listFollowupCandidates(db, now).map((c) => c.job_id)).toEqual(['j3']);
  });
  it('an approved follow-up disappears from the approved list once an outcome or a reply exists, and recording an outcome marks pending follow-ups skipped', () => {
    const db = setup('2026-09-01 09:00:00');
    const a = save(db).id;
    setFollowupApproval(db, [a], true);
    expect(listApprovedFollowups(db)).toHaveLength(1);
    processed(db, 'x', 'j1', 'replied', 'hr@acme.dev', 'proposed');
    expect(listApprovedFollowups(db)).toEqual([]);
    const db2 = setup('2026-09-01 09:00:00');
    const b = save(db2).id;
    setFollowupApproval(db2, [b], true);
    recordOutcome(db2, 'j1', 'rejected');
    // Final fix round M1 (expectations changed): an approved row is now `cancelled` (was `skipped`) and can never be marked sent (was ok: true),
    // since it was never claimed for sending. A claimed (`sending`) row keeps the late_block path: see the claim tests below.
    expect(db2.prepare('SELECT status FROM followups WHERE id = ?').get(b)).toEqual({ status: 'cancelled' });
    expect(listApprovedFollowups(db2)).toEqual([]);
    expect(markFollowupSent(db2, b, 'm')).toEqual({ ok: false, late_block: false });
  });
});

describe('follow-up emphasis markers', () => {
  it('stores the plain body (markers stripped, word count on plain text), builds the html in code, and never leaks a marker into the subject', () => {
    const db = setup('2026-09-01 09:00:00');
    const marked = BODY.replace('Frontend Developer role', '**Frontend Developer role**');
    expect(marked).not.toBe(BODY);
    const r = save(db, { body: marked, subject: 'Re: **Frontend** role' });
    expect(r.body).toBe(BODY);
    const row = db.prepare('SELECT subject, body, body_html FROM followups WHERE id = ?').get(r.id) as { subject: string; body: string; body_html: string };
    expect(row.body).toBe(BODY);
    expect(row.body_html).toContain('<strong>Frontend Developer role</strong>');
    expect(row.subject).toBe('Re: Frontend role');
  });
});

describe('saveFollowupDraft runs the gate and the style rules itself', () => {
  it('refuses a gate "block" and stores nothing', () => {
    const db = setup();
    const block: FollowupGate = () => ({ verdict: 'block', invented: ['metric:73%'], unsupported: [], forbidden: [], warnings: [], normalized_text: '' });
    expect(() => save(db, {}, block)).toThrow(/fact gate blocked this draft: metric:73%/);
    expect(db.prepare('SELECT count(*) AS n FROM followups').get()).toEqual({ n: 0 });
  });
  it('passes the original email as extra source plus job title and company, and stores the NORMALIZED text', () => {
    const db = setup();
    let ctx: any;
    const spy: FollowupGate = (text, c) => { ctx = c; return { ...pass(text, c), warnings: ['phrase:leverage'], normalized_text: text.replace(/I am/g, "I'm") }; };
    const r = save(db, {}, spy);
    expect(ctx).toEqual({ extraSource: 'Frontend role\n\nHi, I cut load time by 11 seconds.', jobTitle: 'Frontend Developer', company: 'Acme' });
    expect(r.body.startsWith("Hi team, I'm still")).toBe(true);
    expect(r.warnings).toEqual(['phrase:leverage']);
    expect(db.prepare('SELECT subject, body FROM followups WHERE id = ?').get(r.id)).toEqual({ subject: 'Re: Frontend role', body: r.body });
  });
  it('enforces the Re: subject, 40-120 words, a blank line after the subject, and the banned phrases', () => {
    const db = setup();
    expect(() => save(db, { subject: 'Frontend role' })).toThrow(/subject must be exactly "Re: Frontend role"/);
    expect(() => save(db, { subject: 'Re: Frontend role\nBcc: x@y.z' })).toThrow(/single line/);
    expect(() => save(db, { body: 'Short note.' })).toThrow(/40-120 words, got 2/);
    expect(() => save(db, { body: Array(130).fill('word').join(' ') })).toThrow(/40-120 words, got 130/);
    expect(() => saveFollowupDraft(db, draft(), now, (t, c) => ({ ...pass(t, c), normalized_text: t.replace('\n\n', '\n') }))).toThrow(/blank line/);
    for (const phrase of ['Just following up on my note.', 'Bumping this to the top of your inbox.', 'Any update on the role?', 'Just checking in.', 'Touching base again.', 'Circling back on this.', 'A gentle reminder about my email.']) {
      expect(() => save(db, { body: `${BODY} ${phrase}` }), phrase).toThrow(/banned phrase/);
    }
    expect(BANNED_FOLLOWUP.test(BODY)).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM followups').get()).toEqual({ n: 0 });
  });
  it('the real gate (checkTextWithNormalized) blocks a new metric and passes the original email facts', () => {
    const gate = makeGate(() => ({ basics: { name: 'Jane', summary: 'Frontend developer building React apps.' } }));
    const db = setup();
    expect(() => save(db, { body: `${BODY} Since then I also cut our build time by 73%.` }, gate)).toThrow(/fact gate blocked/);
    expect(save(db, {}, gate).id).toBeGreaterThan(0);
  });
});

describe('stale sweep', () => {
  it('lists 60-day silence and post-2-follow-up silence, records no_response on resolve', () => {
    const db = setup('2026-08-01 09:00:00');
    expect(listStale(db, now)).toEqual([{ job_id: 'j1', company: 'Acme', title: 'Frontend Developer', days_quiet: 80, followups_sent: 0, why: 'silent 60+ days' }]);
    expect(resolveStale(db, ['j1', 'nope'], now)).toEqual({ recorded: ['j1'], skipped: ['nope'] });
    expect(db.prepare('SELECT outcome, note FROM job_outcomes').get()).toEqual({ outcome: 'no_response', note: 'stale resolved no_response (2026-10-20)' });
    expect(listStale(db, now)).toEqual([]);
  });
  it('never lists a job with a reply or bounce on file (the user decides those), but still lists a deadline-excluded job', () => {
    const db = setup('2026-08-01 09:00:00');
    db.prepare("UPDATE jobs SET excluded_reason = 'deadline passed: 2026-10-01' WHERE id = 'j1'").run();
    expect(listStale(db, now)).toHaveLength(1);
    processed(db, 'x', 'j1', 'rejected', 'hr@acme.dev', 'proposed');
    expect(listStale(db, now)).toEqual([]);
    expect(resolveStale(db, ['j1'], now)).toEqual({ recorded: [], skipped: ['j1'] });
  });
});

describe('every outcome path ends pending follow-ups (ruling Y4, one helper in db.ts)', () => {
  const pending = (db: BetterSqlite3.Database) => {
    const id = save(db).id;
    setFollowupApproval(db, [id], true);
    return id;
  };
  const status = (db: BetterSqlite3.Database, id: number) => (db.prepare('SELECT status FROM followups WHERE id = ?').get(id) as { status: string }).status;
  it('recordOutcome (drafted and approved rows)', () => {
    const db = setup('2026-09-01 09:00:00');
    const id = save(db).id;
    expect(status(db, id)).toBe('drafted');
    recordOutcome(db, 'j1', 'replied');
    expect(status(db, id)).toBe('skipped');
  });
  it('recordOutcomeChecked (the record_outcome MCP tool path)', () => {
    const db = setup('2026-09-01 09:00:00');
    const id = pending(db);
    recordOutcomeChecked(db, 'j1', 'rejected', 'n');
    expect(status(db, id)).toBe('cancelled'); // M1: approved rows are cancelled (was skipped)
  });
  it('auto-record in triageReplies', () => {
    const db = setup('2026-09-01 09:00:00');
    db.prepare("UPDATE outreach_queue SET email_thread_id = 't-j1' WHERE job_id = 'j1'").run();
    const id = pending(db);
    const r = triageReplies(db, [{ message_id: 'a', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: Frontend role', body: 'Could you share your availability for a call?' }], { config: { auto_record_enabled: true } });
    expect(r.auto_recorded).toHaveLength(1);
    expect(status(db, id)).toBe('cancelled'); // M1 (was skipped)
    expect(listApprovedFollowups(db)).toEqual([]);
  });
  it('resolveReplyProposals approve (an unresolved proposal already hides the approved follow-up from the send list)', () => {
    const db = setup('2026-09-01 09:00:00');
    db.prepare("UPDATE outreach_queue SET email_thread_id = 't-j1' WHERE job_id = 'j1'").run();
    const id = pending(db);
    triageReplies(db, [{ message_id: 'c', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Offer', body: 'We are pleased to offer you the role.' }], { config: { auto_record_enabled: false } });
    expect(status(db, id)).toBe('approved');
    expect(listApprovedFollowups(db)).toEqual([]);
    expect(resolveReplyProposals(db, [{ message_id: 'c', approve: true }]).recorded).toBe(1);
    expect(status(db, id)).toBe('cancelled'); // M1 (was skipped)
  });
  it('resolveStale', () => {
    const db = setup('2026-08-01 09:00:00');
    db.prepare("INSERT INTO followups (job_id, n, subject, body, status) VALUES ('j1', 1, 's', 'b', 'approved')").run();
    expect(resolveStale(db, ['j1'], now).recorded).toEqual(['j1']);
    expect(db.prepare('SELECT status FROM followups').get()).toEqual({ status: 'cancelled' }); // M1 (was skipped)
  });
  it('only affects that job', () => {
    const db = setup('2026-09-01 09:00:00');
    addJob(db, 'j2', 'jobs@globex.io', '2026-09-01 09:00:00');
    const a = pending(db);
    const b = saveFollowupDraft(db, draft({ job_id: 'j2' }), now, pass).id;
    recordOutcome(db, 'j1', 'replied');
    expect(status(db, a)).toBe('cancelled'); // M1 (was skipped)
    expect(status(db, b)).toBe('drafted');
  });
});

describe('fix round 1', () => {
  it('Z1: no_response blocks its own job but not siblings at the same address; a real outcome still does', () => {
    const db = setup();
    addJob(db, 'j2', 'hr@acme.dev', '2026-10-05 09:00:00');
    recordOutcome(db, 'j1', 'no_response');
    expect(listFollowupCandidates(db, now).map((c) => c.job_id)).toEqual(['j2']);
    recordOutcome(db, 'j1', 'rejected');
    expect(listFollowupCandidates(db, now)).toEqual([]);
  });
  it('a reply from `Jane <hr@x.com>` with no job match blocks a sibling job at hr@x.com', () => {
    const db = openDb(':memory:');
    addJob(db, 'j1', 'HR@x.com', '2026-10-05 09:00:00');
    processed(db, 'x', null, 'replied', 'Jane <hr@x.com>');
    expect(listFollowupCandidates(db, now)).toEqual([]);
    const db2 = openDb(':memory:');
    addJob(db2, 'j1', 'hr@x.com', '2026-10-05 09:00:00');
    processed(db2, 'x', null, 'replied', 'Jane <other@x.com>');
    expect(listFollowupCandidates(db2, now)).toHaveLength(1);
  });
  it('setFollowupApproval refuses a draft whose job became blocked (marks it skipped, returns 0)', () => {
    const db = setup('2026-09-01 09:00:00');
    const id = save(db).id;
    processed(db, 'x', 'j1', 'replied', 'hr@acme.dev', 'proposed');
    expect(setFollowupApproval(db, [id], true)).toBe(0);
    expect(db.prepare('SELECT status FROM followups WHERE id = ?').get(id)).toEqual({ status: 'skipped' });
  });
  it('markFollowupSent after the email went out records the truth: stays sent (with message id) and reports late_block', () => {
    const db = setup('2026-09-01 09:00:00');
    const id = save(db).id;
    setFollowupApproval(db, [id], true);
    processed(db, 'x', 'j1', 'bounce', 'mailer-daemon@g.com', 'bounced');
    expect(markFollowupSent(db, id, 'm')).toEqual({ ok: true, late_block: true });
    expect(db.prepare('SELECT status, message_id FROM followups WHERE id = ?').get(id)).toEqual({ status: 'sent', message_id: 'm' });
  });
});

describe('Y4 address and bounce rules', () => {
  it('a processed message with a job id that was acted on (bounced/proposed/recorded) blocks, even with a noise-like class', () => {
    for (const action of ['bounced', 'proposed', 'recorded', 'approved', 'skipped']) {
      const db = setup();
      processed(db, 'x', 'j1', 'noise', 'x@y.z', action);
      expect(listFollowupCandidates(db, now), action).toEqual([]);
    }
  });
  it('a non-noise message from the exact address blocks all jobs sent there, an ignored noise one does not', () => {
    const db = setup();
    addJob(db, 'j2', 'hr@acme.dev', '2026-10-05 09:00:00');
    processed(db, 'x', 'j1', 'replied', 'HR@acme.dev', 'proposed');
    expect(listFollowupCandidates(db, now)).toEqual([]);
    const db2 = setup();
    processed(db2, 'x', null, 'noise', 'hr@acme.dev');
    expect(listFollowupCandidates(db2, now)).toHaveLength(1);
  });
});
