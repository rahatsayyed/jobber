// src/dash/queries/mail.ts
// Read-only sent mail, follow-ups and replies for the dashboard. Sources: outreach_queue (src/db.ts:106: email_to, email_subject,
// email_body, email_sent_at, email_thread_id, email_status), followups (src/db.ts:156), processed_messages (src/db.ts:145).
// has_reply: a processed message for the job whose classification is not noise, auto_ack or bounce (ReplyClass in src/replies.ts:11;
// same exclusion as src/followups.ts:79). No reply body is stored, so none is returned. Keyset cursors on INTEGER ids (rowid for replies).
import type BetterSqlite3 from 'better-sqlite3';
import { clampLimit, likePattern, tableExists, type Page } from '../readDb.js';
import { cleanRow } from '../clean.js';

type Db = BetterSqlite3.Database;

export interface SentEmail {
  id: number; job_id: string; title: string | null; company: string | null; to: string | null; subject: string | null;
  sent_at: string | null; thread_id: string | null; status: string | null; has_reply: boolean;
}
export interface FollowupRow {
  id: number; job_id: string; n: number; status: string; subject: string | null; body: string | null; created_at: string; sent_at: string | null;
}
export interface ReplyRow {
  message_id: string; job_id: string | null; classification: string | null; action: string | null; proposed_outcome: string | null;
  from_addr: string | null; subject: string | null; reply_date: string | null;
}
export interface EmailDetail extends SentEmail { body: string | null; followups: FollowupRow[]; replies: ReplyRow[] }

const BODY_MAX = 20000;
const EMAIL_LIMITS: Record<string, number> = { job_id: 200, title: 300, company: 200, to: 320, subject: 500, sent_at: 64, thread_id: 200, status: 32 };
const FOLLOWUP_LIMITS: Record<string, number> = { job_id: 200, status: 32, subject: 500, body: BODY_MAX, created_at: 64, sent_at: 64 };
const REPLY_LIMITS: Record<string, number> = {
  message_id: 300, job_id: 200, classification: 32, action: 64, proposed_outcome: 32, from_addr: 320, subject: 500, reply_date: 64,
};

const NON_REPLY = "('noise', 'auto_ack', 'bounce')";
const hasReplySql = (hasPm: boolean) => hasPm
  ? `EXISTS (SELECT 1 FROM processed_messages m WHERE m.job_id = q.job_id AND coalesce(m.classification, '') NOT IN ${NON_REPLY})`
  : '0';
const hasJobs = (db: Db) => tableExists(db, 'jobs');
const emailSelect = (db: Db) => `SELECT q.id, q.job_id, ${hasJobs(db) ? 'j.title' : 'NULL'} AS title, ${hasJobs(db) ? 'j.company' : 'NULL'} AS company,
  q.email_to AS "to", q.email_subject AS subject, q.email_sent_at AS sent_at, q.email_thread_id AS thread_id, q.email_status AS status,
  ${hasReplySql(tableExists(db, 'processed_messages'))} AS has_reply
  FROM outreach_queue q ${hasJobs(db) ? 'LEFT JOIN jobs j ON j.id = q.job_id' : ''}`;
const toEmail = (r: Record<string, unknown>): SentEmail => {
  const c = cleanRow(r, EMAIL_LIMITS) as unknown as SentEmail;
  return { ...c, has_reply: Number(r.has_reply) === 1 };
};

export function listSentEmails(db: Db, opts: { q?: string; cursor?: number | null; limit?: number }): Page<SentEmail> {
  if (!tableExists(db, 'outreach_queue')) return { items: [], nextCursor: null };
  const limit = clampLimit(opts.limit);
  const where = ['q.email_sent_at IS NOT NULL'];
  const params: Record<string, unknown> = { lim: limit + 1 };
  if (opts.q && opts.q.trim() !== '') {
    where.push(hasJobs(db)
      ? "(q.email_subject LIKE @like ESCAPE '\\' OR q.email_to LIKE @like ESCAPE '\\' OR j.company LIKE @like ESCAPE '\\' OR j.title LIKE @like ESCAPE '\\')"
      : "(q.email_subject LIKE @like ESCAPE '\\' OR q.email_to LIKE @like ESCAPE '\\')");
    params.like = likePattern(opts.q);
  }
  if (opts.cursor != null) { where.push('q.id < @cursor'); params.cursor = opts.cursor; }
  const rows = db.prepare(`${emailSelect(db)} WHERE ${where.join(' AND ')} ORDER BY q.id DESC LIMIT @lim`).all(params) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(toEmail);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
}

