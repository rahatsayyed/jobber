// Claude's revise step for an automatic email reply: every gate re-runs on the new text, the code draft stays on any refusal, at most 2 rewrites,
// the claim sends the revised text. Fakes only: in-memory db, no Gmail, no tmux.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { enqueueOutreach, openDb, recordEmailSent, saveJob, setEmailThread } from '../src/db.js';
import { triageReplies } from '../src/replyTriage.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { claimEmailReplyForSend, draftEmailReply, getReplyForRevision, makeReplyFactCheck, markEmailReplySent, reviseEmailReply } from '../src/outreach/emailReplies.js';
import { migrateEmailReplies } from '../src/outreach/emailRepliesSchema.js';
import type { ReplyFacts, ReplyFactsState } from '../src/outreach/replyFacts.js';
import { recordReplyCheck } from '../src/followups.js';
import { formatEmailReplyNotice } from '../src/scheduler/dripNotice.js';

const NOW = new Date('2026-10-15T08:00:00.000Z');
const BASE = JSON.parse(readFileSync('user-data.example/resume.json', 'utf8')) as Record<string, any>;
const FACTS: ReplyFacts = {
  current_ctc: '12 LPA fixed', expected_ctc: '18 LPA', notice_period: '30 days', current_location: 'Pune',
  open_to_relocate: 'Yes, open to relocating within India', available_from: 'within 30 days', work_authorization: 'Indian citizen, no visa needed',
};
const READY: ReplyFactsState = { status: 'ready', facts: FACTS };
const ON = { EMAIL_AUTO_REPLY: 'true' } as NodeJS.ProcessEnv;
const OFF = { EMAIL_AUTO_REPLY: 'false' } as NodeJS.ProcessEnv;
const gate = makeReplyFactCheck(FACTS, () => BASE);
const rd = (env: NodeJS.ProcessEnv = ON, facts: ReplyFactsState = READY) => ({ env, facts, styleCfg: DEFAULT_STYLE_CONFIG, factCheck: gate, now: NOW });

function setup(ask = 'Hi, what is your expected CTC? And your notice period?') {
  const db = openDb(':memory:');
  saveJob(db, { id: 'j1', source: 's', title: 'Full Stack Developer', company: 'Acme', url: 'u', apply_url: 'u', description: 'd' });
  db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('Acme', 'hr@acme.example', 'hr', 1, 't', 0.9)").run();
  const q = enqueueOutreach(db, { job_id: 'j1', resume_pdf_path: null, email_subject: 'Full Stack Developer', email_body: 'Hi', email_to: 'hr@acme.example', connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: null, apply_url: null });
  recordEmailSent(db, q, 'm-j1');
  setEmailThread(db, 'm-j1', 't1');
  db.prepare("UPDATE outreach_queue SET email_sent_at = '2026-09-01 00:00:00' WHERE job_id = 'j1'").run();
  triageReplies(db, [{ message_id: 'in1', thread_id: 't1', from: 'Priya <hr@acme.example>', subject: 'Re: Full Stack Developer', date: null, body: ask }], { config: { auto_record_enabled: false } });
  const r = draftEmailReply(db, 'in1', { now: NOW, env: ON, facts: READY, styleCfg: DEFAULT_STYLE_CONFIG, factCheck: gate, ownerName: 'Jane Doe' });
  if (!r.ok) throw new Error(r.reason);
  const row = () => db.prepare('SELECT * FROM email_replies WHERE id = ?').get(r.id) as Record<string, any>;
  return { db, id: r.id, row, draft: row().body as string };
}

const GOOD = 'Hi,\n\nThank you for your message.\nMy expected CTC is 18 LPA and my notice period is 30 days.\n\nRegards,\nJane Doe';

