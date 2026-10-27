// src/outreach/service.ts
// Pure service layer for the `outreach` MCP: due touches, contact selection, inbound records and
// escalations. No network, no claude calls. The MCP file is a thin registration over this.
import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { Category, TouchKind } from './cadence.js';
import { dueTouchesFor, loadConnectedKeys } from './dueTouches.js';
import type { OutreachConfig } from './config.js';
import {
  activeByCategory,
  activeContactCount,
  companyPaused,
  normalizeCompany,
  normalizeProfileKey,
  selectContacts,
  type Candidate,
} from './people.js';
import type { Tuning } from './tuning.js';
import { NO_DIALOG_MAX_ATTEMPTS, markStaleSending, noDialogAttempts, pauseContact } from '../linkedin/touches.js';
import { employerGate } from '../linkedin/employer.js';
import { gateInput } from '../safety/inputGate.js';
import { cleanText } from '../dash/clean.js';
import { deriveAskKind, linkedinThreadUrl } from './escalations.js';
import type { Platform } from '../scheduler/control.js';

type Db = BetterSqlite3.Database;

export const MAX_LIMIT = 20;
export const MAX_DETAIL_CHARS = 200;

export const clampLimit = (n: number | undefined, fallback = MAX_LIMIT): number => {
  const v = Number.isFinite(n) ? Math.floor(n as number) : fallback;
  return Math.max(1, Math.min(MAX_LIMIT, v));
};

/** https://www.linkedin.com/<path> from a stored `linkedin.com/in/slug` key; null for anything else. */
export function profileUrlFor(platform: string, profileKey: string): string | null {
  if (platform !== 'linkedin') return null;
  const m = /^linkedin\.com\/(.+)$/.exec(normalizeProfileKey(profileKey));
  return m ? `https://www.linkedin.com/${m[1]}` : null;
}

export interface DueTouch {
  person_id: number;
  platform: string;
  name: string | null;
  company: string | null;
  company_key: string;
  category: Category;
  kind: TouchKind;
  due_at: string;
  job_id: string | null;
  profile_url: string | null;
  thread_ref: string | null;
}

export function listDueTouches(
  db: Db,
  now: Date,
  tuning: Pick<Tuning, 'cadenceGapsDays'>,
  opts: { platform?: Platform; limit: number },
): DueTouch[] {
  const due = dueTouchesFor(db, now, tuning, { platform: opts.platform, limit: clampLimit(opts.limit) });
  const personStmt = db.prepare('SELECT profile_key, name, company FROM people WHERE id = ?');
  const jobStmt = db.prepare(
    'SELECT job_id FROM touches WHERE person_id = ? AND job_id IS NOT NULL ORDER BY id DESC LIMIT 1',
  );
  return due.map((d) => {
    const p = personStmt.get(d.person_id) as { profile_key: string; name: string | null; company: string | null };
    const j = jobStmt.get(d.person_id) as { job_id: string } | undefined;
    return {
      person_id: d.person_id,
      platform: d.platform,
      name: p.name,
      company: p.company,
      company_key: d.company_key,
      category: d.category,
      kind: d.kind,
      due_at: d.due_at,
      job_id: j?.job_id ?? null,
      profile_url: profileUrlFor(d.platform, p.profile_key),
      thread_ref: null, // touches has no thread column yet
    };
  });
}

export interface ContactCandidate extends Candidate {
  name: string | null;
  profile_url: string | null;
}

