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
}
