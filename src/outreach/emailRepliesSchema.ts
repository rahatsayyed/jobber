// src/outreach/emailRepliesSchema.ts
// Tables of the email auto reply path (owner decision 2026-11-06). Kept import-free so src/db.ts can call it without a cycle.
import type BetterSqlite3 from 'better-sqlite3';

export const EMAIL_REPLY_STATUSES = ['drafted', 'approved', 'sending', 'sent', 'failed', 'cancelled'] as const;
export type EmailReplyStatus = (typeof EMAIL_REPLY_STATUSES)[number];

export function migrateEmailReplies(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- the inbound Gmail message this answers; UNIQUE so one inbound message gets at most ONE reply, ever
      message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      job_id TEXT,
      to_addr TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted','approved','sending','sent','failed','cancelled')),
      reply_message_id TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_at TEXT,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_replies_status ON email_replies(status);
    CREATE INDEX IF NOT EXISTS idx_email_replies_thread ON email_replies(thread_id);
  `);
  // followups.nudge = 1 marks the one nudge after our own automatic reply (EMAIL_REPLY_NUDGE); see nudgeEligible in src/followups.ts.
  const fcols = new Set((db.prepare('PRAGMA table_info(followups)').all() as { name: string }[]).map((c) => c.name));
  if (fcols.size > 0 && !fcols.has('nudge')) db.exec('ALTER TABLE followups ADD COLUMN nudge INTEGER NOT NULL DEFAULT 0');
  const cols = new Set((db.prepare('PRAGMA table_info(processed_messages)').all() as { name: string }[]).map((c) => c.name));
  if (cols.size > 0) {
    // auto_class: JSON {verdict, kinds, record, owner, eligible} from src/outreach/emailReplyClass.ts; auto_note: the code-built sentence the
    // owner notice shows ("answered automatically: expected CTC" / "needs you: asks for a time").
    if (!cols.has('auto_class')) db.exec('ALTER TABLE processed_messages ADD COLUMN auto_class TEXT');
    if (!cols.has('auto_note')) db.exec('ALTER TABLE processed_messages ADD COLUMN auto_note TEXT');
  }
}