/** New (not yet contacted) people at a company, picked by selectContacts within the company limit. */
export function nextContactsForCompany(
  db: Db,
  cfg: Pick<OutreachConfig, 'companyContactLimit'>,
  platform: Platform,
  companyKey: string,
  now: Date = new Date(),
): ContactCandidate[] {
  const key = normalizeCompany(companyKey);
  if (companyPaused(db, platform, key)) return [];
  // Never hand the operator someone arm will refuse: an unresolved touch (sending, unconfirmed) blocks the
  // person, and so does a spent no_dialog retry limit. The next eligible people are returned instead.
  const blockedStmt = db.prepare(
    "SELECT 1 AS hit FROM touches WHERE person_id = ? AND (status IN ('sending','unconfirmed') OR (status = 'sent' AND kind = 'connect')) LIMIT 1",
  );
  const allRows = db
    .prepare(
      `SELECT p.id, p.profile_key, p.name, p.category, s.cycle_started_at, p.headline, p.company, p.employer_match
         FROM people p JOIN contact_state s ON s.person_id = p.id
        WHERE p.platform = ? AND p.company_key = ? AND s.stage = 'new' AND s.paused_reason IS NULL
        ORDER BY p.id`,
    )
    .all(platform, key) as { id: number; profile_key: string; name: string | null; category: Category; cycle_started_at: string | null; headline: string | null; company: string | null; employer_match: number | null }[];
  // A LinkedIn person whose employer does not show as the company is refused by arm every time: never offer them.
  const rows = allRows.filter(
    (r) =>
      blockedStmt.get(r.id) === undefined &&
      noDialogAttempts(db, r.id, now) < NO_DIALOG_MAX_ATTEMPTS &&
      (platform !== 'linkedin' || employerGate(r).ok),
  );
  const connectedKeys = loadConnectedKeys(db);
  const msgStmt = db.prepare(
    "SELECT 1 AS hit FROM touches WHERE person_id = ? AND status = 'sent' AND kind != 'connect' LIMIT 1",
  );
  const meta = new Map<number, { name: string | null; profile_url: string | null }>();
  const candidates: Candidate[] = rows.map((r) => {
    meta.set(r.id, { name: r.name, profile_url: profileUrlFor(platform, r.profile_key) });
    return {
      personId: r.id,
      category: r.category,
      connected: msgStmt.get(r.id) !== undefined || connectedKeys.has(normalizeProfileKey(r.profile_key)),
    };
  });
  const picked = selectContacts(
    candidates,
    activeByCategory(db, platform, key),
    cfg.companyContactLimit,
    activeContactCount(db, platform, key, false),
  );
  return picked.map((c) => ({ ...c, ...meta.get(c.personId)! }));
}

/** A company with this many failed people (no_dialog, failed, refused, unconfirmed, sending, employer mismatch) in the window is skipped. */
export const MAX_COMPANY_FAILURES = 3;
export const COMPANY_FAILURE_WINDOW_MS = 14 * 24 * 3600 * 1000;
const PERSON_FAIL_PAUSES = ['employer_mismatch', 'follow_only', 'profile_mismatch'];

/** Distinct people of the company whose connect failed or was left unresolved, or who were paused as a mismatch, in the window. */
export function companyFailureCount(db: Db, platform: string, companyKey: string, now: Date): number {
  const since = new Date(now.getTime() - COMPANY_FAILURE_WINDOW_MS).toISOString();
  const a = db
    .prepare(
      `SELECT COUNT(DISTINCT t.person_id) AS n FROM touches t JOIN people p ON p.id = t.person_id
        WHERE p.platform = ? AND p.company_key = ? AND t.kind = 'connect'
          AND t.status IN ('no_dialog','failed','refused','unconfirmed','sending') AND t.created_at >= ?`,
    )
    .get(platform, companyKey, since) as { n: number };
  const b = db
    .prepare(
      `SELECT COUNT(*) AS n FROM people p JOIN contact_state s ON s.person_id = p.id
        WHERE p.platform = ? AND p.company_key = ? AND s.paused_reason IN (${PERSON_FAIL_PAUSES.map(() => '?').join(',')})
          AND s.updated_at >= ?`,
    )
    .get(platform, companyKey, ...PERSON_FAIL_PAUSES, since) as { n: number };
  return a.n + b.n;
}

export interface QueueContact extends ContactCandidate {
  queue_id: number;
  job_id: string;
  job_title: string | null;
  company: string;
  company_key: string;
  priority: boolean;
  failures: number;
}

/**
 * The LinkedIn new-outreach walk: ONE person per DIFFERENT company of the connect queue, so a quota of k reaches up to k
 * companies instead of retrying the same one. Queue rows of live jobs (not excluded, not skipped) with a connect profile,
 * priority jobs first, then companies with the fewest recent failures, then the oldest queue row (score breaks ties).
 * A company with MAX_COMPANY_FAILURES failed people, a paused company, `excludeCompanyKeys` (tried this wake) or no
 * eligible person is skipped. The person is the row's own profile when eligible, else the company's first eligible
 * person (nextContactsForCompany: per-company limit, no blocked, employer-checked people).
 */
