// src/outreach/replyDrafts.ts
// LinkedIn replies for plain requests. The inbox tick records an inbound message and escalates it; for a plain request (a resume/CV, a
// simple question) it may also store ONE short draft answer here. A draft that passes every gate is stored as `approved` at once (owner
// decision 2026-11-02, see saveReplyDraft); the owner is told on Telegram before it goes out and can stop it with
// `npm run replies -- skip <id>` (scripts/replies.ts). The LinkedIn drip lane sends an approved draft as the kind `reply`
// (cadence-neutral, see src/linkedin/touches.ts), marks the draft sent and the escalation handled. Salary, interview time, personal data,
// references, link or phone asks are never drafted.
// Draft text is model text derived from a third-party message: it is gated here (style, fact, output gate) and again at arm time.
import type BetterSqlite3 from 'better-sqlite3';
import { resolveEscalations } from './escalations.js';
import { checkStyle, type StyleConfig } from '../safety/styleGate.js';
import { gateOutbound, secretValuesFromEnv } from '../safety/outputGate.js';
import { MAX_MESSAGE_CHARS, defaultFactCheck, type FactCheck } from '../linkedin/guard.js';
import { profileUrlFor } from './service.js';

type Db = BetterSqlite3.Database;

export type DraftStatus = 'drafted' | 'approved' | 'sent' | 'failed' | 'skipped';
export const DRAFT_STATUSES: readonly DraftStatus[] = ['drafted', 'approved', 'sent', 'failed', 'skipped'];

/** Escalation reasons a draft may be written for: a request for documents (resume/CV) or a plain reply the owner would otherwise write by hand. */
export const DRAFT_REASONS = ['documents', 'linkedin_reply_needed'] as const;
/** Closed ask kinds (src/outreach/escalations.ts deriveAskKind) that are never drafted: money and interview slots are the owner's. */
const OWNER_ONLY_ASKS = new Set(['salary', 'interview_slot']);

export interface ReplyDraft {
  id: number;
  escalation_id: number;
  person_id: number;
  thread_ref: string | null;
  kind: string;
  body: string;
  attach_resume: number;
  status: DraftStatus;
  created_at: string;
  approved_at: string | null;
  sent_at: string | null;
  touch_id: number | null;
}

export interface SaveDeps {
  now: Date;
  env: NodeJS.ProcessEnv;
  styleCfg: StyleConfig;
  cfg: { allowedUrls: string[]; allowedEmails: string[] };
  factCheck?: FactCheck;
}

export type SaveResult =
  | { ok: true; id: number; attach_resume: boolean }
  | { ok: false; code: string; reason: string };

const refuse = (code: string, reason: string): SaveResult => ({ ok: false, code, reason });

/**
 * Stores ONE `drafted` reply for an open LinkedIn escalation. Refused when: the escalation is not an open LinkedIn one with a known person,
 * its reason is not documents/linkedin_reply_needed (or it was held by the input screen), the ask is salary or an interview slot, a live draft
 * already exists, or the text fails the length, style, fact or output gate. `documents` sets attach_resume (the tailored resume is attached
 * by code when it is sent; the model never names a file).
 */