describe('reviseEmailReply', () => {
  it('stores a good rewrite, keeps the code draft, counts the revision', () => {
    const w = setup();
    expect(reviseEmailReply(w.db, w.id, GOOD, rd())).toEqual({ ok: true, revisions: 1 });
    const row = w.row();
    expect(row.body).toBe(GOOD);
    expect(row.draft_body).toBe(w.draft);
    expect(row.revisions).toBe(1);
    expect(row.revised_at).toBeTruthy();
    expect(row.status).toBe('approved');
  });

  it.each([
    ['a number that is not in the facts', GOOD.replace('18 LPA', '18 LPA (up to 25 LPA)'), /number|not one of/],
    ['a link', `${GOOD}\nSee https://example.com/me`, /link/],
    ['a bare domain', `${GOOD}\nSee example.com`, /link/],
    ['an email address', `${GOOD}\nMail me at me@x.example`, /email/],
    ['a phone number', `${GOOD}\nCall +91 98765 43210`, /phone/],
    ['markdown', GOOD.replace('18 LPA', '**18 LPA**'), /markdown|plain/],
    ['text over 700 characters', `${GOOD}\n${'Thank you very much for reaching out. '.repeat(20)}`, /700/],
    ['a dropped asked fact', 'Hi,\n\nMy expected CTC is 18 LPA.\n\nRegards,\nJane Doe', /asked fact/],
    ['a fact nobody asked for', GOOD.replace('Regards', 'I currently earn 12 LPA fixed.\n\nRegards'), /did not ask|not one of/],
    ['a promise of a call', GOOD.replace('Regards', 'Happy to talk on a call.\n\nRegards'), /promises|calls/],
    ['a date', GOOD.replace('Regards', 'I can join in November.\n\nRegards'), /promises|calls/],
    ['another language script', GOOD.replace('Thank you', 'Dhanyavaad धन्यवाद'), /plain English/],
    ['an em dash', GOOD.replace('and my', '— and my'), /plain English|style/],
    ['an empty body', '   ', /empty/],
  ])('refuses %s and the code draft stays', (_n, body, re) => {
    const w = setup();
    const r = reviseEmailReply(w.db, w.id, body, rd());
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(re);
    const row = w.row();
    expect(row.body).toBe(w.draft);
    expect(row.revisions).toBe(0);
    expect(row.draft_body).toBeNull();
  });

  it('refuses a style-rule hit (banned phrase)', () => {
    const w = setup();
    const r = reviseEmailReply(w.db, w.id, GOOD.replace('Thank you for your message.', 'I hope this finds you well.'), rd());
    expect(r).toMatchObject({ ok: false });
    expect(w.row().body).toBe(w.draft);
  });

  it('allows at most 2 revisions', () => {
    const w = setup();
    expect(reviseEmailReply(w.db, w.id, GOOD, rd())).toMatchObject({ ok: true, revisions: 1 });
    const second = GOOD.replace('Thank you for your message.', 'Thanks for writing.');
    expect(reviseEmailReply(w.db, w.id, second, rd())).toMatchObject({ ok: true, revisions: 2 });
    const third = GOOD.replace('Thank you for your message.', 'Thanks a lot.');
    expect(reviseEmailReply(w.db, w.id, third, rd())).toMatchObject({ ok: false, reason: expect.stringMatching(/already revised 2/) });
    expect(w.row().body).toBe(second);
    expect(w.row().draft_body).toBe(w.draft);
  });

  it('an unchanged body is ok and does not use up a revision', () => {
    const w = setup();
    expect(reviseEmailReply(w.db, w.id, w.draft, rd())).toMatchObject({ ok: true, revisions: 0, unchanged: true });
    expect(w.row().revisions).toBe(0);
  });

  it('refuses with the flag off, with facts not ready, for an unknown id', () => {
    const w = setup();
    expect(reviseEmailReply(w.db, w.id, GOOD, rd(OFF))).toMatchObject({ ok: false, reason: expect.stringMatching(/EMAIL_AUTO_REPLY/) });
    expect(reviseEmailReply(w.db, w.id, GOOD, rd(ON, { status: 'unconfirmed', facts: FACTS }))).toMatchObject({ ok: false });
    expect(reviseEmailReply(w.db, 999, GOOD, rd())).toMatchObject({ ok: false, reason: 'no such reply' });
    expect(w.row().revisions).toBe(0);
  });

  it('a claimed or sent row cannot be revised', () => {
    const w = setup();
    recordReplyCheck(w.db, { messages: 0, errors: 0 }, NOW);
    expect(claimEmailReplyForSend(w.db, w.id, { now: NOW, maxAgeMin: 30, sendLimit: 100000, env: ON })).toMatchObject({ claimed: true });
    expect(reviseEmailReply(w.db, w.id, GOOD, rd())).toMatchObject({ ok: false, reason: expect.stringMatching(/sending/) });
    markEmailReplySent(w.db, w.id, 'gm1');
    expect(reviseEmailReply(w.db, w.id, GOOD, rd())).toMatchObject({ ok: false, reason: expect.stringMatching(/sent/) });
    expect(w.row().body).toBe(w.draft);
  });

  it('the claim returns exactly the revised text', () => {
    const w = setup();
    reviseEmailReply(w.db, w.id, GOOD, rd());
    recordReplyCheck(w.db, { messages: 0, errors: 0 }, NOW);
    const c = claimEmailReplyForSend(w.db, w.id, { now: NOW, maxAgeMin: 30, sendLimit: 100000, env: ON });
    expect(c).toMatchObject({ claimed: true, body: GOOD, to: 'hr@acme.example', subject: 'Re: Full Stack Developer' });
  });
});