export function nextQueueContacts(
  db: Db,
  cfg: Pick<OutreachConfig, 'companyContactLimit'>,
  platform: Platform,
  opts: { limit?: number; excludeCompanyKeys?: string[]; now?: Date } = {},
): QueueContact[] {
  if (platform !== 'linkedin') return [];
  const now = opts.now ?? new Date();
  markStaleSending(db, now);
  const exclude = new Set((opts.excludeCompanyKeys ?? []).map((k) => normalizeCompany(k)));
  const rows = db
    .prepare(
      `SELECT q.id AS queue_id, q.job_id, q.connect_profile_url, q.connect_company, q.created_at AS q_created,
              j.title AS job_title, j.company AS job_company, COALESCE(j.priority, 0) AS priority, COALESCE(j.score, 0) AS score
         FROM outreach_queue q JOIN jobs j ON j.id = q.job_id
        WHERE q.connect_profile_url IS NOT NULL AND q.connect_profile_url != ''
          AND COALESCE(q.status, 'queued') = 'queued' AND (q.connect_status IS NULL OR q.connect_status = '')
          AND j.excluded_reason IS NULL`,
    )
    .all() as { queue_id: number; job_id: string; connect_profile_url: string; connect_company: string | null; q_created: string | null; job_title: string | null; job_company: string | null; priority: number; score: number }[];
  type Entry = { row: (typeof rows)[number]; key: string; company: string; failures: number };
  const byCompany = new Map<string, Entry>();
  for (const r of rows) {
    const company = (r.job_company ?? '').trim() || (r.connect_company ?? '').trim();
    const key = normalizeCompany(company);
    if (!key || exclude.has(key)) continue;
    const cur = byCompany.get(key);
    const better = !cur || r.priority > cur.row.priority || (r.priority === cur.row.priority && String(r.q_created) < String(cur.row.q_created));
    if (better) byCompany.set(key, { row: r, key, company, failures: 0 });
  }
  const entries = [...byCompany.values()];
  for (const e of entries) e.failures = companyFailureCount(db, platform, e.key, now);
  entries.sort(
    (a, b) =>
      b.row.priority - a.row.priority ||
      a.failures - b.failures ||
      String(a.row.q_created).localeCompare(String(b.row.q_created)) ||
      b.row.score - a.row.score ||
      a.row.queue_id - b.row.queue_id,
  );
  const limit = clampLimit(opts.limit);
  const out: QueueContact[] = [];
  for (const e of entries) {
    if (out.length >= limit) break;
    if (e.failures >= MAX_COMPANY_FAILURES) continue;
    const eligible = nextContactsForCompany(db, cfg, platform, e.key, now);
    if (eligible.length === 0) continue;
    const want = normalizeProfileKey(e.row.connect_profile_url);
    const pick = eligible.find((c) => c.profile_url && normalizeProfileKey(c.profile_url) === want) ?? eligible[0];
    out.push({
      ...pick, queue_id: e.row.queue_id, job_id: e.row.job_id, job_title: e.row.job_title, company: e.company,
      company_key: e.key, priority: e.row.priority > 0, failures: e.failures,
    });
  }
  return out;
}

export interface PosterContact extends ContactCandidate {
  job_id: string;
  job_title: string;
  /** The job's company when one is known, else null (never guessed). */
  company: string | null;
  post_url: string;
  /** Post text (untrusted data, already gated at save time), at most POST_TEXT_CHARS. */
  post_text: string;
  priority: boolean;
}

export const POST_TEXT_CHARS = 1500;
const DEFAULT_MIN_SCORE = 60;

/**
 * New (not yet contacted) authors of matched LinkedIn hiring posts. A post with no company has no company key, so the
 * company path never returns its author; this path is keyed by the person and the job instead. Every rule of the
 * company path still applies: only people in `people` in stage `new` and not paused, once per person (any sent,
 * sending or unconfirmed touch removes them, and the reserveTouch ledger refuses a repeat anyway), the per-company
 * limit and pause only when the job names a company. Daily ceilings, quiet hours, halts and dry run are enforced by
 * the arm tool, as for every other send. Priority jobs first, then oldest first.
 */
