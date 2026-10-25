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
import { NO_DIALOG_MAX_ATTEMPTS, noDialogAttempts, pauseContact } from '../linkedin/touches.js';
import { gateInput } from '../safety/inputGate.js';
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
    "SELECT 1 AS hit FROM touches WHERE person_id = ? AND status IN ('sending','unconfirmed') LIMIT 1",
  );
  const allRows = db
    .prepare(
      `SELECT p.id, p.profile_key, p.name, p.category, s.cycle_started_at
         FROM people p JOIN contact_state s ON s.person_id = p.id
        WHERE p.platform = ? AND p.company_key = ? AND s.stage = 'new' AND s.paused_reason IS NULL
        ORDER BY p.id`,
    )
    .all(platform, key) as { id: number; profile_key: string; name: string | null; category: Category; cycle_started_at: string | null }[];
  const rows = allRows.filter(
    (r) => blockedStmt.get(r.id) === undefined && noDialogAttempts(db, r.id, now) < NO_DIALOG_MAX_ATTEMPTS,
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
 * limit and pause only when the job names a company. Weekly ceilings, quiet hours, halts and dry run are enforced by
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
  e: { runId: string | null; platform: string; personId?: number; threadRef?: string; reason: string; detail?: string },
  now: Date,
): number {
  if (!ESC_PLATFORMS.includes(e.platform)) throw new Error('invalid platform');
  if (e.threadRef !== undefined && !THREAD_RE.test(e.threadRef)) throw new Error('invalid thread_ref');
  requirePerson(db, e.personId);
  let reason = gateText(e.reason ?? '', 200).text;
  let detail: string | null = null;
  if (e.detail !== undefined && e.detail !== null) {
    const d = gateText(e.detail, MAX_DETAIL_CHARS);
    detail = d.text;
    if (d.flags.length) reason = `${reason} [input flags: ${d.flags.join(',')}]`.slice(0, 300);
  }
  const res = db
    .prepare(
      `INSERT INTO escalations (run_id, platform, person_id, thread_ref, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(e.runId, e.platform, e.personId ?? null, e.threadRef ?? null, reason, detail, now.toISOString());
  return Number(res.lastInsertRowid);
}

export function listOpenEscalations(
  db: Db,
  limit: number,
): Array<{ id: number; platform: string; reason: string; detail: string | null; created_at: string }> {
  return db
    .prepare(
      `SELECT id, platform, reason, detail, created_at FROM escalations
        WHERE resolved_at IS NULL ORDER BY id ASC LIMIT ?`,
    )
    .all(clampLimit(limit)) as Array<{ id: number; platform: string; reason: string; detail: string | null; created_at: string }>;
}

/** Sets paused_reason 'replied' so no cadence continues. Company pause stays the stage-based rule. */
export function pausePersonOnReply(db: Db, personId: number, now: Date): void {
  pauseContact(db, personId, 'replied', now);
}