export function saveReplyDraft(db: Db, a: { escalationId: number; text: string }, d: SaveDeps): SaveResult {
  const esc = db.prepare(
    'SELECT id, platform, person_id, thread_ref, reason, ask_kind, resolved_at FROM escalations WHERE id = ?',
  ).get(a.escalationId) as
    | { id: number; platform: string | null; person_id: number | null; thread_ref: string | null; reason: string; ask_kind: string | null; resolved_at: string | null }
    | undefined;
  if (!esc) return refuse('unknown_escalation', 'no such escalation');
  if (esc.platform !== 'linkedin') return refuse('not_linkedin', 'only LinkedIn escalations get a drafted reply');
  if (esc.resolved_at) return refuse('already_resolved', 'the escalation is already handled');
  if (esc.person_id === null) return refuse('no_person', 'the escalation has no known person');
  if (/^\s*\[(blocked|unscreened)\b/i.test(esc.reason)) return refuse('flagged_text', 'text held by the input screen is never drafted for');
  const reason = esc.reason.toLowerCase();
  const wanted = DRAFT_REASONS.find((r) => reason.includes(r));
  if (!wanted) return refuse('reason_not_draftable', 'only documents and linkedin_reply_needed escalations get a draft');
  if (esc.ask_kind && OWNER_ONLY_ASKS.has(esc.ask_kind)) return refuse('owner_only', `a ${esc.ask_kind} ask is answered by the owner`);
  const person = db.prepare('SELECT id, platform, profile_key, name FROM people WHERE id = ?').get(esc.person_id) as
    | { id: number; platform: string; profile_key: string; name: string | null }
    | undefined;
  if (!person || person.platform !== 'linkedin') return refuse('no_person', 'the person is not a LinkedIn contact');

  const live = db.prepare("SELECT id FROM reply_drafts WHERE escalation_id = ? AND status IN ('drafted','approved','sent') LIMIT 1").get(esc.id);
  if (live) return refuse('draft_exists', 'this escalation already has a draft');

  const text = String(a.text ?? '').trim();
  if (!text) return refuse('empty_text', 'text is empty');
  if (text.length > MAX_MESSAGE_CHARS) return refuse('message_too_long', `text is over ${MAX_MESSAGE_CHARS} characters`);
  const style = checkStyle(text, 'reply', d.styleCfg);
  if (!style.ok) return refuse('style_gate', `style rules failed: ${[...new Set(style.hits.map((h) => h.rule))].join(', ')}`);
  let fact: { verdict: 'pass' | 'warn' | 'block'; normalized_text: string };
  try {
    fact = (d.factCheck ?? defaultFactCheck)(text, {});
  } catch {
    return refuse('fact_gate_error', 'fact gate could not run');
  }
  if (fact.verdict === 'block') return refuse('fact_gate_block', 'fact gate blocked the text');
  const body = fact.normalized_text;
  if (body.length > MAX_MESSAGE_CHARS) return refuse('message_too_long', `text is over ${MAX_MESSAGE_CHARS} characters`);
  const g = gateOutbound(body, {
    recipientKey: person.profile_key, expectedRecipientKey: person.profile_key,
    allowedUrls: d.cfg.allowedUrls, allowedEmails: d.cfg.allowedEmails,
    secretValues: secretValuesFromEnv(d.env), factVerdict: fact.verdict,
  });
  if (!g.ok) return refuse('output_gate_text', `output gate: ${g.reasons.join(', ')}`);

  const attach = wanted === 'documents' ? 1 : 0;
  // Owner decision (2026-11-02): a draft that passed every gate above needs no approval step. Salary, interview slot, personal data,
  // link or phone asks never get here (OWNER_ONLY_ASKS) and stay with the owner. `npm run replies -- skip <id>` still cancels a draft.
  const at = d.now.toISOString();
  const r = db.prepare(
    `INSERT INTO reply_drafts (escalation_id, person_id, thread_ref, kind, body, attach_resume, status, created_at, approved_at)
     VALUES (?, ?, ?, 'reply', ?, ?, 'approved', ?, ?)`,
  ).run(esc.id, person.id, esc.thread_ref, body, attach, at, at);
  return { ok: true, id: Number(r.lastInsertRowid), attach_resume: attach === 1 };
}

/** A newer inbound message arrived in the thread after the draft was written: the approved text no longer answers the latest message. */
export function draftIsStale(db: Db, d: Pick<ReplyDraft, 'thread_ref' | 'created_at'>): boolean {
  if (!d.thread_ref) return false;
  try {
    return db.prepare("SELECT 1 AS hit FROM inbound_messages WHERE platform = 'linkedin' AND thread_ref = ? AND klass <> 'noise' AND created_at > ? LIMIT 1").get(d.thread_ref, d.created_at) !== undefined;
  } catch {
    return false;
  }
}

export interface DraftView extends ReplyDraft {
  stale: boolean;
  person_name: string | null;
  company: string | null;
  profile_url: string | null;
  escalation_open: boolean;
}

function view(db: Db, rows: ReplyDraft[]): DraftView[] {
  const person = db.prepare('SELECT name, company, profile_key, platform FROM people WHERE id = ?');
  const esc = db.prepare('SELECT resolved_at FROM escalations WHERE id = ?');
  return rows.map((r) => {
    const p = person.get(r.person_id) as { name: string | null; company: string | null; profile_key: string; platform: string } | undefined;
    const e = esc.get(r.escalation_id) as { resolved_at: string | null } | undefined;
    return {
      ...r,
      person_name: p?.name ?? null, company: p?.company ?? null,
      profile_url: p ? profileUrlFor(p.platform, p.profile_key) : null,
      escalation_open: !!e && e.resolved_at === null,
      stale: draftIsStale(db, r),
    };
  });
}

export function listReplyDrafts(db: Db, statuses?: readonly DraftStatus[], limit = 200): DraftView[] {
  const st = statuses && statuses.length ? statuses : DRAFT_STATUSES;
  const rows = db
    .prepare(`SELECT * FROM reply_drafts WHERE status IN (${st.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`)
    .all(...st, limit) as ReplyDraft[];
  return view(db, rows);
}

export function getReplyDraft(db: Db, id: number): DraftView | null {
  const r = db.prepare('SELECT * FROM reply_drafts WHERE id = ?').get(id) as ReplyDraft | undefined;
  return r ? view(db, [r])[0] : null;
}

/** Owner approval. Only a drafted (or failed, to try again after the owner checked LinkedIn) draft can be approved. */
export function approveReplyDraft(db: Db, id: number, now: Date): { ok: boolean; reason?: string } {
  const cur = db.prepare('SELECT thread_ref, created_at FROM reply_drafts WHERE id = ?').get(id) as { thread_ref: string | null; created_at: string } | undefined;
  if (cur && draftIsStale(db, cur)) return { ok: false, reason: 'a newer message arrived in this thread; skip this draft (the next inbox read can draft a new one)' };
  const r = db.prepare("UPDATE reply_drafts SET status = 'approved', approved_at = ? WHERE id = ? AND status IN ('drafted','failed')").run(now.toISOString(), id);
  if (r.changes > 0) return { ok: true };
  const row = db.prepare('SELECT status FROM reply_drafts WHERE id = ?').get(id) as { status: string } | undefined;
  return { ok: false, reason: row ? `draft is ${row.status}` : 'no such draft' };
}

export function skipReplyDraft(db: Db, id: number): { ok: boolean; reason?: string } {
  const r = db.prepare("UPDATE reply_drafts SET status = 'skipped' WHERE id = ? AND status IN ('drafted','approved','failed')").run(id);
  if (r.changes > 0) return { ok: true };
  const row = db.prepare('SELECT status FROM reply_drafts WHERE id = ?').get(id) as { status: string } | undefined;
  return { ok: false, reason: row ? `draft is ${row.status}` : 'no such draft' };
}

/** Approved drafts ready to send: their escalation is still open, oldest approval first. */
export function approvedReplyDrafts(db: Db): DraftView[] {
  const rows = db.prepare("SELECT * FROM reply_drafts WHERE status = 'approved' ORDER BY approved_at ASC, id ASC").all() as ReplyDraft[];
  return view(db, rows).filter((v) => v.escalation_open && v.profile_url !== null);
}

/** Arm time: remember which touch carries this draft, so the commit path can close the loop in code. */
export function bindDraftTouch(db: Db, draftId: number, touchId: number): void {
  db.prepare('UPDATE reply_drafts SET touch_id = ? WHERE id = ?').run(touchId, draftId);
}

/** Commit path, confirmed send: the draft is sent and its escalation handled, with a note. The person stays paused (no cadence restarts). */
export function markReplyDraftSent(db: Db, touchId: number, now: Date): boolean {
  const d = db.prepare("SELECT id, escalation_id FROM reply_drafts WHERE touch_id = ? AND status = 'approved'").get(touchId) as
    | { id: number; escalation_id: number }
    | undefined;
  if (!d) return false;
  db.prepare("UPDATE reply_drafts SET status = 'sent', sent_at = ? WHERE id = ?").run(now.toISOString(), d.id);
  resolveEscalations(db, [d.escalation_id], now, `answered by the LinkedIn drip lane (reply draft #${d.id})`);
  return true;
}

/** Commit path, send failed or unconfirmed: the draft is `failed` and is not picked again until the owner approves it again. */
export function markReplyDraftFailed(db: Db, touchId: number): void {
  db.prepare("UPDATE reply_drafts SET status = 'failed' WHERE touch_id = ? AND status = 'approved'").run(touchId);
}

/** One line per draft for the /escalations screen and the CLI. Body is untrusted-derived text: callers clean it. */
export function countDraftsByStatus(db: Db): Record<DraftStatus, number> {
  const out = { drafted: 0, approved: 0, sent: 0, failed: 0, skipped: 0 } as Record<DraftStatus, number>;
  try {
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM reply_drafts GROUP BY status').all() as { status: DraftStatus; n: number }[]) {
      if (r.status in out) out[r.status] = r.n;
    }
  } catch {
    // table missing on an old database
  }
  return out;
}