export function nextPosterContacts(
  db: Db,
  cfg: Pick<OutreachConfig, 'companyContactLimit'>,
  platform: Platform,
  opts: { jobId?: string; limit?: number; minScore?: number; now?: Date } = {},
): PosterContact[] {
  if (platform !== 'linkedin') return [];
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const jobs = db
    .prepare(
      `SELECT id, title, company, url, description, poster_url, COALESCE(priority, 0) AS priority
         FROM jobs
        WHERE source = 'linkedin-posts' AND poster_url IS NOT NULL AND poster_url != ''
          AND excluded_reason IS NULL AND score IS NOT NULL AND score >= ?
          AND (? IS NULL OR id = ?)
        ORDER BY COALESCE(priority, 0) DESC, rowid ASC`,
    )
    .all(minScore, opts.jobId ?? null, opts.jobId ?? null) as {
    id: string; title: string; company: string | null; url: string; description: string | null; poster_url: string; priority: number;
  }[];
  const personStmt = db.prepare(
    `SELECT p.id, p.profile_key, p.name, p.category, COALESCE(s.stage, 'new') AS stage, s.paused_reason AS paused_reason
       FROM people p LEFT JOIN contact_state s ON s.person_id = p.id WHERE p.platform = ? AND p.profile_key = ?`,
  );
  const touchedStmt = db.prepare("SELECT 1 AS hit FROM touches WHERE person_id = ? AND status IN ('sent','sending','unconfirmed') LIMIT 1");
  const connectedKeys = loadConnectedKeys(db);
  const msgStmt = db.prepare("SELECT 1 AS hit FROM touches WHERE person_id = ? AND status = 'sent' AND kind != 'connect' LIMIT 1");
  const seen = new Set<number>();
  const out: PosterContact[] = [];
  const limit = clampLimit(opts.limit);
  for (const j of jobs) {
    if (out.length >= limit) break;
    const key = normalizeProfileKey(j.poster_url);
    const p = personStmt.get(platform, key) as
      | { id: number; profile_key: string; name: string | null; category: Category; stage: string; paused_reason: string | null }
      | undefined;
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.stage !== 'new' || p.paused_reason !== null || touchedStmt.get(p.id) !== undefined) continue;
    if (noDialogAttempts(db, p.id, opts.now ?? new Date()) >= NO_DIALOG_MAX_ATTEMPTS) continue;
    const company = (j.company ?? '').trim();
    if (company) {
      const ck = normalizeCompany(company);
      if (ck && (companyPaused(db, platform, ck) || activeContactCount(db, platform, ck, false) >= cfg.companyContactLimit)) continue;
    }
    out.push({
      personId: p.id,
      category: p.category,
      connected: msgStmt.get(p.id) !== undefined || connectedKeys.has(normalizeProfileKey(p.profile_key)),
      name: p.name,
      profile_url: profileUrlFor(platform, p.profile_key),
      job_id: j.id,
      job_title: j.title,
      company: company || null,
      post_url: j.url,
      post_text: String(j.description ?? '').slice(0, POST_TEXT_CHARS),
      priority: j.priority > 0,
    });
  }
  return out;
}

export type InboundClass ='recruiter_inquiry' | 'reply' | 'rejection' | 'interview' | 'noise' | 'injection_suspect';

const THREAD_RE = /^[A-Za-z0-9_:./-]{1,120}$/;
const HASH_RE = /^[0-9a-f]{16,128}$/;
const ESC_PLATFORMS = ['linkedin', 'naukri', 'wellfound', 'scheduler', 'apply'];
const PAUSING: InboundClass[] = ['reply', 'interview', 'rejection'];

function requirePerson(db: Db, personId: number | undefined): void {
  if (personId === undefined || personId === null) return;
  if (db.prepare('SELECT 1 AS hit FROM people WHERE id = ?').get(personId) === undefined) {
    throw new Error(`unknown person_id ${personId}`);
  }
}

function gateText(raw: string, max: number): { text: string; flags: string[]; blocked: boolean } {
  const g = gateInput(String(raw).slice(0, max), { maxChars: max });
  if (g.blocked) return { text: `[blocked: ${g.flags.join(',')}]`.slice(0, max), flags: g.flags, blocked: true };
  return { text: g.text.slice(0, max), flags: g.flags, blocked: false };
}

