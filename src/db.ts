import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { normalizeMatchRow, type MatchRowInput } from './score.js';
import { classifyDeadlines, type DeadlineSweep } from './freshness.js';
import type { Legitimacy } from './legitimacy.js';
import { dbPath } from './dbPath.js';
import { companyKey, repostCount, titleIdentityKey } from './reposts.js';
import { isDiscoverOnlySource, isHeldSource } from './lib/discoverOnly.js';
import { classifyApplyUrl } from './apply/registry.js';
import { channelsFor, type ChannelVerdict } from './lib/channels.js';
import { migrateOutreachTables } from './outreach/schema.js';
import { migrateSchedulerTables } from './scheduler/runLog.js';

/** enqueue_outreach.ats_coverage: an integer percentage, or null when the final render had no keywords (tailor contract). */
export const atsCoverageSchema = z.number().int().min(0).max(100).nullable().optional();

export function openDb(path: string = dbPath()): BetterSqlite3.Database {
  const db = new BetterSqlite3(path);
  db.pragma('busy_timeout = 5000');

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      source TEXT,
      title TEXT,
      company TEXT,
      url TEXT,
      apply_url TEXT,
      description TEXT,
      score INTEGER,
      status TEXT,
      excluded_reason TEXT,
      posted_at TEXT,
      deadline TEXT,
      deadline_reported TEXT,
      language_note TEXT,
      score_dims TEXT,
      requirements TEXT,
      strengths TEXT,
      gaps TEXT,
      hard_stops TEXT,
      confidence TEXT,
      title_key TEXT,
      company_key TEXT,
      legitimacy TEXT,
      legitimacy_signals TEXT,
      gate_flags TEXT,
      jd_snapshot TEXT,
      jd_snapshot_at TEXT,
      score_cap_reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT,
      email TEXT,
      type TEXT,
      verified INTEGER,
      source TEXT,
      confidence REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS outreach (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      contact_email TEXT,
      subject TEXT,
      body TEXT,
      resume_path TEXT,
      sent_at TEXT,
      status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_counters (
      day TEXT,
      key TEXT,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (day, key)
    );

    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      platform TEXT,
      method TEXT,
      account TEXT,
      status TEXT,
      reason TEXT,
      applied_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      company TEXT,
      profile_url TEXT,
      headline TEXT,
      note TEXT,
      status TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS outreach_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      resume_pdf_path TEXT,
      email_subject TEXT,
      email_body TEXT,
      email_to TEXT,
      email_status TEXT,
      connect_note TEXT,
      connect_profile_url TEXT,
      connect_category TEXT,
      connect_company TEXT,
      connect_status TEXT,
      apply_platform TEXT,
      apply_tier TEXT,
      apply_url TEXT,
      apply_status TEXT,
      ats_coverage INTEGER,
      ats_gaps TEXT,
      fact_warnings TEXT,
      review_applied INTEGER,
      review_rejected INTEGER,
      email_sent_at TEXT,
      email_message_id TEXT,
      email_thread_id TEXT,
      status TEXT DEFAULT 'queued',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_job_outcomes_job ON job_outcomes(job_id);

    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      job_id TEXT,
      classification TEXT,
      action TEXT,
      proposed_outcome TEXT,
      from_addr TEXT,
      subject TEXT,
      reply_date TEXT,
      processed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      subject TEXT,
      body TEXT,
      status TEXT NOT NULL,
      message_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      sent_at TEXT,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_followups_job ON followups(job_id);
    CREATE TABLE IF NOT EXISTS reply_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at TEXT NOT NULL,
      clean INTEGER NOT NULL,
      messages INTEGER NOT NULL,
      errors INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_exclusion_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      previous_reason TEXT,
      cleared_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS platform_status (
      id TEXT PRIMARY KEY,
      last_run_at TEXT,
      last_status TEXT,
      fetched INTEGER NOT NULL DEFAULT 0,
      kept INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      fallback_used INTEGER NOT NULL DEFAULT 0,
      streak_fail INTEGER NOT NULL DEFAULT 0,
      shape_hash TEXT,
      note TEXT
    );
    -- Work the script-first source runner could not do (shape change, error, drift): an agent operator picks these up (plan 8G task 2).
    CREATE TABLE IF NOT EXISTS source_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      company TEXT,
      reason TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- Declarative generated providers (plan 8G task 8): state candidate, validated, trusted; approved is the owner's release of held outreach.
    CREATE TABLE IF NOT EXISTS generated_providers (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      clean_runs INTEGER NOT NULL DEFAULT 0,
      run_ids TEXT NOT NULL DEFAULT '[]',
      task_id INTEGER,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- Search quota and cache (plan 8G task 3). search_cache also holds dork block cooldown rows (qhash 'cooldown:<provider>').
    CREATE TABLE IF NOT EXISTS search_usage (
      day TEXT NOT NULL,
      provider TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, provider)
    );
    CREATE TABLE IF NOT EXISTS search_cache (
      qhash TEXT PRIMARY KEY,
      provider TEXT,
      kind TEXT,
      result TEXT,
      at TEXT
    );
    -- Per-host daily apply counter (plan 8G task 4; consumed by task 18).
    CREATE TABLE IF NOT EXISTS apply_host_day (
      host TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (host, day)
    );
    -- Persisted block events per host (plan 8G-2 task 20): host cooldown and the bot_wall halt streak.
    CREATE TABLE IF NOT EXISTS apply_host_blocks (
      host TEXT NOT NULL,
      kind TEXT NOT NULL,
      at TEXT NOT NULL,
      run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_apply_host_blocks_host ON apply_host_blocks (host, at);
  `);

  // Migration: older databases created before `method`/`account` existed on
  // `applications` (added for linkedin-apply's Easy Apply tracking). Add them
  // if missing so existing data.sqlite files don't break.
  const applicationColumns = db.prepare("PRAGMA table_info(applications)").all() as Array<{ name: string }>;
  const columnNames = new Set(applicationColumns.map((c) => c.name));
  if (!columnNames.has('method')) {
    db.exec('ALTER TABLE applications ADD COLUMN method TEXT');
  }
  if (!columnNames.has('account')) {
    db.exec('ALTER TABLE applications ADD COLUMN account TEXT');
  }

  // Migration: older databases created before `connect_company` existed on
  // `outreach_queue`. Add it if missing so existing data.sqlite files don't break.
  const outreachQueueColumns = db.prepare("PRAGMA table_info(outreach_queue)").all() as Array<{ name: string }>;
  const outreachQueueColumnNames = new Set(outreachQueueColumns.map((c) => c.name));
  if (!outreachQueueColumnNames.has('connect_company')) {
    db.exec('ALTER TABLE outreach_queue ADD COLUMN connect_company TEXT');
  }

  const jobCols = new Set((db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map(c => c.name));
  for (const col of ['match_reasons', 'match_missing', 'location_verdict', 'language_gate', 'excluded_reason',
    'posted_at', 'deadline', 'deadline_reported', 'language_note', 'score_dims', 'requirements', 'strengths', 'gaps', 'hard_stops', 'confidence',
    'title_key', 'company_key', 'legitimacy', 'legitimacy_signals', 'gate_flags', 'jd_snapshot', 'jd_snapshot_at', 'score_cap_reason']) {
    if (!jobCols.has(col)) db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
  }
  // Count of match-save rejections per job: after MATCH_FAIL_LIMIT the wake pipeline stops re-offering it (plan 8G task 13).
  if (!jobCols.has('match_fails')) db.exec('ALTER TABLE jobs ADD COLUMN match_fails INTEGER NOT NULL DEFAULT 0');
  // Hand-backs of a matched job without an outreach row to the wake pipeline (PREP_OFFER_LIMIT).
  if (!jobCols.has('prep_offers')) db.exec('ALTER TABLE jobs ADD COLUMN prep_offers INTEGER NOT NULL DEFAULT 0');
  if (!outreachQueueColumnNames.has('resume_json')) db.exec('ALTER TABLE outreach_queue ADD COLUMN resume_json TEXT');
  for (const [col, type] of [['ats_coverage', 'INTEGER'], ['ats_gaps', 'TEXT'], ['fact_warnings', 'TEXT'], ['review_applied', 'INTEGER'], ['review_rejected', 'INTEGER']] as const) {
    if (!outreachQueueColumnNames.has(col)) db.exec(`ALTER TABLE outreach_queue ADD COLUMN ${col} ${type}`);
  }
  for (const col of ['email_sent_at', 'email_message_id', 'email_thread_id', 'apply_tier']) {
    if (!outreachQueueColumnNames.has(col)) db.exec(`ALTER TABLE outreach_queue ADD COLUMN ${col} TEXT`);
  }
  // Migration: processed_messages.candidates (JSON array of job ids) for an ambiguous reply/bounce, so follow-ups are blocked for every candidate.
  const pmCols = new Set((db.prepare('PRAGMA table_info(processed_messages)').all() as { name: string }[]).map((c) => c.name));
  if (!pmCols.has('candidates')) db.exec('ALTER TABLE processed_messages ADD COLUMN candidates TEXT');
  // Backfill: rows sent before email_sent_at existed. updated_at is when the sender marked them sent. Idempotent, and guarded:
  // a legacy table without email_status or updated_at has nothing to backfill (and must still open).
  const queueNow = new Set((db.prepare('PRAGMA table_info(outreach_queue)').all() as { name: string }[]).map((c) => c.name));
  if (queueNow.has('email_status') && queueNow.has('updated_at')) {
    db.exec("UPDATE outreach_queue SET email_sent_at = updated_at WHERE email_status = 'sent' AND email_sent_at IS NULL AND updated_at IS NOT NULL");
  }

  dedupeOutreachQueue(db);
  backfillJobKeys(db);
  migrateOutreachTables(db);
  migrateSchedulerTables(db);
  return db;
}

/** Mark a queued email sent (and its duplicate rows for the same job+recipient, which share one email). */
/**
 * One outreach_queue row per job and connect profile (a null profile is the job's email/apply row). Older databases hold
 * duplicate pairs, so dedupe first, then create the unique index. Survivor: the most advanced row (anything sent, claimed or
 * submitted beats queued), then the earliest sent, then the lowest id; a sent row is never deleted in favour of a queued one.
 * Nothing references outreach_queue ids, so deleting the losers is safe. Idempotent; a legacy table without the columns is left alone.
 */
function dedupeOutreachQueue(db: BetterSqlite3.Database): void {
  const cols = new Set((db.prepare('PRAGMA table_info(outreach_queue)').all() as { name: string }[]).map((c) => c.name));
  for (const c of ['job_id', 'connect_profile_url', 'email_status', 'email_sent_at', 'connect_status', 'apply_status', 'status']) if (!cols.has(c)) return;
  const adv = (col: string) => `(${col} IS NOT NULL AND ${col} NOT IN ('queued', 'pending', 'skipped', 'held_review'))`;
  const advanced = `(email_sent_at IS NOT NULL OR ${adv('email_status')} OR ${adv('connect_status')} OR ${adv('apply_status')} OR ${adv('status')})`;
  db.transaction(() => {
    db.exec(`
      DELETE FROM outreach_queue WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY job_id, COALESCE(connect_profile_url, '')
            ORDER BY CASE WHEN ${advanced} THEN 0 ELSE 1 END, CASE WHEN email_sent_at IS NULL THEN 1 ELSE 0 END, email_sent_at, id
          ) AS rn FROM outreach_queue
        ) WHERE rn > 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_queue_job_profile ON outreach_queue (job_id, COALESCE(connect_profile_url, ''));
    `);
  })();
}

export function recordEmailSent(db: BetterSqlite3.Database, queueId: number, messageId: string | null): number {
  const r = db.prepare('SELECT job_id, email_to FROM outreach_queue WHERE id = ?').get(queueId) as { job_id: string; email_to: string | null } | undefined;
  if (!r) return 0;
  return db.prepare(`UPDATE outreach_queue SET email_status = 'sent', email_sent_at = coalesce(email_sent_at, datetime('now')), email_message_id = ?, updated_at = datetime('now')
    WHERE id = ? OR (job_id = ? AND email_to IS ? AND coalesce(email_status, '') != 'sent')`).run(messageId, queueId, r.job_id, r.email_to).changes;
}

export function setEmailThread(db: BetterSqlite3.Database, messageId: string, threadId: string): number {
  return db.prepare('UPDATE outreach_queue SET email_thread_id = ? WHERE email_message_id = ?').run(threadId, messageId).changes;
}

export interface SentEmail {
  job_id: string; company: string | null; title: string | null; email_to: string | null; subject: string | null;
  body: string | null; message_id: string | null; thread_id: string | null; sent_at: string;
}

/** One row per job whose cold email was sent in the last `sinceDays` days (earliest send). */
export function listSentEmails(db: BetterSqlite3.Database, sinceDays = 120): SentEmail[] {
  return db.prepare(`
    SELECT q.job_id, j.company, j.title, q.email_to, q.email_subject AS subject, q.email_body AS body,
           q.email_message_id AS message_id, q.email_thread_id AS thread_id, q.email_sent_at AS sent_at
    FROM outreach_queue q LEFT JOIN jobs j ON j.id = q.job_id
    WHERE q.email_status = 'sent' AND q.email_sent_at IS NOT NULL AND q.email_sent_at >= datetime('now', ?)
      AND q.id = (SELECT MIN(q2.id) FROM outreach_queue q2 WHERE q2.job_id = q.job_id AND q2.email_status = 'sent' AND q2.email_sent_at IS NOT NULL)
    ORDER BY q.email_sent_at ASC`).all(`-${Math.max(1, Math.floor(sinceDays))} days`) as SentEmail[];
}

export function isSeen(db: BetterSqlite3.Database, id: string): boolean {
  const result = db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id);
  return result !== undefined;
}

export interface Job {
  id: string;
  source: string;
  title: string;
  company: string;
  url: string;
  apply_url: string;
  description: string;
  score?: number;
  status?: string;
  posted_at?: string;
}

/** Normalize a source's posting date to UTC 'YYYY-MM-DD'; undefined when absent or invalid. */
export function toIsoDay(v: unknown): string | undefined {
  if (v == null || v === '') return undefined;
  let d: Date;
  if (typeof v === 'number' && Number.isFinite(v)) d = new Date(v < 1e12 ? v * 1000 : v);
  else if (typeof v === 'string') {
    const s = v.trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(s);
    if (!m) return undefined;
    // Validate the calendar date in BOTH branches (no rollover such as 02-30 -> 03-02).
    const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (day.getUTCFullYear() !== +m[1] || day.getUTCMonth() !== +m[2] - 1 || day.getUTCDate() !== +m[3]) return undefined;
    // A datetime without a zone is read as UTC so the day never depends on the process timezone.
    const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(s.slice(10));
    d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? day : new Date(hasZone ? s : `${s.replace(' ', 'T')}Z`);
  } else return undefined;
  if (Number.isNaN(d.getTime())) return undefined;
  const iso = d.toISOString().slice(0, 10);
  const year = Number(iso.slice(0, 4));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || year < 2000 || year > new Date().getUTCFullYear() + 1) return undefined;
  return iso;
}

export function saveJob(db: BetterSqlite3.Database, job: Job): void {
  db.prepare(`
    INSERT OR IGNORE INTO jobs (id, source, title, company, url, apply_url, description, score, status, posted_at, title_key, company_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id,
    job.source,
    job.title,
    job.company,
    job.url,
    job.apply_url,
    job.description,
    job.score ?? null,
    job.status ?? null,
    job.posted_at ?? null,
    titleIdentityKey(job.title),
    companyKey(job.company)
  );
}

