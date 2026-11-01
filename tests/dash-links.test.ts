import { beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';
import { migrateSchedulerTables } from '../src/scheduler/runLog.js';
import {
  contactDetail, followupDetail, jobLinks, mailLinks, mailStageLabel, MAX_LINKS, parseMailRef, parsePersonRef, personLinks, personTimeline,
  replyDetail, threadParent, tsOf, type MailLink,
} from '../src/dash/queries/links.js';
import { buildPanelUrl, crumbLabel, panelHref, parsePanelParams, popPanel, pushPanel, type PanelRef } from '../apps/dashboard/src/lib/view-models.js';

let db: BetterSqlite3.Database;
beforeEach(() => { db = openDb(':memory:'); migrateOutreachTables(db); });

function seed() {
  db.prepare("INSERT INTO jobs (id, source, title, company, score, poster_url) VALUES ('j1','linkedin-posts','Dev','Acme',80,'https://www.linkedin.com/in/jane-doe/')").run();
  db.prepare("INSERT INTO jobs (id, source, title, company, score) VALUES ('j2','remotive','Other','Globex',70)").run();
  db.prepare("INSERT INTO people (id, platform, profile_key, name, headline, company, company_key, category) VALUES (1,'linkedin','linkedin.com/in/jane-doe','Jane Doe','Recruiter at Acme','Acme','acme','recruiter')").run();
  db.prepare("INSERT INTO people (id, platform, profile_key, name, company, company_key, category) VALUES (2,'linkedin','linkedin.com/in/jane','Jane Short','Acme','acme','peer')").run();
  db.prepare("INSERT INTO contact_state (person_id, stage) VALUES (1,'active')").run();
  db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key, status, sent_at) VALUES (2,'j1','connect','k1','sent','2026-10-01 10:00:00')").run();
  db.prepare("INSERT INTO connections (job_id, company, profile_url, headline, status, sent_at) VALUES ('j1','Acme','https://linkedin.com/in/jane-doe?x=1','Recruiter','connected','2026-10-02 10:00:00')").run();
  db.prepare("INSERT INTO connections (job_id, company, profile_url, headline, status) VALUES ('j1','Acme','https://linkedin.com/in/nobody-saved','Eng','pending')").run();
  db.prepare("INSERT INTO contacts (id, company, email, type, verified) VALUES (7,' acme ','HR@acme.io','hr',1)").run();
  db.prepare("INSERT INTO contacts (id, company, email, type, verified) VALUES (8,'Acme','team@acme.io','generic',0)").run();
  db.prepare("INSERT INTO outreach_queue (id, job_id, email_to, email_subject, email_body, email_status, email_sent_at, status) VALUES (5,'j1','hr@acme.io','Hello','SECRET body','sent','2026-10-03 09:00:00','done')").run();
  db.prepare("INSERT INTO outreach_queue (id, job_id, email_to, email_subject, email_status, status) VALUES (6,'j2','x@globex.io','Hi','queued','queued')").run();
  db.prepare("INSERT INTO followups (id, job_id, n, subject, body, status, sent_at) VALUES (1,'j1',1,'fu1','b1','sent','2026-10-06 09:00:00')").run();
  db.prepare("INSERT INTO followups (id, job_id, n, subject, body, status) VALUES (2,'j1',4,'fb','b4','drafted')").run();
}

describe('ref parsers', () => {
  it('parses person, contact and mail refs and rejects junk', () => {
    expect(parsePersonRef('12')).toEqual({ kind: 'person', id: 12 });
    expect(parsePersonRef('c4')).toEqual({ kind: 'contact', id: 4 });
    expect(parsePersonRef('0')).toBeNull();
    expect(parsePersonRef('c')).toBeNull();
    expect(parsePersonRef('1;drop')).toBeNull();
    expect(parseMailRef('f5')).toEqual({ kind: 'followup', id: 5 });
    expect(parseMailRef('5')).toEqual({ kind: 'cold', id: 5 });
    expect(parseMailRef('x5')).toBeNull();
  });
  it('labels the sequence stages', () => {
    expect(mailStageLabel('cold', null)).toBe('Cold email');
    expect(mailStageLabel('followup', 2)).toBe('Follow-up 2');
    expect(mailStageLabel('feedback', 4)).toBe('Feedback request');
  });
});

