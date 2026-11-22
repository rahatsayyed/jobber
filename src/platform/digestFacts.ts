// src/platform/digestFacts.ts
// The digest's facts that have no (reliable) queue sender because the writers run in other processes (MCP servers in worker windows):
// read straight from SQLite for [since, until). Read-only SELECTs, zero LLM, no raw text. A missing table or column counts as 0.
// SOURCE OF TRUTH: when facts are given, REAL mail, applies, JD reads and hiring posts come from here and the queued `mail_sent`,
// `email_reply_sent`, `apply_done`, `jd_read`, `hiring_posts` rows and the queued Easy Apply `linkedin_action` are ignored for those numbers
// (dry runs write no DB rows, so the queue still supplies the dry counts). New jobs stay with the queued `wake_summary` (one source).
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export interface DigestFacts {
  /** Real emails sent: cold (outreach_queue), follow-ups (followups), automatic replies (email_replies). */
  mail: { cold: number; followup: number; autoReply: number };
  /** Submitted applications by `platform method`, e.g. `linkedin easy_apply`. Owner-submitted rows (method manual) are not counted. */
  applies: Array<{ platform: string; method: string; count: number }>;
  /** Job descriptions read (jobs.jd_fetched_at in the span) by source. */
  jdBySource: Array<{ source: string; count: number }>;
  /** Jobs of source `linkedin-posts` created in the span. */
  hiringPosts: number;
}

export const EMPTY_FACTS: DigestFacts = { mail: { cold: 0, followup: 0, autoReply: 0 }, applies: [], jdBySource: [], hiringPosts: 0 };

/** Counts nothing and never throws when the table is missing. `datetime()` reads both `2026-11-20T06:00:00.000Z` and `2026-11-20 06:00:00`. */
function all<T>(db: Db, sql: string, a: string, b: string): T[] {
  try { return db.prepare(sql).all(a, b) as T[]; } catch { return []; }
}
function count(db: Db, sql: string, a: string, b: string): number {
  return all<{ n: number }>(db, sql, a, b)[0]?.n ?? 0;
}

export function readDigestFacts(db: Db, from: Date, to: Date): DigestFacts {
  const a = from.toISOString();
  const b = to.toISOString();
  const span = (col: string): string => `datetime(${col}) >= datetime(?) AND datetime(${col}) < datetime(?)`;
  const applies = all<{ platform: string | null; method: string | null; n: number }>(
    db,
    `SELECT platform, method, COUNT(*) AS n FROM applications WHERE status = 'submitted' AND COALESCE(method, '') != 'manual' AND ${span('created_at')} GROUP BY platform, method`,
    a, b,
  ).map((r) => ({ platform: r.platform || 'web', method: r.method || 'apply', count: r.n }));
  const jd = all<{ source: string | null; n: number }>(
    db,
    `SELECT source, COUNT(*) AS n FROM jobs WHERE jd_fetched_at IS NOT NULL AND ${span('jd_fetched_at')} GROUP BY source`,
    a, b,
  ).map((r) => ({ source: r.source || 'other', count: r.n }));
  return {
    mail: {
      cold: count(db, `SELECT COUNT(*) AS n FROM outreach_queue WHERE email_status = 'sent' AND email_sent_at IS NOT NULL AND ${span('email_sent_at')}`, a, b),
      followup: count(db, `SELECT COUNT(*) AS n FROM followups WHERE status = 'sent' AND sent_at IS NOT NULL AND ${span('sent_at')}`, a, b),
      autoReply: count(db, `SELECT COUNT(*) AS n FROM email_replies WHERE status = 'sent' AND sent_at IS NOT NULL AND ${span('sent_at')}`, a, b),
    },
    applies,
    jdBySource: jd,
    hiringPosts: count(db, `SELECT COUNT(*) AS n FROM jobs WHERE source = 'linkedin-posts' AND ${span('created_at')}`, a, b),
  };
}

export function factsEmpty(f: DigestFacts): boolean {
  return f.mail.cold + f.mail.followup + f.mail.autoReply === 0 && f.applies.length === 0 && f.jdBySource.length === 0 && f.hiringPosts === 0;
}