/** Fill title_key/company_key for rows saved before those columns existed. Returns rows updated. */
export function backfillJobKeys(db: BetterSqlite3.Database): number {
  const rows = db.prepare('SELECT id, title, company FROM jobs WHERE title_key IS NULL OR company_key IS NULL').all() as Array<{ id: string; title: string | null; company: string | null }>;
  const upd = db.prepare('UPDATE jobs SET title_key = ?, company_key = ? WHERE id = ?');
  db.transaction(() => { for (const r of rows) upd.run(titleIdentityKey(r.title), companyKey(r.company), r.id); })();
  return rows.length;
}

export function repostCountForJob(db: BetterSqlite3.Database, jobId: string, windowDays = 90): number {
  const t = db.prepare('SELECT id, source, company, title, url, created_at AS first_seen, title_key, company_key FROM jobs WHERE id = ?').get(jobId) as any;
  if (!t) return 0;
  const others = db.prepare(`SELECT id, source, company, title, url, created_at AS first_seen FROM jobs
    WHERE source IS ? AND company_key = ? AND title_key = ? AND id != ?`).all(t.source, t.company_key, t.title_key, jobId) as any[];
  return repostCount(t, others, windowDays);
}

export function getJob(db: BetterSqlite3.Database, id: string): Job | undefined {
  const result = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;
  return result ? {
    id: result.id,
    source: result.source,
    title: result.title,
    company: result.company,
    url: result.url,
    apply_url: result.apply_url,
    description: result.description,
    score: result.score,
    status: result.status,
    posted_at: result.posted_at ?? undefined,
  } : undefined;
}

