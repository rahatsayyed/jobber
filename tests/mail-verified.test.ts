// Safety rule 1 at the db layer: an address with no verified contacts row is never handed to the sender and never claimed for a follow-up.
import { describe, it, expect } from 'vitest';
import { enqueueOutreach, listExcludedQueuedOutreach, listQueuedOutreach, openDb, recordEmailSent, saveContact, saveJob } from '../src/db.js';
import { claimFollowupForSend, claimFollowupGuarded, recordReplyCheck, saveFollowupDraft, setFollowupApproval, type FollowupGate } from '../src/followups.js';
import { UNVERIFIED_ADDRESS, addrOf, isVerifiedAddress } from '../src/lib/verifiedAddress.js';
import { postEmailContact } from '../src/lib/postEmail.js';
import { POST_SOURCE } from '../src/lib/postSignals.js';

const contact = (db: ReturnType<typeof openDb>, email: string, verified: number, source = 't') =>
  db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('C', ?, 'hr', ?, ?, 0.5)").run(email, verified, source);

describe('isVerifiedAddress', () => {
  it('no row, unverified row, verified row, case, display name form, junk', () => {
    const db = openDb(':memory:');
    expect(isVerifiedAddress(db, 'a@x.example')).toBe(false); // no contacts row
    contact(db, 'a@x.example', 0);
    expect(isVerifiedAddress(db, 'a@x.example')).toBe(false);
    contact(db, 'B@X.example', 1);
    expect(isVerifiedAddress(db, 'b@x.EXAMPLE')).toBe(true);
    expect(isVerifiedAddress(db, 'Bob <b@x.example>')).toBe(true);
    expect(isVerifiedAddress(db, 'c@x.example')).toBe(false);
    expect(isVerifiedAddress(db, 'b@x.example, c@x.example')).toBe(false);
    expect(isVerifiedAddress(db, null)).toBe(false);
    expect(isVerifiedAddress(db, '')).toBe(false);
    expect(addrOf(' Bob <B@X.example> ')).toBe('b@x.example');
  });
  it('a verified post contact counts, a free-mail address has no verified row', () => {
    const db = openDb(':memory:');
    contact(db, 'jobs@startup.example', 1, 'post');
    expect(isVerifiedAddress(db, 'jobs@startup.example')).toBe(true);
    expect(isVerifiedAddress(db, 'someone@gmail.com')).toBe(false);
  });
});

describe('listQueuedOutreach (what the mail-operator reads)', () => {
  function queued(db: ReturnType<typeof openDb>, id: string, to: string | null, profile: string) {
    db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES (?, 't', 'T', 'C', 'u')").run(id);
    return enqueueOutreach(db, { job_id: id, resume_pdf_path: null, email_subject: 's', email_body: 'b', email_to: to, connect_note: 'n', connect_profile_url: profile, connect_category: 'peer', connect_company: 'C', apply_platform: null, apply_url: null });
  }
  it('withholds the email address of an unverified row (refusal unverified_address) and keeps the row for other channels', () => {
    const db = openDb(':memory:');
    const none = queued(db, 'j1', 'none@x.example', 'https://linkedin.com/in/1');
    const bad = queued(db, 'j2', 'bad@x.example', 'https://linkedin.com/in/2');
    const ok = queued(db, 'j3', 'Ok@x.example', 'https://linkedin.com/in/3');
    const noMail = queued(db, 'j4', null, 'https://linkedin.com/in/4');
    contact(db, 'bad@x.example', 0);
    contact(db, 'ok@X.example', 1);
    const rows = Object.fromEntries(listQueuedOutreach(db).map((r) => [r.id, r]));
    expect(rows[none].email_to).toBeNull();
    expect(rows[none].email_refused).toBe(UNVERIFIED_ADDRESS);
    expect(rows[bad].email_to).toBeNull();
    expect(rows[bad].email_refused).toBe(UNVERIFIED_ADDRESS);
    expect(rows[ok].email_to).toBe('Ok@x.example');
    expect(rows[ok].email_refused).toBeUndefined();
    expect(rows[noMail].email_to).toBeNull();
    expect(rows[noMail].email_refused).toBeUndefined();
  });
  it('the skipped listing can report the refused rows', () => {
    const db = openDb(':memory:');
    const id = queued(db, 'j1', 'none@x.example', 'https://linkedin.com/in/1');
    expect(listExcludedQueuedOutreach(db, { includeUnverified: true })).toEqual([{ id, job_id: 'j1', reason: UNVERIFIED_ADDRESS }]);
    expect(listExcludedQueuedOutreach(db)).toEqual([]);
  });
});