describe('jobLinks', () => {
  it('lists people (exact profile key), email contacts, mails and other outreach', () => {
    seed();
    const l = jobLinks(db, 'j1');
    const jane = l.people.find((p) => p.ref === '1')!;
    expect(jane).toMatchObject({ name: 'Jane Doe', channel: 'linkedin', status: 'connected' });
    expect(jane.note).toBe('Hiring post author');
    // the shorter slug must not match by substring
    expect(l.people.find((p) => p.ref === '2')).toMatchObject({ name: 'Jane Short', status: 'sent' });
    // a connection with no people row is listed without a ref
    expect(l.people.find((p) => p.ref === null && p.channel === 'linkedin')).toMatchObject({ status: 'pending', role: 'Eng' });
    // email contacts: the address mailed (case-insensitive) and the same-company contact
    expect(l.people.find((p) => p.ref === 'c7')).toMatchObject({ email: 'HR@acme.io', channel: 'email', status: 'sent', verified: true });
    expect(l.people.find((p) => p.ref === 'c8')).toMatchObject({ email: 'team@acme.io', verified: false });
    expect(l.mails.map((m) => [m.kind, m.ref, m.status])).toEqual([['cold', '5', 'sent'], ['followup', 'f1', 'sent'], ['feedback', 'f2', 'drafted']]);
    expect(l.other.map((o) => o.kind)).toContain('connect');
    expect(JSON.stringify(l)).not.toContain('SECRET');
  });
  it('is empty and safe for a job with nothing linked or an unknown job', () => {
    db.prepare("INSERT INTO jobs (id, source, title, company) VALUES ('lonely','remotive','T','')").run();
    expect(jobLinks(db, 'lonely')).toEqual({ people: [], mails: [], other: [], escalations: [] });
    expect(jobLinks(db, 'nope')).toEqual({ people: [], mails: [], other: [], escalations: [] });
  });
  it('an unsent cold email is listed but has no ref to open', () => {
    seed();
    const l = jobLinks(db, 'j2');
    expect(l.mails).toEqual([expect.objectContaining({ kind: 'cold', ref: null, status: 'queued' })]);
  });
  it('bounds every section', () => {
    db.prepare("INSERT INTO jobs (id, source, title, company) VALUES ('big','x','T','Big')").run();
    for (let i = 0; i < 80; i++) db.prepare("INSERT INTO followups (job_id, n, status) VALUES ('big',1,'sent')").run();
    expect(jobLinks(db, 'big').mails.length).toBeLessThanOrEqual(MAX_LINKS);
  });
  it('survives missing optional tables', () => {
    const bare = openDb(':memory:');
    bare.exec('DROP TABLE connections; DROP TABLE contacts;');
    expect(jobLinks(bare, 'x')).toEqual({ people: [], mails: [], other: [], escalations: [] });
  });
});

describe('mailLinks', () => {
  it('links a cold email to its job and contact and marks the current stage', () => {
    seed();
    const l = mailLinks(db, { kind: 'cold', id: 5 })!;
    expect(l.job).toMatchObject({ id: 'j1', title: 'Dev', company: 'Acme' });
    expect(l.contact).toMatchObject({ ref: 'c7', role: 'hr', email: 'HR@acme.io' });
    expect(l.timeline.map((m) => [m.ref, m.current])).toEqual([['5', true], ['f1', false], ['f2', false]]);
  });
  it('a follow-up is the current item of its own timeline', () => {
    seed();
    const l = mailLinks(db, { kind: 'followup', id: 2 })!;
    expect(l.timeline.find((m) => m.current)).toMatchObject({ ref: 'f2', kind: 'feedback', label: 'Feedback request' });
  });
  it('handles an orphan mail (job row gone) and an unknown contact', () => {
    db.prepare("INSERT INTO outreach_queue (id, job_id, email_to, email_subject, email_sent_at) VALUES (9,'gone','who@nowhere.io','S','2026-10-01')").run();
    const l = mailLinks(db, { kind: 'cold', id: 9 })!;
    expect(l.job).toBeNull();
    expect(l.job_id).toBe('gone');
    expect(l.contact).toMatchObject({ ref: null, email: 'who@nowhere.io' });
  });
  it('returns null for an unsent or unknown mail', () => {
    seed();
    expect(mailLinks(db, { kind: 'cold', id: 6 })).toBeNull();
    expect(mailLinks(db, { kind: 'followup', id: 99 })).toBeNull();
  });
});