export interface MatchResultInput {
  job_id: string; score: number; reasons: string; missing_keywords: string[];
  location_verdict?: 'PASS' | 'FAIL' | 'FLAG'; language_gate?: 'PASS' | 'FAIL' | 'FLAG';
}
export function saveMatchResult(db: BetterSqlite3.Database, r: MatchResultInput): void {
  db.prepare(`UPDATE jobs SET score = ?, match_reasons = ?, match_missing = ?, location_verdict = ?, language_gate = ? WHERE id = ?`)
    .run(r.score, r.reasons, JSON.stringify(r.missing_keywords), r.location_verdict ?? null, r.language_gate ?? null, r.job_id);
}

// Persists a pre-apply veto: a non-null excluded_reason means /apply and /applyall skip the job.
// Returns false when the job_id does not exist.
export function setJobExcluded(db: BetterSqlite3.Database, jobId: string, reason: string): boolean {
  return db.prepare('UPDATE jobs SET excluded_reason = ? WHERE id = ?').run(reason, jobId).changes > 0;
}

/** True when the user manually un-excluded the job (a row in job_exclusion_log): a durable override. */
export function hasExclusionOverride(db: BetterSqlite3.Database, jobId: string): boolean {
  return db.prepare('SELECT 1 FROM job_exclusion_log WHERE job_id = ? LIMIT 1').get(jobId) !== undefined;
}

