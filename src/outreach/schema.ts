// src/outreach/schema.ts
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export function migrateOutreachTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      name TEXT,
      headline TEXT,
      company TEXT,
      company_key TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (platform, profile_key)
    );
    CREATE INDEX IF NOT EXISTS idx_people_company ON people (platform, company_key);

    CREATE TABLE IF NOT EXISTS contact_state (
      person_id INTEGER PRIMARY KEY REFERENCES people(id),
      stage TEXT NOT NULL DEFAULT 'new',
      variant TEXT,
      speculative INTEGER NOT NULL DEFAULT 0,
      followups_sent INTEGER NOT NULL DEFAULT 0,
      cycle_started_at TEXT,
      last_touch_at TEXT,
      next_due_at TEXT,
      cooldown_until TEXT,
      paused_reason TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS touches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id),
      job_id TEXT,
      kind TEXT NOT NULL,
      body TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_touches_person ON touches (person_id);

    CREATE TABLE IF NOT EXISTS rate_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_events_key_at ON rate_events (key, at);

    CREATE TABLE IF NOT EXISTS halt_flags (
      platform TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      set_at TEXT NOT NULL,
      cleared_at TEXT
    );
  `);
  // Owner-approved LinkedIn replies (LinkedIn drip lane). A draft is written by the inbox tick for an inbound escalation and is NEVER sent
  // before the owner approves it (npm run replies -- approve <id>). status: drafted | approved | sent | failed | skipped.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reply_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      escalation_id INTEGER NOT NULL,
      person_id INTEGER NOT NULL REFERENCES people(id),
      thread_ref TEXT,
      kind TEXT NOT NULL DEFAULT 'reply',
      body TEXT NOT NULL,
      attach_resume INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'drafted',
      created_at TEXT NOT NULL,
      approved_at TEXT,
      sent_at TEXT,
      touch_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reply_drafts_status ON reply_drafts (status);
    CREATE INDEX IF NOT EXISTS idx_reply_drafts_escalation ON reply_drafts (escalation_id);
  `);
  // Finding 20: whether the headline named the searched company at registration (1 yes, 0 no, NULL unknown).
  const peopleCols = new Set((db.prepare('PRAGMA table_info(people)').all() as { name: string }[]).map((c) => c.name));
  if (!peopleCols.has('employer_match')) db.exec('ALTER TABLE people ADD COLUMN employer_match INTEGER');
  // no_dialog releases (a Connect click that opened no invite dialog, so no Send ever happened): how many
  // times this row was released and when last, for the 2-per-7-days retry limit.
  const touchCols = new Set((db.prepare('PRAGMA table_info(touches)').all() as { name: string }[]).map((c) => c.name));
  if (!touchCols.has('no_dialog_count')) db.exec('ALTER TABLE touches ADD COLUMN no_dialog_count INTEGER NOT NULL DEFAULT 0');
  if (!touchCols.has('released_at')) db.exec('ALTER TABLE touches ADD COLUMN released_at TEXT');
}