describe('personLinks and details', () => {
  it('a person gets its jobs through exact profile-key paths and the mails of those jobs', () => {
    seed();
    const l = personLinks(db, { kind: 'person', id: 1 })!;
    expect(l.jobs.map((j) => j.id)).toEqual(['j1']);
    expect(l.jobs[0].via.sort()).toEqual(['Connection', 'Hiring post author']);
    expect(l.mails.map((m) => m.ref)).toEqual(['5', 'f1', 'f2']);
    const short = personLinks(db, { kind: 'person', id: 2 })!;
    expect(short.jobs[0].via).toEqual(['Message']);
  });
  it('a contact gets jobs by mailed address and by company', () => {
    seed();
    const l = personLinks(db, { kind: 'contact', id: 7 })!;
    expect(l.jobs.map((j) => j.id)).toEqual(['j1']);
    expect(l.jobs[0].via.sort()).toEqual(['Email sent to this address', 'Same company']);
    expect(contactDetail(db, 7)).toMatchObject({ email: 'HR@acme.io', type: 'hr', verified: true });
  });
  it('unknown people and contacts give null; a person with no links gives empty lists', () => {
    seed();
    expect(personLinks(db, { kind: 'person', id: 99 })).toBeNull();
    expect(personLinks(db, { kind: 'contact', id: 99 })).toBeNull();
    expect(contactDetail(db, 99)).toBeNull();
    db.prepare("INSERT INTO people (id, platform, profile_key, name, company_key, category) VALUES (3,'linkedin','linkedin.com/in/new',NULL,'x','peer')").run();
    expect(personLinks(db, { kind: 'person', id: 3 })).toEqual({ jobs: [], mails: [] });
  });
  it('follow-up detail carries the recipient and job and redacts nothing extra', () => {
    seed();
    expect(followupDetail(db, 2)).toMatchObject({ kind: 'feedback', label: 'Feedback request', to: 'hr@acme.io', title: 'Dev', company: 'Acme', body: 'b4' });
    expect(followupDetail(db, 99)).toBeNull();
  });
});

/** Inbound mail, inbox items and inbound-message records on top of the base seed. */
function seedConversation() {
  seed();
  migrateSchedulerTables(db);
  db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, action, from_addr, subject, reply_date) VALUES ('m1','j1','reply','proposed','HR@acme.io','Re: Hello','2026-10-04T09:00:00Z')").run();
  db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, from_addr, subject, reply_date) VALUES ('m2','j1','bounce','mailer@x.io','Undeliverable','2026-10-07T09:00:00Z')").run();
  db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, from_addr, subject) VALUES ('bad id<script>','j1','noise','x@y.io','weird')").run();
  db.prepare("INSERT INTO escalations (id, person_id, platform, reason, created_at, message_excerpt) VALUES (11, 1, 'linkedin', 'recruiter_reply', '2026-10-05 08:00:00', 'Can we talk <b>today</b>?')").run();
  db.prepare("INSERT INTO escalations (id, person_id, platform, reason, created_at, resolved_at) VALUES (12, 2, 'linkedin', 'other', '2026-10-05 09:00:00', '2026-10-06 09:00:00')").run();
  db.prepare("INSERT INTO inbound_messages (platform, thread_ref, person_id, text_hash, klass, escalated, created_at) VALUES ('linkedin','t1',1,'h1','question',1,'2026-10-05 07:00:00')").run();
  db.prepare("INSERT INTO touches (person_id, job_id, kind, body, idempotency_key, status, sent_at) VALUES (1,'j1','connect_note','Hi Jane, short note','k2','sent','2026-10-02 09:00:00')").run();
}

describe('time helper', () => {
  it('reads SQLite UTC, ISO and RFC 2822 times, and gives 0 for junk', () => {
    expect(tsOf('2026-10-01 10:00:00')).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(tsOf('2026-10-01T10:00:00Z')).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(tsOf('Thu, 01 Oct 2026 10:00:00 +0000')).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(tsOf(null)).toBe(0);
    expect(tsOf('not a date')).toBe(0);
  });
});