/** Manual override (/include #N): clears excluded_reason and logs the previous reason in job_exclusion_log.
 *  The log row is a durable override: sweepDeadlines and apply_vetoes' deadline rule skip the job from then on.
 *  It does NOT resume outreach_queue rows already marked "skipped" (re-enqueue them or ask). */
export function unexcludeJob(
  db: BetterSqlite3.Database,
  jobId: string,
): { ok: true; job_id: string; previous_reason: string } | { ok: false; job_id: string; error: string } {
  return db.transaction(() => {
    const row = db.prepare('SELECT excluded_reason FROM jobs WHERE id = ?').get(jobId) as { excluded_reason: string | null } | undefined;
    if (!row) return { ok: false as const, job_id: jobId, error: 'unknown job_id' };
    if (row.excluded_reason == null) return { ok: false as const, job_id: jobId, error: 'job is not excluded' };
    db.prepare('INSERT INTO job_exclusion_log (job_id, previous_reason) VALUES (?, ?)').run(jobId, row.excluded_reason);
    db.prepare('UPDATE jobs SET excluded_reason = NULL WHERE id = ?').run(jobId);
    return { ok: true as const, job_id: jobId, previous_reason: row.excluded_reason };
  })();
}

// Returns the veto reason for a job, or null when the job is unknown or not vetoed.
export function getExcludedReason(db: BetterSqlite3.Database, jobId: string): string | null {
  const row = db.prepare('SELECT excluded_reason FROM jobs WHERE id = ?').get(jobId) as
    | { excluded_reason: string | null }
    | undefined;
  return row?.excluded_reason ?? null;
}

/** The first stored hard stop for a job (apply tools refuse on it), or null when there is none.
 *  Corrupt or non-array JSON fails closed with a fixed marker. */
export function getFirstHardStop(db: BetterSqlite3.Database, jobId: string): string | null {
  const row = db.prepare('SELECT hard_stops FROM jobs WHERE id = ?').get(jobId) as { hard_stops: string | null } | undefined;
  const raw = row?.hard_stops;
  if (raw == null || raw.trim() === '') return null;
  try {
    const v = JSON.parse(raw);
    // Any non-string item means the stored value is corrupt: fail closed.
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return 'unreadable hard_stops data';
    const first = v.find((x: string) => x.trim() !== '');
    return first ?? null;
  } catch {
    return 'unreadable hard_stops data';
  }
}

export interface JobListRow {
  id: string; source: string; title: string; company: string; score: number | null;
  status: string; created_at: string; excluded_reason: string | null;
}

// Backs db.list_jobs. excludeVetoed hides jobs with a non-null excluded_reason.
export function listJobs(
  db: BetterSqlite3.Database,
  opts: { status?: string; limit?: number; excludeVetoed?: boolean } = {}
): JobListRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  if (opts.excludeVetoed) where.push('excluded_reason IS NULL');
  const sql =
    'SELECT id, source, title, company, score, status, created_at, excluded_reason FROM jobs' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY created_at DESC LIMIT ?';
  params.push(opts.limit ?? 100);
  return db.prepare(sql).all(...params) as JobListRow[];
}

export interface Contact {
  company: string;
  email: string;
  type: string;
  verified: boolean;
  source: string;
  confidence?: number;
}