// sha256 hex, first 32 chars. The message text is hashed here and never stored or logged.
export function hashInboundText(text: string): string {
  return createHash('sha256').update(String(text).slice(0, 1000), 'utf8').digest('hex').slice(0, 32);
}

export function recordInbound(
  db: Db,
  i: { platform: Platform; threadRef: string; personId?: number; textHash: string; klass: InboundClass; escalated: boolean },
  now: Date,
): { id: number; duplicate: boolean } {
  if (!THREAD_RE.test(String(i.threadRef))) throw new Error('invalid thread_ref');
  if (!HASH_RE.test(String(i.textHash))) throw new Error('invalid text_hash');
  requirePerson(db, i.personId);
  const tx = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO inbound_messages (platform, thread_ref, person_id, text_hash, klass, escalated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(i.platform, i.threadRef, i.personId ?? null, i.textHash, i.klass, i.escalated ? 1 : 0, now.toISOString());
    if (res.changes > 0) {
      if (i.personId !== undefined && PAUSING.includes(i.klass)) pausePersonOnReply(db, i.personId, now);
      return { id: Number(res.lastInsertRowid), duplicate: false };
    }
    const row = db
      .prepare('SELECT id FROM inbound_messages WHERE platform = ? AND thread_ref = ? AND text_hash = ?')
      .get(i.platform, i.threadRef, i.textHash) as { id: number };
    return { id: row.id, duplicate: true };
  });
  return tx();
}