describe('getReplyForRevision', () => {
  it('shows the draft, the asked kinds, only the asked fact values and a short labelled excerpt', () => {
    const w = setup();
    const v = getReplyForRevision(w.db, w.id, READY) as Record<string, any>;
    expect(v.draft).toBe(w.draft);
    expect(v.kinds).toEqual(['ctc_expected', 'notice_period']);
    expect(v.facts).toEqual({ expected_ctc: '18 LPA', notice_period: '30 days' });
    expect(v.revisions_left).toBe(2);
    expect(v.inbound_excerpt_untrusted).toContain('expected CTC');
    expect(v.inbound_excerpt_untrusted.length).toBeLessThanOrEqual(600);
    expect(getReplyForRevision(w.db, 999, READY)).toEqual({ error: 'no such reply' });
  });
});

describe('schema migration', () => {
  it('adds the revise columns to an old email_replies table, twice safely', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(`CREATE TABLE email_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, job_id TEXT, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'drafted', reply_message_id TEXT, note TEXT, created_at TEXT, approved_at TEXT, sent_at TEXT)`);
    db.prepare("INSERT INTO email_replies (message_id, thread_id, to_addr, subject, body, kind) VALUES ('m', 't', 'a@b.example', 's', 'b', 'notice_period')").run();
    migrateEmailReplies(db);
    migrateEmailReplies(db);
    const cols = (db.prepare('PRAGMA table_info(email_replies)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['draft_body', 'revisions', 'revised_at']));
    expect(db.prepare('SELECT revisions, draft_body FROM email_replies').get()).toEqual({ revisions: 0, draft_body: null });
  });
});

describe('notice and wiring', () => {
  it('the sent notice says when Claude improved the wording', () => {
    const base = { address: 'hr@acme.example', subject: 'Re: x', body: 'Hi', kinds: ['notice_period'], company: 'Acme', title: 'Dev', dry: false, outcome: 'sent' as const };
    expect(formatEmailReplyNotice({ ...base, revised: true })).toContain('improved by Claude');
    expect(formatEmailReplyNotice(base)).not.toContain('improved by Claude');
  });
  it('the agent file lists the two tools and no Gmail read tool', () => {
    const t = readFileSync('.claude/agents/mail-operator.md', 'utf8');
    expect(t).toContain('mcp__db__revise_email_reply');
    expect(t).toContain('mcp__db__get_email_reply_for_revision');
    expect(t).not.toMatch(/mcp__gmail__(read_email|search_emails)/);
  });
});
