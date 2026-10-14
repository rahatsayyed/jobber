import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enqueueOutreach, listSentEmails, openDb, recordEmailSent, saveJob, setEmailThread } from '../src/db.js';

const row = (job_id: string, profile: string | null) => ({
  job_id, resume_pdf_path: null, email_subject: 'Frontend role', email_body: 'Hi', email_to: 'hr@acme.dev',
  connect_note: profile ? 'note' : null, connect_profile_url: profile, connect_category: profile ? 'peer' : null,
  connect_company: 'Acme', apply_platform: null, apply_url: null,
});

describe('sent email bookkeeping', () => {
  it('records the Gmail id on every queue row of the same job email, and lists one row per job', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 's', title: 'Frontend Dev', company: 'Acme', url: 'u', apply_url: 'u', description: 'd' });
    const a = enqueueOutreach(db, row('j1', 'https://linkedin.com/in/a'));
    enqueueOutreach(db, row('j1', 'https://linkedin.com/in/b'));
    expect(recordEmailSent(db, a, 'msg-1')).toBe(2);
    expect(setEmailThread(db, 'msg-1', 'thr-1')).toBe(2);
    const sent = listSentEmails(db);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ job_id: 'j1', company: 'Acme', title: 'Frontend Dev', email_to: 'hr@acme.dev', message_id: 'msg-1', thread_id: 'thr-1' });
    expect(sent[0].sent_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
  it('an excluded job (plan 2 excluded_reason) that was emailed is still listed: sent-email handling ignores exclusions', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'jx', source: 's', title: 'Frontend Dev', company: 'Acme', url: 'u', apply_url: 'u', description: 'd' });
    recordEmailSent(db, enqueueOutreach(db, row('jx', null)), 'msg-x');
    db.prepare("UPDATE jobs SET excluded_reason = 'deadline passed: 2026-10-01' WHERE id = 'jx'").run();
    expect(listSentEmails(db).map((s) => s.job_id)).toEqual(['jx']);
  });
  it('a missing message id still marks the email sent', () => {
    const db = openDb(':memory:');
    const a = enqueueOutreach(db, row('j2', null));
    expect(recordEmailSent(db, a, null)).toBe(1);
    expect((db.prepare('SELECT email_status, email_message_id FROM outreach_queue WHERE id = ?').get(a) as any)).toEqual({ email_status: 'sent', email_message_id: null });
  });
});

describe('recordEmailSent is idempotent on the send time', () => {
  it('re-recording an already-sent row keeps the original email_sent_at (a follow-up clock must never be pushed later)', () => {
    const db = openDb(':memory:');
    const a = enqueueOutreach(db, row('j9', null));
    recordEmailSent(db, a, 'm9');
    db.prepare("UPDATE outreach_queue SET email_sent_at = '2026-09-02 08:30:00' WHERE id = ?").run(a);
    recordEmailSent(db, a, 'm9');
    expect((db.prepare('SELECT email_sent_at FROM outreach_queue WHERE id = ?').get(a) as any).email_sent_at).toBe('2026-09-02 08:30:00');
  });
});

describe('email_sent_at migration and backfill', () => {
  it('the backfill never overwrites an existing email_sent_at', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ja-nooverwrite-'));
    const file = path.join(dir, 'old.sqlite');
    const old = new BetterSqlite3(file);
    old.exec(`CREATE TABLE outreach_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, email_to TEXT, email_status TEXT, email_sent_at TEXT,
      status TEXT DEFAULT 'queued', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      INSERT INTO outreach_queue (job_id, email_to, email_status, email_sent_at, updated_at) VALUES ('j1', 'hr@acme.dev', 'sent', '2026-09-01 07:00:00', '2026-09-05 09:00:00');`);
    old.close();
    try {
      const db = openDb(file);
      expect(db.prepare("SELECT email_sent_at FROM outreach_queue WHERE job_id = 'j1'").get()).toEqual({ email_sent_at: '2026-09-01 07:00:00' });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a legacy outreach_queue with neither email_status nor updated_at still opens (the backfill is guarded; same shape as tests/queueQuality.test.ts)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ja-legacy-'));
    const file = path.join(dir, 'legacy.sqlite');
    const old = new BetterSqlite3(file);
    old.exec('CREATE TABLE outreach_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, status TEXT)');
    old.close();
    try {
      const db = openDb(file);
      const cols = (db.prepare('PRAGMA table_info(outreach_queue)').all() as { name: string }[]).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['email_sent_at', 'email_message_id', 'email_thread_id']));
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('an old-shape database gets the new columns, and its already-sent rows are backfilled from updated_at (idempotent)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ja-migration-'));
    const file = path.join(dir, 'old.sqlite');
    const old = new BetterSqlite3(file);
    old.exec(`CREATE TABLE outreach_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, email_subject TEXT, email_body TEXT, email_to TEXT, email_status TEXT,
      status TEXT DEFAULT 'queued', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      INSERT INTO outreach_queue (job_id, email_to, email_status, updated_at) VALUES ('j1', 'hr@acme.dev', 'sent', '2026-09-02 08:30:00');
      INSERT INTO outreach_queue (job_id, email_to, email_status, updated_at) VALUES ('j2', 'hr@globex.io', 'queued', '2026-09-02 08:31:00');`);
    old.close();
    try {
      const db = openDb(file);
      const read = () => db.prepare('SELECT job_id, email_status, email_sent_at FROM outreach_queue ORDER BY id').all();
      expect(read()).toEqual([{ job_id: 'j1', email_status: 'sent', email_sent_at: '2026-09-02 08:30:00' }, { job_id: 'j2', email_status: 'queued', email_sent_at: null }]);
      expect(listSentEmails(db, 3650).map((s) => s.job_id)).toEqual(['j1']);
      db.close();
      const again = openDb(file);
      expect(again.prepare("SELECT email_sent_at FROM outreach_queue WHERE job_id = 'j1'").get()).toEqual({ email_sent_at: '2026-09-02 08:30:00' });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