export function addEscalation(
  db: Db,
  e: {
    runId: string | null; platform: string; personId?: number; threadRef?: string; reason: string; detail?: string;
    /** Sender as shown in the thread header, their headline, the latest inbound message text and its time (all untrusted). */
    sender?: string; senderHeadline?: string; excerpt?: string; messageAt?: string;
    /** Set by the caller when the input screen blocked the text: the row then carries a code-built safe summary and the raw text goes only to raw_text. */
    blockedCode?: string; rawText?: string;
  },
  now: Date,
): number {
  if (!ESC_PLATFORMS.includes(e.platform)) throw new Error('invalid platform');
  if (e.threadRef !== undefined && !THREAD_RE.test(e.threadRef)) throw new Error('invalid thread_ref');
  requirePerson(db, e.personId);
  // The operator found the person is not who or where the record says (live page employer, wrong profile, follow-only):
  // pause them so next_contacts never offers them again.
  if (e.personId !== undefined) {
    const r = String(e.reason ?? '').toLowerCase();
    const pause = /follow[_ ]only/.test(r) ? 'follow_only' : /employer|mismatch/.test(r) ? 'employer_mismatch' : null;
    if (pause) pauseContact(db, e.personId, pause, now);
  }
  const person = e.personId === undefined
    ? undefined
    : (db.prepare('SELECT name, headline, company FROM people WHERE id = ?').get(e.personId) as { name: string | null; headline: string | null; company: string | null } | undefined);
  const klass = e.threadRef === undefined
    ? null
    : ((db.prepare('SELECT klass FROM inbound_messages WHERE platform = ? AND thread_ref = ? ORDER BY id DESC LIMIT 1').get(e.platform, e.threadRef) as { klass: string } | undefined)?.klass ?? null);
  const threadUrl = linkedinThreadUrl(e.platform, e.threadRef ?? null);
  let reason: string;
  let detail: string | null = null;
  let excerpt: string | null = null;
  let rawText: string | null = null;
  let sender: string | null = null;
  let headline: string | null = null;
  let askKind = deriveAskKind({ klass, reason: e.reason ?? '', detail: e.detail, excerpt: e.excerpt ?? e.rawText });
  if (e.blockedCode !== undefined) {
    // The screen blocked third-party text. Everything shown is built here from closed values and the people table; the blocked text is kept
    // only in raw_text (owner dashboard, collapsed). The `[blocked: <code>]` prefix stays, so the row is still flagged and never dropped.
    const closed = /^[a-z][a-z0-9_:.-]{2,59}$/i.test(String(e.reason ?? '')) ? String(e.reason).toLowerCase() : askKind === 'other' ? 'flagged_text' : askKind;
    reason = `[blocked: ${e.blockedCode}] ${closed}`.slice(0, 200);
    const who = person?.name ? ` from ${cleanText(person.name, 80)}${person.company ? ` (${cleanText(person.company, 60)})` : ''}` : '';
    detail = `Text on ${e.platform}${who} was held by the input screen (${e.blockedCode}); ask: ${askKind}.${threadUrl ? ` Thread: ${threadUrl}` : ''}`.slice(0, 500);
    rawText = cleanText(String(e.rawText ?? ''), 1500) || null;
  } else {
    reason = gateText(e.reason ?? '', 200).text;
    if (e.detail !== undefined && e.detail !== null) {
      const d = gateText(e.detail, MAX_DETAIL_CHARS);
      detail = d.text;
      if (d.flags.length) reason = `${reason} [input flags: ${d.flags.join(',')}]`.slice(0, 300);
    }
    if (e.excerpt) excerpt = gateText(cleanText(e.excerpt, 1500), 1500).text;
  }
  if (e.blockedCode === undefined) {
    sender = e.sender ? cleanText(e.sender, 120) : null;
    headline = e.senderHeadline ? cleanText(e.senderHeadline, 200) : null;
  }
  sender ||= person?.name ? cleanText(person.name, 120) : null;
  headline ||= person?.headline ? cleanText(person.headline, 200) : person?.company ? cleanText(person.company, 120) : null;
  if (e.blockedCode === undefined) askKind = deriveAskKind({ klass, reason, detail, excerpt });
  const parsedAt = e.messageAt ? Date.parse(e.messageAt) : NaN;
  const messageAt = Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : null;
  const at = now.toISOString();

  // One OPEN escalation per conversation: a repeat for the same thread updates that row instead of adding a duplicate.
  const open = e.threadRef === undefined
    ? undefined
    : (db.prepare('SELECT id, message_excerpt FROM escalations WHERE platform = ? AND thread_ref = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1').get(e.platform, e.threadRef) as { id: number; message_excerpt: string | null } | undefined);
  if (open) {
    // A genuinely new message brings a snoozed conversation back; the same message reported again does not.
    const fresh = excerpt !== null && excerpt !== open.message_excerpt;
    db.prepare(
      `UPDATE escalations SET reason = ?, detail = COALESCE(?, detail), message_excerpt = COALESCE(?, message_excerpt), message_at = COALESCE(?, message_at),
         sender_name = COALESCE(?, sender_name), sender_headline = COALESCE(?, sender_headline), ask_kind = ?, thread_url = COALESCE(?, thread_url),
         raw_text = COALESCE(?, raw_text), seen_count = COALESCE(seen_count, 1) + 1, updated_at = ?,
         snoozed_until = CASE WHEN ? THEN NULL ELSE snoozed_until END WHERE id = ?`,
    ).run(reason, detail, excerpt, messageAt, sender, headline, askKind, threadUrl, rawText, at, fresh ? 1 : 0, open.id);
    return open.id;
  }
  const res = db
    .prepare(
      `INSERT INTO escalations (run_id, platform, person_id, thread_ref, reason, detail, created_at, sender_name, sender_headline, message_excerpt, message_at, ask_kind, thread_url, seen_count, updated_at, raw_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(e.runId, e.platform, e.personId ?? null, e.threadRef ?? null, reason, detail, at, sender, headline, excerpt, messageAt, askKind, threadUrl, at, rawText);
  return Number(res.lastInsertRowid);
}

export function listOpenEscalations(
  db: Db,
  limit: number,
): Array<{ id: number; platform: string; thread_ref: string | null; reason: string; detail: string | null; created_at: string; seen_count: number }> {
  // The columns are listed one by one on purpose: raw_text (blocked third-party text) and the message excerpt are never returned to an agent.
  return db
    .prepare(
      `SELECT id, platform, thread_ref, reason, detail, created_at, COALESCE(seen_count, 1) AS seen_count FROM escalations
        WHERE resolved_at IS NULL ORDER BY id ASC LIMIT ?`,
    )
    .all(clampLimit(limit)) as Array<{ id: number; platform: string; thread_ref: string | null; reason: string; detail: string | null; created_at: string; seen_count: number }>;
}

/** Sets paused_reason 'replied' so no cadence continues. Company pause stays the stage-based rule. */
export function pausePersonOnReply(db: Db, personId: number, now: Date): void {
  pauseContact(db, personId, 'replied', now);
}