export function saveContact(db: BetterSqlite3.Database, contact: Contact): void {
  db.prepare(`
    INSERT INTO contacts (company, email, type, verified, source, confidence)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    contact.company,
    contact.email,
    contact.type,
    contact.verified ? 1 : 0,
    contact.source,
    contact.confidence ?? null
  );
}

export interface Outreach {
  job_id: string;
  contact_email: string;
  subject: string;
  body: string;
  resume_path: string;
  status?: string;
}

export function saveOutreach(db: BetterSqlite3.Database, outreach: Outreach): void {
  db.prepare(`
    INSERT INTO outreach (job_id, contact_email, subject, body, resume_path, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    outreach.job_id,
    outreach.contact_email,
    outreach.subject,
    outreach.body,
    outreach.resume_path,
    outreach.status ?? null
  );
}

export interface Application {
  job_id: string;
  platform: string | null;
  method?: string | null;
  account?: string | null;
  status: 'submitted' | 'manual_review' | 'failed' | 'needs_answer';
  reason?: string | null;
  applied_at?: string | null;
}

export function saveApplication(db: BetterSqlite3.Database, application: Application): void {
  db.prepare(`
    INSERT INTO applications (job_id, platform, method, account, status, reason, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    application.job_id,
    application.platform ?? null,
    application.method ?? null,
    application.account ?? null,
    application.status,
    application.reason ?? null,
    application.applied_at ?? null
  );
}

export interface Connection {
  job_id?: string | null;
  company?: string | null;
  profile_url: string;
  headline?: string | null;
  note: string;
  status: 'drafted' | 'approved' | 'sent' | 'skipped' | 'messaged';
  sent_at?: string | null;
}

export function saveConnection(db: BetterSqlite3.Database, connection: Connection): void {
  db.prepare(`
    INSERT INTO connections (job_id, company, profile_url, headline, note, status, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    connection.job_id ?? null,
    connection.company ?? null,
    connection.profile_url,
    connection.headline ?? null,
    connection.note,
    connection.status,
    connection.sent_at ?? null
  );
}

export interface OutreachQueueItem {
  id: number;
  job_id: string;
  resume_pdf_path: string | null;
  email_subject: string | null;
  email_body: string | null;
  email_to: string | null;
  email_status: string | null;
  connect_note: string | null;
  connect_profile_url: string | null;
  connect_category: string | null;
  connect_company: string | null;
  connect_status: string | null;
  apply_platform: string | null;
  apply_tier: string | null;
  apply_url: string | null;
  apply_status: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

// Code-authoritative apply classification for a queue row. The model's platform is ignored unless it is 'none' (an opt-out);
// everything else is decided from the job's stored source and the apply_url by classifyApplyUrl (src/apply/registry.ts).
export function classifyQueueApply(
  db: BetterSqlite3.Database,
  jobId: string,
  modelPlatform: string | null | undefined,
  applyUrl: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { apply_platform: string; apply_tier: string } {
  if (modelPlatform === 'none') return { apply_platform: 'none', apply_tier: 'never' };
  const source = (db.prepare('SELECT source FROM jobs WHERE id = ?').get(jobId) as { source: string | null } | undefined)?.source ?? null;
  const c = classifyApplyUrl(applyUrl ?? null, source, env);
  return { apply_platform: c.platform, apply_tier: c.tier };
}

// What the enqueue_outreach MCP tool does: the model's apply_platform is replaced by the code classification.
export function enqueueOutreachClassified(
  db: BetterSqlite3.Database,
  item: Parameters<typeof enqueueOutreach>[1],
  env: NodeJS.ProcessEnv = process.env,
): number {
  return enqueueOutreachClassifiedResult(db, item, env).id;
}

// Same as enqueueOutreachClassified, but says whether the row already existed (uniqueness per job and connect profile).
export function enqueueOutreachClassifiedResult(
  db: BetterSqlite3.Database,
  item: Parameters<typeof enqueueOutreach>[1],
  env: NodeJS.ProcessEnv = process.env,
): { id: number; duplicate: boolean } {
  const cls = classifyQueueApply(db, item.job_id, item.apply_platform, item.apply_url, env);
  return enqueueOutreachResult(db, { ...item, apply_platform: cls.apply_platform, apply_tier: cls.apply_tier });
}

export function enqueueOutreach(
  db: BetterSqlite3.Database,
  item: {
    job_id: string;
    resume_pdf_path: string | null;
    email_subject: string | null;
    email_body: string | null;
    email_to: string | null;
    connect_note: string | null;
    connect_profile_url: string | null;
    connect_category: string | null;
    connect_company: string | null;
    apply_platform: string | null;
    apply_tier?: string | null;
    apply_url: string | null;
    resume_json?: string | null;
    ats_coverage?: number | null;
    ats_gaps?: string[] | null;
    fact_warnings?: string[] | null;
    review_applied?: number | null;
    review_rejected?: number | null;
  }
): number {
  return enqueueOutreachResult(db, item).id;
}

// Inserts the row unless one exists for the same job and connect profile (unique index); a duplicate returns the existing id and changes nothing.
export function enqueueOutreachResult(
  db: BetterSqlite3.Database,
  item: Parameters<typeof enqueueOutreach>[1],
): { id: number; duplicate: boolean } {
  // Discover-only sources (see src/lib/discoverOnly.ts) never get an apply attempt, whatever the preparer asked for: 'none' keeps
  // the sender away from the shared daily apply counter while email and connect outreach on the same row still run.
  const source = (db.prepare('SELECT source FROM jobs WHERE id = ?').get(item.job_id) as { source: string | null } | undefined)?.source;
  const applyPlatform = isDiscoverOnlySource(source) ? 'none' : item.apply_platform;
  // Generated-provider jobs (source gen:*) are matched and listed, but their outreach rows wait for the owner (plan 8G D7): held_review
  // until `npm run providers -- approve <id>` releases them. list_queued_outreach returns only status 'queued', so a held row is never sent.
  const held = isHeldSource(source) && !(db.prepare('SELECT approved FROM generated_providers WHERE id = ?').get(String(source).slice(4)) as { approved: number } | undefined)?.approved;
  const result = db.prepare(`
    INSERT OR IGNORE INTO outreach_queue (
      job_id, resume_pdf_path, email_subject, email_body, email_to,
      connect_note, connect_profile_url, connect_category, connect_company,
      apply_platform, apply_tier, apply_url, resume_json,
      ats_coverage, ats_gaps, fact_warnings, review_applied, review_rejected, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.job_id,
    item.resume_pdf_path,
    item.email_subject,
    item.email_body,
    item.email_to,
    item.connect_note,
    item.connect_profile_url,
    item.connect_category,
    item.connect_company,
    applyPlatform,
    applyPlatform === 'none' ? 'never' : (item.apply_tier ?? 'never'),
    item.apply_url,
    item.resume_json ?? null,
    item.ats_coverage ?? null,
    item.ats_gaps ? JSON.stringify(item.ats_gaps) : null,
    item.fact_warnings ? JSON.stringify(item.fact_warnings) : null,
    item.review_applied ?? null,
    item.review_rejected ?? null,
    held ? 'held_review' : 'queued'
  );
  if (result.changes === 0) {
    const existing = db.prepare("SELECT id FROM outreach_queue WHERE job_id = ? AND COALESCE(connect_profile_url, '') = COALESCE(?, '') ORDER BY id LIMIT 1")
      .get(item.job_id, item.connect_profile_url) as { id: number };
    return { id: existing.id, duplicate: true };
  }
  return { id: Number(result.lastInsertRowid), duplicate: false };
}

export function listQueuedOutreach(db: BetterSqlite3.Database): OutreachQueueItem[] {
  return db
    // Explicit columns: omit resume_json (several KB per row, no consumer in the sender).
    .prepare(`SELECT id, job_id, resume_pdf_path, email_subject, email_body, email_to, email_status,
      connect_note, connect_profile_url, connect_category, connect_company, connect_status,
      apply_platform, apply_tier, apply_url, apply_status, status, created_at, updated_at
      FROM outreach_queue
      WHERE status = 'queued'
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = outreach_queue.job_id AND j.excluded_reason IS NULL)
      ORDER BY created_at ASC`)
    .all() as OutreachQueueItem[];
}

// Queued rows that listQueuedOutreach skips because their job was excluded after the row was queued
// (the sender reports these instead of sending).
export function listExcludedQueuedOutreach(
  db: BetterSqlite3.Database
): { id: number; job_id: string; reason: string }[] {
  return db
    .prepare(`SELECT q.id AS id, q.job_id AS job_id, coalesce(j.excluded_reason, 'unknown job') AS reason
      FROM outreach_queue q LEFT JOIN jobs j ON j.id = q.job_id
      WHERE q.status = 'queued' AND (j.id IS NULL OR j.excluded_reason IS NOT NULL)
      ORDER BY q.created_at ASC, q.id ASC`)
    .all() as { id: number; job_id: string; reason: string }[];
}

const UPDATABLE_FIELDS = ['email_status', 'connect_status', 'apply_status', 'status'] as const;

export function updateOutreachStatus(
  db: BetterSqlite3.Database,
  id: number,
  field: (typeof UPDATABLE_FIELDS)[number],
  value: string
): void {
  if (!UPDATABLE_FIELDS.includes(field)) {
    throw new Error(`updateOutreachStatus: invalid field "${field}"`);
  }
  db.prepare(`UPDATE outreach_queue SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(value, id);
}

export type Outcome = 'replied' | 'interview' | 'offer' | 'hired' | 'rejected' | 'no_response';

export function recordOutcome(db: BetterSqlite3.Database, jobId: string, outcome: Outcome, note?: string): void {
  db.prepare('INSERT INTO job_outcomes (job_id, outcome, note) VALUES (?, ?, ?)').run(jobId, outcome, note ?? null);
  skipPendingFollowups(db, jobId);
}

// The ONE helper that ends a job's pending follow-ups (drafted -> skipped, approved -> cancelled). recordOutcome calls it, and every outcome
// path goes through recordOutcome (record_outcome/recordOutcomeChecked, auto-record in triageReplies, resolveReplyProposals approve, resolveStale),
// so a follow-up can never be sent after an outcome exists (ruling Y4). A `sending` row (claimed by the sender, send in flight) is left alone so
// markFollowupSent can still record the truth (with late_block); a `cancelled` row can never become sent.
export function skipPendingFollowups(db: BetterSqlite3.Database, jobId: string): number {
  let n = 0;
  db.transaction(() => {
    n += db.prepare("UPDATE followups SET status = 'skipped', decided_at = datetime('now') WHERE job_id = ? AND status = 'drafted'").run(jobId).changes;
    n += db.prepare("UPDATE followups SET status = 'cancelled', decided_at = datetime('now') WHERE job_id = ? AND status = 'approved'").run(jobId).changes;
  })();
  return n;
}

// Records the outcome even for an unknown job_id, but flags it so a typo'd id is visible.
export function recordOutcomeChecked(
  db: BetterSqlite3.Database,
  jobId: string,
  outcome: Outcome,
  note?: string
): { recorded: true; warning?: string } {
  const known = db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(jobId) !== undefined;
  recordOutcome(db, jobId, outcome, note);
  return known ? { recorded: true } : { recorded: true, warning: 'unknown job_id' };
}

export function saveMatchResults(db: BetterSqlite3.Database, results: MatchResultInput[]): number {
  db.transaction((rs: MatchResultInput[]) => {
    for (const r of rs) saveMatchResult(db, r);
  })(results);
  return results.length;
}

/** v2 writer: validates every row, writes only valid rows, a null deadline never erases a stored one.
 *  A row that is only `{job_id, error}` (matcher batch-overflow marker) is reported in `errors`, never fails the call.
 *  Quotes are checked against the description PLUS the archived snapshot (the model may have quoted either). */
export function saveMatchResultsChecked(
  db: BetterSqlite3.Database,
  rows: MatchRowInput[],
): {
  saved: number; errors: Array<{ job_id: string; error: string }>; hard_stops: Array<{ job_id: string; hard_stops: string[] }>;
  injection_suspects: Array<{ job_id: string; phrases: string[] }>;
  // The STORED values per saved row (after the evidence ceiling and injection cap): callers filter on these, never on the matcher's own score.
  scores: Array<{ job_id: string; score: number; score_cap_reason: string | null; confidence: 'high' | 'medium' | 'low' }>;
} {
  const errors: Array<{ job_id: string; error: string }> = [];
  const stops: Array<{ job_id: string; hard_stops: string[] }> = [];
  const suspects: Array<{ job_id: string; phrases: string[] }> = [];
  const scores: Array<{ job_id: string; score: number; score_cap_reason: string | null; confidence: 'high' | 'medium' | 'low' }> = [];
  let saved = 0;
  const descOf = db.prepare("SELECT trim(coalesce(description, '') || ' ' || coalesce(jd_snapshot, '')) AS d FROM jobs WHERE id = ?");
  const upd = db.prepare(`UPDATE jobs SET score = ?, match_reasons = ?, match_missing = ?, location_verdict = ?, language_gate = ?,
    language_note = ?, score_dims = ?, requirements = ?, strengths = ?, gaps = ?, hard_stops = ?, confidence = ?,
    deadline = COALESCE(?, deadline), score_cap_reason = ? WHERE id = ?`);
  const failed = db.prepare('UPDATE jobs SET match_fails = match_fails + 1 WHERE id = ?');
  const seen = new Set<string>();
  db.transaction(() => {
    for (const r of rows as unknown[]) {
      // Per-row rejection: a null/non-object row or one without a string job_id never fails the call.
      if (!r || typeof r !== 'object' || typeof (r as any).job_id !== 'string') {
        errors.push({ job_id: r && typeof r === 'object' && (r as any).job_id != null ? String((r as any).job_id) : '', error: 'invalid row: missing string job_id' });
        continue;
      }
      const row = r as MatchRowInput;
      // First occurrence of a job_id wins (an error row counts as an occurrence); later ones are duplicates.
      if (seen.has(row.job_id)) { errors.push({ job_id: row.job_id, error: 'duplicate job_id' }); continue; }
      seen.add(row.job_id);
      if (typeof row.error === 'string') { errors.push({ job_id: row.job_id, error: row.error }); failed.run(row.job_id); continue; }
      const found = descOf.get(row.job_id) as { d: string | null } | undefined;
      if (!found) { errors.push({ job_id: row.job_id, error: 'unknown job_id' }); continue; }
      const desc = found.d ?? undefined;
      const n = normalizeMatchRow(row, desc);
      if (!n.ok) { errors.push({ job_id: row.job_id, error: n.error }); failed.run(row.job_id); continue; }
      const x = n.row;
      const res = upd.run(x.score, x.reasons, JSON.stringify(x.missing_keywords ?? []), x.location_verdict ?? null, x.language_gate ?? null,
        x.language_note, x.score_dims ? JSON.stringify(x.score_dims) : null, JSON.stringify(x.requirements), JSON.stringify(x.strengths),
        JSON.stringify(x.gaps), JSON.stringify(x.hard_stops), x.confidence, x.deadline ?? null, x.score_cap_reason, x.job_id);
      if (res.changes === 0) { errors.push({ job_id: x.job_id, error: 'unknown job_id' }); continue; }
      saved++;
      scores.push({ job_id: x.job_id, score: x.score, score_cap_reason: x.score_cap_reason, confidence: x.confidence });
      if (x.hard_stops.length) stops.push({ job_id: x.job_id, hard_stops: x.hard_stops });
      if (x.injection_phrases.length) suspects.push({ job_id: x.job_id, phrases: x.injection_phrases });
    }
  })();
  return { saved, errors, hard_stops: stops, injection_suspects: suspects, scores };
}

/** Rejected match saves after which a job is no longer offered to the wake pipeline. */
export const MATCH_FAIL_LIMIT = 2;

/**
 * Longest description `listUnscoredJobs` hands to the wake session. An aggregator posting can run to 50000 characters of HTML;
 * 25 of those exceed the size limit of one tool result and the wake could then score a single job. The stored text is not cut,
 * and the veto gates read it from the db.
 */
export const UNSCORED_DESCRIPTION_CHARS = 1500;

export interface UnscoredJob extends Job {
  /** `apply_capable`, or the closed reason code from channelsFor (`discover_only_source`, `apply_tier:<tier>`, `held_review`). */
  apply_class: string;
  channels: ChannelVerdict[];
  /** Set only when `description` was cut to UNSCORED_DESCRIPTION_CHARS. */
  description_truncated?: true;
  /** Set on a job already scored at or above the threshold and vetoed clean that never got an outreach row: skip matching, go to contacts. */
  already_matched?: true;
  /** The stored score, only on an already_matched job. */
  score?: number;
}

/** Times a matched job without an outreach row is handed back before it is dropped (a job with no contact and no profile never gets a row). */
export const PREP_OFFER_LIMIT = 2;

/**
 * The wake pipeline's input. First the jobs scored at or above `matchThreshold`, not excluded, with no outreach row yet (at most
 * PREP_OFFER_LIMIT hand-backs each, counted in `prep_offers`), marked `already_matched` with the stored score; then the jobs saved but
 * not scored, not excluded and not given up on, taken round-robin by source (oldest first within a source) so one source's backlog
 * cannot starve the others. Full Job rows plus the channelsFor result (computed without a Hacker News domain check, so an HN job shows
 * hn_gate_pending until the contact stage). Without `matchThreshold` no matched job is returned.
 */
export function listUnscoredJobs(db: BetterSqlite3.Database, opts: { limit?: number; matchThreshold?: number } = {}): UnscoredJob[] {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 25)));
  type Row = Record<string, string | number | null>;
  const cols = 'id, source, title, company, url, apply_url, description, posted_at, score';
  const pending: Row[] = typeof opts.matchThreshold === 'number'
    ? db.prepare(
      `SELECT ${cols} FROM jobs
        WHERE score >= ? AND excluded_reason IS NULL AND prep_offers < ?
          AND NOT EXISTS (SELECT 1 FROM outreach_queue q WHERE q.job_id = jobs.id)
        ORDER BY score DESC, created_at ASC, rowid ASC LIMIT ?`,
    ).all(opts.matchThreshold, PREP_OFFER_LIMIT, limit) as Row[]
    : [];
  if (pending.length) {
    const bump = db.prepare('UPDATE jobs SET prep_offers = prep_offers + 1 WHERE id = ?');
    db.transaction(() => { for (const r of pending) bump.run(r.id as string); })();
  }
  const fresh = db.prepare(
    `SELECT ${cols} FROM (
       SELECT *, rowid AS rid, ROW_NUMBER() OVER (PARTITION BY source ORDER BY created_at ASC, rowid ASC) AS rn FROM jobs
        WHERE score IS NULL AND excluded_reason IS NULL AND match_fails < ?)
      ORDER BY rn ASC, created_at ASC, rid ASC LIMIT ?`,
  ).all(MATCH_FAIL_LIMIT, Math.max(0, limit - pending.length)) as Row[];
  const toJob = (r: Row, matched: boolean): UnscoredJob => {
    const job: Job = {
      id: r.id as string, source: (r.source ?? '') as string, title: (r.title ?? '') as string, company: (r.company ?? '') as string,
      url: (r.url ?? '') as string, apply_url: (r.apply_url ?? '') as string, description: (r.description ?? '') as string,
      ...(r.posted_at ? { posted_at: r.posted_at as string } : {}),
    };
    const channels = channelsFor(job);
    const apply = channels.find((c) => c.channel === 'apply');
    const cut = job.description.length > UNSCORED_DESCRIPTION_CHARS;
    return {
      ...job,
      ...(cut ? { description: job.description.slice(0, UNSCORED_DESCRIPTION_CHARS), description_truncated: true as const } : {}),
      apply_class: apply?.eligible ? 'apply_capable' : (apply?.reason ?? 'apply_tier:none'),
      channels,
      ...(matched ? { already_matched: true as const, score: r.score as number } : {}),
    };
  };
  return [...pending.map((r) => toJob(r, true)), ...fresh.map((r) => toJob(r, false))];
}

export function markExcluded(
  db: BetterSqlite3.Database,
  exclusions: { job_id: string; reason: string }[]
): { marked: number; unknown: string[] } {
  const unknown: string[] = [];
  let marked = 0;
  db.transaction(() => {
    for (const e of exclusions) {
      if (setJobExcluded(db, e.job_id, e.reason)) marked++;
      else unknown.push(e.job_id);
    }
  })();
  return { marked, unknown };
}

export function getCalibrationRows(db: BetterSqlite3.Database): { score: number; outcome: Outcome }[] {
  return db.prepare(`
    SELECT j.score AS score, o.outcome AS outcome
    FROM jobs j JOIN job_outcomes o ON o.job_id = j.id
    WHERE j.score IS NOT NULL AND o.id = (SELECT MAX(id) FROM job_outcomes WHERE job_id = j.id)
  `).all() as { score: number; outcome: Outcome }[];
}

/** True when we already acted on the job (sent email/connect, submitted application): follow-ups must survive a passed deadline. */
export function jobHasActedWork(db: BetterSqlite3.Database, jobId: string): boolean {
  return db.prepare(`SELECT 1 FROM jobs WHERE id = ? AND (
      EXISTS (SELECT 1 FROM outreach_queue q WHERE q.job_id = jobs.id
        AND (q.email_status = 'sent' OR q.connect_status = 'sent' OR q.apply_status = 'submitted'))
      OR EXISTS (SELECT 1 FROM outreach o WHERE o.job_id = jobs.id AND o.status = 'sent')
      OR EXISTS (SELECT 1 FROM applications a WHERE a.job_id = jobs.id AND a.status = 'submitted'))`).get(jobId) !== undefined;
}

/** Run at hunt start: expire scored, not-yet-excluded jobs whose ISO deadline has passed; report closing-soon and unparseable ones.
 *  Jobs we already acted on (sent email/connect, submitted application) are left alone: excluding them would stop their follow-ups.
 *  An unparseable deadline is reported once (remembered in deadline_reported); changing the text reports it again. */
export function sweepDeadlines(db: BetterSqlite3.Database, now: Date = new Date()): DeadlineSweep {
  const rows = db.prepare(`SELECT id, deadline, source, deadline_reported FROM jobs
    WHERE deadline IS NOT NULL AND excluded_reason IS NULL AND score IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM job_exclusion_log l WHERE l.job_id = jobs.id)
      AND NOT EXISTS (SELECT 1 FROM outreach_queue q WHERE q.job_id = jobs.id
        AND (q.email_status = 'sent' OR q.connect_status = 'sent' OR q.apply_status = 'submitted'))
      AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.job_id = jobs.id AND o.status = 'sent')
      AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = jobs.id AND a.status = 'submitted')`)
    .all() as Array<{ id: string; deadline: string; source: string | null; deadline_reported: string | null }>;
  const seen = new Set(rows.filter((r) => r.deadline_reported === r.deadline).map((r) => r.id));
  const out = classifyDeadlines(rows, now);
  out.unparseable = out.unparseable.filter((u) => !seen.has(u.job_id));
  const mark = db.prepare('UPDATE jobs SET excluded_reason = ? WHERE id = ? AND excluded_reason IS NULL');
  const reported = db.prepare('UPDATE jobs SET deadline_reported = ? WHERE id = ?');
  db.transaction(() => {
    for (const e of out.expired) mark.run(`deadline passed: ${e.deadline}`, e.job_id);
    for (const u of out.unparseable) reported.run(u.deadline, u.job_id);
  })();
  return out;
}

export function saveGateResults(db: BetterSqlite3.Database, rows: Array<{ job_id: string; flags: string[]; gate_flags?: string[]; legitimacy?: Legitimacy }>): number {
  const upd = db.prepare('UPDATE jobs SET legitimacy = ?, legitimacy_signals = ?, gate_flags = ? WHERE id = ?');
  let n = 0;
  db.transaction(() => {
    for (const r of rows) n += upd.run(r.legitimacy?.tier ?? null, JSON.stringify(r.legitimacy?.signals ?? []), JSON.stringify(r.gate_flags ?? r.flags ?? []), r.job_id).changes;
  })();
  return n;
}

export function saveJdSnapshot(db: BetterSqlite3.Database, jobId: string, text: string): boolean {
  if (typeof text !== 'string' || text.length < 200) return false;
  return db.prepare(`UPDATE jobs SET jd_snapshot = ?, jd_snapshot_at = datetime('now')
    WHERE id = ? AND (jd_snapshot IS NULL OR length(jd_snapshot) < ?)`).run(text, jobId, text.length).changes > 0;
}
