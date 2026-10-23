// tests/dash-queries-mail-outcomes.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';
import { listSentEmails, emailDetail, listFollowups, listReplies } from '../src/dash/queries/mail.js';
import { listOutcomes, funnelView } from '../src/dash/queries/outcomes.js';
import { readRunLog } from '../src/dash/runlog.js';
import { funnelStats } from '../src/funnel.js';

let db: BetterSqlite3.Database;
beforeEach(() => { db = openDb(':memory:'); migrateOutreachTables(db); });
function mail(job: string, sentAt: string | null, o: Record<string, unknown> = {}) {
  db.prepare('INSERT OR IGNORE INTO jobs (id, source, title, company) VALUES (?,?,?,?)').run(job, 'remotive', `T ${job}`, `Co ${job}`);
  return Number(db.prepare(`INSERT INTO outreach_queue (job_id, email_to, email_subject, email_body, email_status, email_sent_at, email_thread_id)
    VALUES (?,?,?,?,?,?,?)`).run(job, o.to ?? `hr@${job}.com`, o.subject ?? `Hello ${job}`, o.body ?? 'body', 'sent', sentAt, 't-' + job).lastInsertRowid);
}
function pm(id: string, job: string | null, cls: string, from = 'a@b.com') {
  db.prepare('INSERT INTO processed_messages (message_id, job_id, classification, action, from_addr, subject) VALUES (?,?,?,?,?,?)')
    .run(id, job, cls, 'proposed', from, 'Re: x');
}

describe('mail queries', () => {
  it('lists only sent mail, newest first, with paging', () => {
    mail('a', '2026-10-01'); mail('b', '2026-10-02'); mail('c', null); mail('d', '2026-10-03');
    const p1 = listSentEmails(db, { limit: 2 });
    expect(p1.items.map((e) => e.job_id)).toEqual(['d', 'b']);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = listSentEmails(db, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((e) => e.job_id)).toEqual(['a']);
    expect(p2.nextCursor).toBeNull();
    expect(p1.items[0]).toMatchObject({ title: 'T d', company: 'Co d', to: 'hr@d.com', thread_id: 't-d' });
    expect(listSentEmails(db, { q: 'Co a' }).items.map((e) => e.job_id)).toEqual(['a']);
  });
  it('has_reply only for a non-noise processed message', () => {
    mail('a', 'x'); mail('b', 'x'); mail('c', 'x'); mail('d', 'x');
    pm('m1', 'a', 'replied'); pm('m2', 'b', 'noise'); pm('m3', 'c', 'auto_ack'); pm('m4', 'd', 'bounce');
    const m = Object.fromEntries(listSentEmails(db, {}).items.map((e) => [e.job_id, e.has_reply]));
    expect(m).toEqual({ a: true, b: false, c: false, d: false });
  });
  it('detail shows body, follow-ups and replies matched by job_id; caps body', () => {
    const id = mail('a', '2026-10-01', { body: 'x'.repeat(30000) });
    db.prepare("INSERT INTO followups (job_id, n, subject, body, status) VALUES ('a',1,'fu','fb','sent')").run();
    db.prepare("INSERT INTO followups (job_id, n, subject, body, status) VALUES ('zz',1,'fu','fb','sent')").run();
    pm('m1', 'a', 'replied', 'x@y.com'); pm('m2', 'other', 'replied');
    const d = emailDetail(db, id)!;
    expect(d.body!.length).toBeLessThanOrEqual(20000);
    expect(d.followups.map((f) => f.job_id)).toEqual(['a']);
    expect(d.replies.map((r) => r.message_id)).toEqual(['m1']);
    expect(d.has_reply).toBe(true);
    expect(emailDetail(db, 99999)).toBeNull();
  });
  it('cleans untrusted reply fields', () => {
    pm('m1', 'a', 'replied', 'e‮vil@x.com');
    db.prepare("UPDATE processed_messages SET subject = ? WHERE message_id = 'm1'").run('s\u0000ubj​');
    const r = listReplies(db, {}).items[0];
    expect(r.from_addr).not.toMatch(/‮/);
    expect(r.subject).not.toMatch(/[\u0000​]/);
  });
  it('follow-up status filter and reply paging by rowid', () => {
    for (let i = 0; i < 3; i++) db.prepare('INSERT INTO followups (job_id, n, status) VALUES (?,1,?)').run('j' + i, i === 0 ? 'drafted' : 'sent');
    expect(listFollowups(db, { status: 'sent' }).items).toHaveLength(2);
    pm('m1', 'a', 'replied'); pm('m2', 'a', 'replied'); pm('m3', 'a', 'replied');
    const p1 = listReplies(db, { limit: 2 });
    expect(p1.items.map((r) => r.message_id)).toEqual(['m3', 'm2']);
    expect(listReplies(db, { limit: 2, cursor: p1.nextCursor }).items.map((r) => r.message_id)).toEqual(['m1']);
  });
  it('caps limit on every list', () => {
    for (let i = 0; i < 130; i++) {
      mail('j' + i, '2026-10-01');
      db.prepare("INSERT INTO followups (job_id, n, status) VALUES (?,1,'sent')").run('j' + i);
      pm('m' + i, 'j' + i, 'replied');
      db.prepare("INSERT INTO job_outcomes (job_id, outcome) VALUES (?, 'replied')").run('j' + i);
    }
    expect(listSentEmails(db, { limit: 100000 }).items).toHaveLength(100);
    expect(listFollowups(db, { limit: 100000 }).items).toHaveLength(100);
    expect(listReplies(db, { limit: 100000 }).items).toHaveLength(100);
    expect(listOutcomes(db, { limit: 100000 }).items).toHaveLength(100);
  });
});

describe('outcomes, funnel, run log', () => {
  it('filters outcomes and joins job', () => {
    db.prepare("INSERT INTO jobs (id, source, title, company) VALUES ('a','x','Dev','Acme')").run();
    db.prepare("INSERT INTO job_outcomes (job_id, outcome, note) VALUES ('a','replied','n1')").run();
    db.prepare("INSERT INTO job_outcomes (job_id, outcome) VALUES ('a','rejected')").run();
    expect(listOutcomes(db, {}).items.map((o) => o.outcome)).toEqual(['rejected', 'replied']);
    const f = listOutcomes(db, { outcome: 'replied' }).items;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ title: 'Dev', company: 'Acme', note: 'n1' });
  });
  it('funnelView equals funnelStats', () => {
    mail('a', 'x');
    expect(funnelView(db, 60)).toEqual(funnelStats(db, 60));
    expect(funnelView(db, 60).benchmarks).toBeDefined();
  });
  it('run log stub then real rows', () => {
    expect(readRunLog(db)).toEqual({ available: false, note: 'run log table not present (plan 6D)' });
    db.exec('CREATE TABLE run_log (id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT, kind TEXT, status TEXT, summary TEXT)');
    db.prepare("INSERT INTO run_log (started_at, kind, status, summary) VALUES ('t','hunt','ok','done')").run();
    const r = readRunLog(db, 5);
    expect(r.available).toBe(true);
    if (r.available) expect(r.items[0]).toMatchObject({ kind: 'hunt', summary: 'done' });
  });
});