describe('postEmailContact (a hiring-post email goes through the same verification)', () => {
  // contacts.find_company_emails saves the post contact with saveContact (src/mcp/contacts.ts); the send check reads that same table.
  const run = async (db: ReturnType<typeof openDb>, email: string, verify: boolean) => {
    const c = await postEmailContact({ source: POST_SOURCE, apply_email: email }, 'Startup', async () => verify);
    if (c) saveContact(db, c);
    return c;
  };
  it('a verified post email is stored as a verified contact, so the send check passes', async () => {
    const db = openDb(':memory:');
    expect(await run(db, 'Hiring@Startup.example', true)).toMatchObject({ email: 'hiring@startup.example', verified: true, source: 'post' });
    expect(isVerifiedAddress(db, 'HIRING@startup.example')).toBe(true);
  });
  it('an address that fails verification is stored unverified and refused', async () => {
    const db = openDb(':memory:');
    await run(db, 'hiring@startup.example', false);
    expect(isVerifiedAddress(db, 'hiring@startup.example')).toBe(false);
  });
  it('free-mail is never verified, even when the verifier would say yes', async () => {
    const db = openDb(':memory:');
    expect(await run(db, 'someone@gmail.com', true)).toMatchObject({ verified: false });
    expect(isVerifiedAddress(db, 'someone@gmail.com')).toBe(false);
  });
});

describe('follow-up claim', () => {
  const pass: FollowupGate = (text) => ({ verdict: 'pass', invented: [], unsupported: [], forbidden: [], warnings: [], normalized_text: text });
  const BODY = 'Hi team, I am still very interested in the Frontend Developer role at Acme and would love to contribute. In my last project I cut load time by 11 seconds, and I think that experience maps well to what your team is building. Could you share a rough timeline for the next steps in the hiring process? Thank you for your time. Best regards, Jane';
  function approved(verified: boolean | 'unverified-row') {
    const db = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 's', title: 'Frontend Developer', company: 'Acme', url: 'u', apply_url: 'u', description: 'd' });
    const q = enqueueOutreach(db, { job_id: 'j1', resume_pdf_path: null, email_subject: 'Frontend role', email_body: 'b', email_to: 'hr@acme.dev', connect_note: 'n', connect_profile_url: 'https://linkedin.com/in/x', connect_category: 'peer', connect_company: 'Acme', apply_platform: null, apply_url: null });
    recordEmailSent(db, q, 'm1');
    db.prepare("UPDATE outreach_queue SET email_sent_at = '2026-10-01 10:00:00' WHERE id = ?").run(q);
    if (verified === true) contact(db, 'HR@acme.dev', 1);
    if (verified === 'unverified-row') contact(db, 'hr@acme.dev', 0);
    const now = new Date('2026-10-20T12:00:00Z');
    const id = saveFollowupDraft(db, { job_id: 'j1', n: 1, subject: 'Re: Frontend role', body: BODY }, now, pass, { mode: 'autonomous', gapsDays: [3, 4, 5, 7] }).id;
    setFollowupApproval(db, [id], true);
    recordReplyCheck(db, { messages: 1, errors: 0 }, now);
    return { db, id, now };
  }
  it('refuses with unverified_address when no verified contact exists (legacy and autonomous claims)', () => {
    for (const v of [false, 'unverified-row'] as const) {
      const { db, id, now } = approved(v);
      expect(claimFollowupGuarded(db, id, { now, maxAgeMin: 30, sendLimit: 5 })).toEqual({ claimed: false, reason: UNVERIFIED_ADDRESS });
      expect(claimFollowupForSend(db, id)).toBe(false);
      expect(db.prepare("SELECT count FROM daily_counters WHERE key = 'send_email'").get()).toBeUndefined();
      expect(db.prepare('SELECT status FROM followups WHERE id = ?').get(id)).toEqual({ status: 'approved' });
    }
  });
  it('claims when the address is verified, whatever its case', () => {
    const a = approved(true);
    expect(claimFollowupGuarded(a.db, a.id, { now: a.now, maxAgeMin: 30, sendLimit: 5 })).toEqual({ claimed: true });
    const b = approved(true);
    expect(claimFollowupForSend(b.db, b.id)).toBe(true);
  });
});