export function emailDetail(db: Db, queueId: number): EmailDetail | null {
  if (!tableExists(db, 'outreach_queue')) return null;
  const r = db.prepare(`${emailSelect(db)} WHERE q.id = ? AND q.email_sent_at IS NOT NULL`).get(queueId) as Record<string, unknown> | undefined;
  if (!r) return null;
  const base = toEmail(r);
  const b = db.prepare('SELECT email_body AS body FROM outreach_queue WHERE id = ?').get(queueId) as { body: string | null };
  const body = b.body == null ? null : (cleanRow({ body: b.body }, { body: BODY_MAX }) as { body: string }).body;
  const followups = tableExists(db, 'followups')
    ? (db.prepare('SELECT id, job_id, n, status, subject, body, created_at, sent_at FROM followups WHERE job_id = ? ORDER BY n, id').all(base.job_id) as unknown as FollowupRow[])
      .map((f) => cleanRow(f as unknown as Record<string, unknown>, FOLLOWUP_LIMITS) as unknown as FollowupRow)
    : [];
  const replies = tableExists(db, 'processed_messages')
    ? (db.prepare(`SELECT message_id, job_id, classification, action, proposed_outcome, from_addr, subject, reply_date
        FROM processed_messages WHERE job_id = ? ORDER BY rowid DESC LIMIT 100`).all(base.job_id) as unknown as ReplyRow[])
      .map((m) => cleanRow(m as unknown as Record<string, unknown>, REPLY_LIMITS) as unknown as ReplyRow)
    : [];
  return { ...base, body, followups, replies };
}

export function listFollowups(db: Db, opts: { status?: string; cursor?: number | null; limit?: number }): Page<FollowupRow> {
  if (!tableExists(db, 'followups')) return { items: [], nextCursor: null };
  const limit = clampLimit(opts.limit);
  const where: string[] = [];
  const params: Record<string, unknown> = { lim: limit + 1 };
  if (opts.status) { where.push('status = @status'); params.status = opts.status; }
  if (opts.cursor != null) { where.push('id < @cursor'); params.cursor = opts.cursor; }
  const rows = db.prepare(`SELECT id, job_id, n, status, subject, body, created_at, sent_at FROM followups
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT @lim`).all(params) as unknown as FollowupRow[];
  const items = rows.slice(0, limit).map((f) => cleanRow(f as unknown as Record<string, unknown>, FOLLOWUP_LIMITS) as unknown as FollowupRow);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
}

export function listReplies(db: Db, opts: { cursor?: number | null; limit?: number }): Page<ReplyRow> {
  if (!tableExists(db, 'processed_messages')) return { items: [], nextCursor: null };
  const limit = clampLimit(opts.limit);
  const params: Record<string, unknown> = { lim: limit + 1 };
  let cur = '';
  if (opts.cursor != null) { cur = 'WHERE rowid < @cursor'; params.cursor = opts.cursor; }
  const rows = db.prepare(`SELECT rowid AS rid, message_id, job_id, classification, action, proposed_outcome, from_addr, subject, reply_date
    FROM processed_messages ${cur} ORDER BY rowid DESC LIMIT @lim`).all(params) as (ReplyRow & { rid: number })[];
  const page = rows.slice(0, limit);
  const items = page.map((m) => {
    const { rid: _rid, ...rest } = m;
    return cleanRow(rest as unknown as Record<string, unknown>, REPLY_LIMITS) as unknown as ReplyRow;
  });
  return { items, nextCursor: rows.length > limit ? page[page.length - 1].rid : null };
}
