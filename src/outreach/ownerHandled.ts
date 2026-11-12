// src/outreach/ownerHandled.ts
// The OWNER may read and answer mail by hand in Gmail or on the phone. The reply check reads only `-in:sent` (our own sends must never look like
// replies), so it cannot see that. reply-watcher therefore also passes the Sent-mail messages it finds to `db.triage_replies` as `sent`, and this
// module decides which of them were written by the owner: a Sent message in a Gmail thread we know (our cold email, follow-up or automatic reply),
// that is not one of our own recorded sends and is dated AFTER our last send in that thread. Each one is stored in `owner_handled`.
// Effect (code, not model): the job gets no further automated email, follow-up, nudge or automatic reply (blockedJobIds, autoReplyBlock, nudgeEligible),
// its approved or drafted follow-ups are cancelled, and an approved automatic reply for the thread is cancelled.
// Known limit: an owner message sent from Gmail BEFORE our last send in the thread is not "after our last send" and is not detected.
import type BetterSqlite3 from 'better-sqlite3';
import { skipPendingFollowups } from '../db.js';

type Db = BetterSqlite3.Database;

export interface SentMessage {
  message_id: string;
  thread_id?: string | null;
  date?: string | null;
}

export interface OwnerSentResult { recorded: number; ours: number; unknown_thread: number; not_after_our_send: number }

const clamp = (v: unknown, n: number): string => String(v ?? '').slice(0, n);
const sqlTime = (s: string | null | undefined): number => (s ? Date.parse(`${s.replace(' ', 'T')}Z`) : NaN);

/** Message ids of everything WE sent: cold emails, follow-ups and automatic replies. */
export function ownSentMessageIds(db: Db): Set<string> {
  const ids = new Set<string>();
  const add = (sql: string): void => {
    try { for (const r of db.prepare(sql).all() as Array<{ id: string }>) ids.add(r.id); } catch { /* old database */ }
  };
  add("SELECT email_message_id AS id FROM outreach_queue WHERE email_message_id IS NOT NULL AND email_message_id <> ''");
  add("SELECT message_id AS id FROM followups WHERE message_id IS NOT NULL AND message_id <> ''");
  add("SELECT reply_message_id AS id FROM email_replies WHERE reply_message_id IS NOT NULL AND reply_message_id <> ''");
  return ids;
}

interface ThreadInfo { job_id: string | null; last_our_send: number }

/** Gmail threads we know (we sent into them), with the job and the time of our LAST send in each. */
function knownThreads(db: Db): Map<string, ThreadInfo> {
  const out = new Map<string, ThreadInfo>();
  const put = (thread: string | null, job: string | null, at: string | null): void => {
    if (!thread) return;
    const t = sqlTime(at);
    const cur = out.get(thread);
    if (!cur) { out.set(thread, { job_id: job, last_our_send: Number.isFinite(t) ? t : -Infinity }); return; }
    if (!cur.job_id && job) cur.job_id = job;
    if (Number.isFinite(t) && t > cur.last_our_send) cur.last_our_send = t;
  };
  try {
    for (const r of db.prepare("SELECT email_thread_id AS t, job_id AS j, email_sent_at AS a FROM outreach_queue WHERE email_thread_id IS NOT NULL AND email_status = 'sent'").all() as Array<{ t: string; j: string; a: string | null }>) put(r.t, r.j, r.a);
  } catch { /* old database */ }
  try {
    for (const r of db.prepare("SELECT thread_id AS t, job_id AS j, sent_at AS a FROM email_replies WHERE status = 'sent'").all() as Array<{ t: string; j: string | null; a: string | null }>) put(r.t, r.j, r.a);
  } catch { /* none */ }
  // Follow-ups have no thread column: they go out on the cold email's thread, so their send time moves that thread's last send forward.
  try {
    for (const r of db.prepare("SELECT job_id AS j, MAX(sent_at) AS a FROM followups WHERE status = 'sent' GROUP BY job_id").all() as Array<{ j: string; a: string | null }>) {
      for (const info of out.values()) if (info.job_id === r.j) { const t = sqlTime(r.a); if (Number.isFinite(t) && t > info.last_our_send) info.last_our_send = t; }
    }
  } catch { /* none */ }
  return out;
}

/**
 * Records the owner-written messages among the given Sent-mail messages. Idempotent (message_id UNIQUE). Never throws.
 * A message with no parseable date in a known thread is recorded (fails closed: no more automatic mail for that job).
 */
export function recordOwnerSent(db: Db, messages: readonly SentMessage[], opts: { dry_run?: boolean } = {}): OwnerSentResult {
  const res: OwnerSentResult = { recorded: 0, ours: 0, unknown_thread: 0, not_after_our_send: 0 };
  try {
    const ours = ownSentMessageIds(db);
    const threads = knownThreads(db);
    const ins = db.prepare('INSERT OR IGNORE INTO owner_handled (message_id, thread_id, job_id, sent_at) VALUES (?, ?, ?, ?)');
    const jobs = new Set<string>();
    const threadsHit = new Set<string>();
    const run = (): void => {
      for (const m of messages.slice(0, 500)) {
        const id = clamp(m?.message_id, 500);
        const thread = clamp(m?.thread_id, 200);
        if (!id) continue;
        if (ours.has(id)) { res.ours++; continue; }
        const info = thread ? threads.get(thread) : undefined;
        if (!info) { res.unknown_thread++; continue; }
        const at = Date.parse(String(m.date ?? ''));
        if (Number.isFinite(at) && at <= info.last_our_send) { res.not_after_our_send++; continue; }
        if (opts.dry_run === true) { res.recorded++; continue; }
        const sentAt = Number.isFinite(at) ? new Date(at).toISOString().slice(0, 19).replace('T', ' ') : null;
        if (ins.run(id, thread, info.job_id, sentAt).changes > 0) {
          res.recorded++;
          if (info.job_id) jobs.add(info.job_id);
          threadsHit.add(thread);
        }
      }
      for (const j of jobs) skipPendingFollowups(db, j);
      for (const t of threadsHit) {
        db.prepare("UPDATE email_replies SET status = 'cancelled', note = 'cancelled: the owner answered this thread by hand' WHERE thread_id = ? AND status IN ('drafted', 'approved')").run(t);
      }
    };
    db.transaction(run)();
  } catch {
    // never breaks the reply check
  }
  return res;
}

/** Jobs the owner handled by hand. */
export function ownerHandledJobIds(db: Db): Set<string> {
  try {
    return new Set((db.prepare('SELECT DISTINCT job_id FROM owner_handled WHERE job_id IS NOT NULL').all() as Array<{ job_id: string }>).map((r) => r.job_id));
  } catch {
    return new Set();
  }
}

export function isOwnerHandledThread(db: Db, threadId: string | null | undefined): boolean {
  if (!threadId) return false;
  try {
    return db.prepare('SELECT 1 FROM owner_handled WHERE thread_id = ? LIMIT 1').get(threadId) !== undefined;
  } catch {
    return false;
  }
}

export function isOwnerHandledJob(db: Db, jobId: string | null | undefined): boolean {
  if (!jobId) return false;
  try {
    return db.prepare('SELECT 1 FROM owner_handled WHERE job_id = ? LIMIT 1').get(jobId) !== undefined;
  } catch {
    return false;
  }
}
