import { beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';
import {
  contactDetail, followupDetail, jobLinks, mailLinks, mailStageLabel, MAX_LINKS, parseMailRef, parsePersonRef, personLinks,
} from '../src/dash/queries/links.js';
import { buildPanelUrl, crumbLabel, parsePanelParams, popPanel, pushPanel, type PanelRef } from '../apps/dashboard/src/lib/view-models.js';

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
    expect(jobLinks(db, 'lonely')).toEqual({ people: [], mails: [], other: [] });
    expect(jobLinks(db, 'nope')).toEqual({ people: [], mails: [], other: [] });
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
    expect(jobLinks(bare, 'x')).toEqual({ people: [], mails: [], other: [] });
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

describe('panel navigation helpers', () => {
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