describe('mail thread with replies and parents', () => {
  it('lists the cold email, follow-ups and replies in time order and each reply is openable', () => {
    seedConversation();
    const l = mailLinks(db, { kind: 'cold', id: 5 })!;
    // sent 10-03, reply 10-04, follow-up 10-06, bounce 10-07; the draft and the undated mail carry "now" and come last
    expect(l.timeline.slice(0, 4).map((m) => [m.kind, m.ref])).toEqual([['cold', '5'], ['reply', 'm1'], ['followup', 'f1'], ['reply', 'm2']]);
    expect(l.timeline).toHaveLength(6);
    expect(l.timeline.find((m) => m.ref === 'm1')).toMatchObject({ kind: 'reply', from: 'HR@acme.io', to: null, label: 'Reply', current: false });
    expect(l.timeline.find((m) => m.ref === 'm2')).toMatchObject({ label: 'Bounce' });
    // a message id that is not URL safe is listed but has no ref to open
    expect(l.timeline.find((m) => m.subject === 'weird')).toMatchObject({ ref: null, kind: 'reply' });
    expect(l.parent).toBeNull(); // a cold email replies to nothing
  });
  it('a follow-up points to the previous message and a reply to the newest earlier mail', () => {
    seedConversation();
    expect(mailLinks(db, { kind: 'followup', id: 1 })!.parent).toMatchObject({ ref: '5', kind: 'cold' });
    expect(mailLinks(db, { kind: 'followup', id: 2 })!.parent).toMatchObject({ ref: 'f1', n: 1 });
    const r = replyDetail(db, 'm1')!;
    expect(r.parent).toMatchObject({ ref: '5' });
    expect(replyDetail(db, 'm2')!.parent).toMatchObject({ ref: 'f1' });
    expect(r.job).toMatchObject({ id: 'j1' });
    expect(r.timeline.find((m) => m.current)).toMatchObject({ ref: 'm1' });
    expect(replyDetail(db, 'nope')).toBeNull();
    expect(replyDetail(db, 'bad id<script>')).toBeNull();
  });
  it('a reply id that equals a mail number is never marked as the current mail', () => {
    seed();
    db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, reply_date) VALUES ('5','j1','reply','2026-10-04T09:00:00Z')").run();
    const cur = mailLinks(db, { kind: 'cold', id: 5 })!.timeline.filter((m) => m.current);
    expect(cur.map((m) => m.kind)).toEqual(['cold']);
  });
  it('threadParent is pure and handles a thread with no cold email', () => {
    const mk = (over: Partial<MailLink>): MailLink => ({ ref: 'x', kind: 'cold', n: null, job_id: 'j', label: '', status: null, to: null, from: null, subject: null, sent_at: null, created_at: null, ...over });
    const fu = mk({ ref: 'f1', kind: 'followup', n: 1, sent_at: '2026-10-02T00:00:00Z' });
    expect(threadParent([fu], fu)).toBeNull();
    expect(threadParent([], mk({ kind: 'reply', ref: 'r', sent_at: '2026-10-03T00:00:00Z' }))).toBeNull();
  });
});

describe('job panel: replies and inbox items', () => {
  it('puts replies in the job thread and lists inbox items of the people of the job', () => {
    seedConversation();
    const l = jobLinks(db, 'j1');
    expect(l.mails.some((m) => m.kind === 'reply')).toBe(true);
    expect(l.escalations.map((e) => [e.id, e.resolved]).sort()).toEqual([[11, false], [12, true]]);
    expect(jobLinks(db, 'j2').escalations).toEqual([]);
  });
});

describe('personTimeline', () => {
  it('collects touches, inbound records, inbox items, emails and replies, oldest first, each with the right panel', () => {
    seedConversation();
    const t = personTimeline(db, { kind: 'person', id: 1 })!;
    const times = t.map((i) => tsOf(i.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const types = new Set(t.map((i) => i.type));
    for (const want of ['touch', 'inbound', 'escalation', 'email', 'followup', 'reply']) expect(types.has(want as never)).toBe(true);
    expect(t.find((i) => i.type === 'touch')).toMatchObject({ title: 'Connect note (linkedin)', direction: 'out', preview: 'Hi Jane, short note', open: { kind: 'job', id: 'j1' } });
    expect(t.find((i) => i.type === 'escalation')).toMatchObject({ inbox_id: 11, direction: 'in', status: 'open', preview: 'Can we talk <b>today</b>?' });
    expect(t.find((i) => i.type === 'inbound')).toMatchObject({ direction: 'in', status: 'question' });
    expect(t.find((i) => i.type === 'email')).toMatchObject({ open: { kind: 'mail', id: '5' } });
    expect(t.find((i) => i.type === 'followup')).toMatchObject({ open: { kind: 'mail', id: 'f1' } });
    expect(t.find((i) => i.type === 'reply' && i.open?.id === 'm1')).toMatchObject({ direction: 'in', open: { kind: 'reply', id: 'm1' } });
    expect(JSON.stringify(t)).not.toContain('SECRET'); // email bodies never appear
  });
  it('does not show the same connect request twice (touch and connections row for one job)', () => {
    seedConversation();
    const t = personTimeline(db, { kind: 'person', id: 1 })!;
    expect(t.filter((i) => i.type === 'connection')).toEqual([]);
    const only = personTimeline(db, { kind: 'person', id: 2 })!;
    expect(only.some((i) => i.type === 'touch')).toBe(true);
  });
  it('a contact gets only the threads of jobs mailed to its address', () => {
    seedConversation();
    const t = personTimeline(db, { kind: 'contact', id: 7 })!;
    expect(t.every((i) => i.job?.id === 'j1')).toBe(true);
    expect(t.some((i) => i.type === 'email')).toBe(true);
    expect(personTimeline(db, { kind: 'contact', id: 8 })!.some((i) => i.type === 'email')).toBe(false);
  });
  it('is null for an unknown record, empty for a person with nothing, and bounded', () => {
    seed();
    expect(personTimeline(db, { kind: 'person', id: 99 })).toBeNull();
    expect(personTimeline(db, { kind: 'person', id: 1 })).toEqual(expect.any(Array));
    for (let i = 0; i < 80; i++) db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key, status) VALUES (2,'j1','message',?, 'sent')").run(`bulk${i}`);
    expect(personTimeline(db, { kind: 'person', id: 2 })!.length).toBeLessThanOrEqual(MAX_LINKS);
  });
  it('survives a database without the optional tables', () => {
    const bare = openDb(':memory:');
    migrateOutreachTables(bare);
    bare.prepare("INSERT INTO people (id, platform, profile_key, company_key, category) VALUES (1,'linkedin','linkedin.com/in/a','x','peer')").run();
    expect(personTimeline(bare, { kind: 'person', id: 1 })).toEqual([]);
  });
});

describe('panel navigation helpers', () => {
  it('knows the reply panel and builds a real link for every kind', () => {
    expect(parsePanelParams(new URLSearchParams('reply=18f3a.b-c'))).toEqual({ kind: 'reply', id: '18f3a.b-c' });
    expect(parsePanelParams(new URLSearchParams('reply=a%20b'))).toBeNull();
    expect(crumbLabel({ kind: 'reply', id: 'm1' })).toBe('Reply');
    expect(panelHref({ kind: 'job', id: 'a:1' })).toBe('/jobs?job=a%3A1');
    expect(panelHref({ kind: 'mail', id: 'f3' })).toBe('/mail?mail=f3');
    expect(panelHref({ kind: 'person', id: 'c4' })).toBe('/people?person=c4');
    expect(panelHref({ kind: 'reply', id: 'm1' })).toBe('/mail?reply=m1');
  });
  it('reads one panel from the query string, validating shape', () => {
    expect(parsePanelParams(new URLSearchParams('job=abc:1'))).toEqual({ kind: 'job', id: 'abc:1' });
    expect(parsePanelParams(new URLSearchParams('mail=f5'))).toEqual({ kind: 'mail', id: 'f5' });
    expect(parsePanelParams(new URLSearchParams('person=c4'))).toEqual({ kind: 'person', id: 'c4' });
    expect(parsePanelParams(new URLSearchParams('mail=x5'))).toBeNull();
    expect(parsePanelParams(new URLSearchParams('job=a b'))).toBeNull();
    expect(parsePanelParams(new URLSearchParams(''))).toBeNull();
  });
  it('builds a URL that keeps other params and drops stale panel params', () => {
    expect(buildPanelUrl('/jobs', new URLSearchParams('q=x&mail=1'), { kind: 'job', id: 'a' })).toBe('/jobs?q=x&job=a');
    expect(buildPanelUrl('/jobs', new URLSearchParams('job=a'), null)).toBe('/jobs');
  });
  it('keeps a back stack', () => {
    const job: PanelRef = { kind: 'job', id: 'j1' }; const mail: PanelRef = { kind: 'mail', id: '12' };
    let stack = pushPanel([], job);
    stack = pushPanel(stack, mail);
    expect(stack).toEqual([job, mail]);
    expect(pushPanel(stack, mail)).toEqual(stack);
    expect(popPanel(stack)).toEqual([job]);
    expect(popPanel([job])).toEqual([job]);
    expect(crumbLabel(mail)).toBe('Mail #12');
    expect(crumbLabel({ kind: 'mail', id: 'f3' })).toBe('Follow-up #3');
    expect(crumbLabel({ kind: 'person', id: 'c4' })).toBe('Contact #4');
    expect(crumbLabel(job)).toBe('Job');
  });
});
