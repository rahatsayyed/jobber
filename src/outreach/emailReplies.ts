// src/outreach/emailReplies.ts
// Automatic answers to simple EMAIL replies (owner decision 2026-11-06). The classifier (emailReplyClass.ts) decides, templates built ONLY from
// user-data/reply-facts.json write the text, the style, fact and output gates check it, and the row is stored in `email_replies` with the
// inbound message id UNIQUE (one inbound message, at most one reply). The mail drip lane sends it (mail-operator REPLY MODE) after the guarded
// claim below. Nothing here sends mail. Everything is off unless EMAIL_AUTO_REPLY=true AND reply-facts.json is confirmed.
import type BetterSqlite3 from 'better-sqlite3';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { addrOf, isVerifiedAddress } from '../lib/verifiedAddress.js';
import { hasFreshCleanReplyCheck } from '../followups.js';
import { getBaseResume } from '../resume.js';
import { checkTextWithNormalized } from '../resumeFacts.js';
import { gateOutbound, secretValuesFromEnv } from '../safety/outputGate.js';
import { checkStyle, type StyleConfig } from '../safety/styleGate.js';
import { clean } from '../platform/tgHtml.js';
import { FACT_FIELD, KIND_LABEL, OWNER_REASON_TEXT, SAFE_KINDS, type EmailReplyClass, type SafeKind } from './emailReplyClass.js';
import { emailAutoReplyOn } from './emailReplyFlags.js';
import { replyFactsProblem, replyGateConfig, type FactField, type ReplyFacts, type ReplyFactsState } from './replyFacts.js';
import type { EmailReplyStatus } from './emailRepliesSchema.js';

type Db = BetterSqlite3.Database;

/** At most this many auto replies per Gmail thread, ever (a loop guard: two mail robots can never talk forever). */
export const MAX_AUTO_REPLIES_PER_THREAD = 3;
/** Job outcomes after which the agent no longer answers by itself. */
const QUIET_OUTCOMES = new Set(['replied', 'no_response']);

export interface AutoClass extends EmailReplyClass {
  /** Matched to a job by thread or exact sender with high confidence, from a human sender. */
  eligible: boolean;
}

export function parseAutoClass(raw: string | null | undefined): AutoClass | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AutoClass>;
    if (!v || (v.verdict !== 'safe' && v.verdict !== 'record_only' && v.verdict !== 'owner')) return null;
    return {
      verdict: v.verdict,
      kinds: Array.isArray(v.kinds) ? v.kinds.filter((k): k is SafeKind => (SAFE_KINDS as readonly string[]).includes(k as string)) : [],
      record: Array.isArray(v.record) ? v.record : [],
      owner: Array.isArray(v.owner) ? v.owner : [],
      eligible: v.eligible === true,
    };
  } catch {
    return null;
  }
}

export const kindsLabel = (kinds: readonly SafeKind[]): string => kinds.map((k) => KIND_LABEL[k]).join(', ');

// ---------------------------------------------------------------- templates (facts only, no model text)

const LINE: Record<SafeKind, (v: string) => string> = {
  ctc_current: (v) => `My current CTC is ${v}.`,
  ctc_expected: (v) => `My expected CTC is ${v}.`,
  notice_period: (v) => `My notice period is ${v}.`,
  availability: (v) => `I am available to join ${v}.`,
  location: (v) => `I am currently based in ${v}.`,
  relocation: (v) => `On relocation: ${v}.`,
  work_authorization: (v) => `On work authorization: ${v}.`,
};

const trimDot = (v: string): string => v.replace(/[.\s]+$/g, '');

/** The reply text for these asks, or the fact fields that are empty. Short, polite, first person; Hinglish asks are answered in English. */
export function buildReplyText(kinds: readonly SafeKind[], facts: ReplyFacts, ownerName: string | null): { ok: true; text: string } | { ok: false; missing: FactField[] } {
  const missing: FactField[] = [];
  const lines: string[] = [];
  for (const k of SAFE_KINDS) {
    if (!kinds.includes(k)) continue;
    const field = FACT_FIELD[k] as FactField;
    const v = facts[field];
    if (!v) { missing.push(field); continue; }
    lines.push(LINE[k](trimDot(v)));
  }
  if (missing.length > 0 || lines.length === 0) return { ok: false, missing };
  const name = ownerName ? clean(ownerName, 60) : '';
  return { ok: true, text: `Hi,\n\nThanks for your message.\n${lines.join('\n')}\n\nRegards${name ? `,\n${name}` : ''}` };
}

export function replySubject(subject: string | null | undefined): string {
  const base = String(subject ?? '').replace(/[\r\n\0\t]+/g, ' ').trim().replace(/^(?:(?:re|fwd?)\s*:\s*)+/i, '').slice(0, 150).trim();
  return `Re: ${base || 'your message'}`;
}

// ---------------------------------------------------------------- eligibility (DB state, checked at draft time AND at claim time)

interface PmRow {
  rowid: number; message_id: string; job_id: string | null; thread_id: string | null; from_addr: string | null; subject: string | null;
  classification: string | null; action: string | null; auto_class: string | null; needs_you: number; processed_at: string;
}

const PM_COLS = 'rowid, message_id, job_id, thread_id, from_addr, subject, classification, action, auto_class, needs_you, processed_at';

/** Why this inbound message may not be answered by the agent right now, or null. Reads state only. */
export function autoReplyBlock(db: Db, pm: Pick<PmRow, 'rowid' | 'message_id' | 'job_id' | 'thread_id' | 'from_addr'>, opts: { atClaim?: boolean } = {}): string | null {
  if (!pm.job_id) return 'not matched to a job';
  if (!pm.thread_id) return 'no Gmail thread id';
  const addr = addrOf(pm.from_addr);
  if (!addr) return 'sender address is unclear';
  if (!isVerifiedAddress(db, addr)) return 'sender is not a verified contact';
  const out = db.prepare('SELECT outcome FROM job_outcomes WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(pm.job_id) as { outcome: string } | undefined;
  if (out && !QUIET_OUTCOMES.has(out.outcome)) return `job outcome is ${out.outcome}`;
  const bad = db.prepare("SELECT 1 FROM processed_messages WHERE lower(from_addr) = ? AND (classification IN ('rejected', 'bounce') OR action = 'bounced') LIMIT 1").get(addr);
  if (bad) return 'this sender rejected or bounced before';
  const esc = db.prepare('SELECT 1 FROM processed_messages WHERE thread_id = ? AND message_id <> ? AND needs_you = 1 LIMIT 1').get(pm.thread_id, pm.message_id);
  if (esc) return 'the thread is already with the owner';
  const sent = db.prepare("SELECT COUNT(*) AS n FROM email_replies WHERE thread_id = ? AND status IN ('sent', 'sending')").get(pm.thread_id) as { n: number };
  if (sent.n >= MAX_AUTO_REPLIES_PER_THREAD) return `already ${sent.n} automatic replies in this thread`;
  if (opts.atClaim) {
    const newer = db.prepare('SELECT 1 FROM processed_messages WHERE thread_id = ? AND message_id <> ? AND rowid > ? LIMIT 1').get(pm.thread_id, pm.message_id, pm.rowid);
    if (newer) return 'a newer message arrived in the thread';
  } else {
    const pending = db.prepare("SELECT 1 FROM email_replies WHERE thread_id = ? AND status IN ('drafted', 'approved', 'sending') LIMIT 1").get(pm.thread_id);
    if (pending) return 'a reply for this thread is already waiting';
  }
  return null;
}

// ---------------------------------------------------------------- draft with gates

export type FactCheckFn = (text: string) => { verdict: 'pass' | 'warn' | 'block'; normalized_text: string };

/** The real fact gate for a reply: the base resume and fact-gate.json plus the reply facts as allowed values (replies only). */
export function makeReplyFactCheck(facts: ReplyFacts, getBase: () => Record<string, any> = getBaseResume): FactCheckFn {
  return (text) => {
    const r = checkTextWithNormalized(text, getBase(), { config: replyGateConfig(facts) });
    return { verdict: r.verdict, normalized_text: r.normalized_text };
  };
}

export interface DraftDeps {
  now: Date;
  env: NodeJS.ProcessEnv;
  facts: ReplyFactsState;
  styleCfg: StyleConfig;
  factCheck?: FactCheckFn;
  ownerName?: string | null;
}

export type DraftResult = { ok: true; id: number; kinds: SafeKind[] } | { ok: false; code: string; reason: string };
const refuse = (code: string, reason: string): DraftResult => ({ ok: false, code, reason });

function ownerNameFromResume(): string | null {
  try {
    const n = (getBaseResume() as Record<string, unknown>).name;
    return typeof n === 'string' && n.trim() ? n.trim() : null;
  } catch {
    return null;
  }
}

/** Drafts ONE reply for one processed inbound message and stores it approved (the gates are the approval). Never sends. Never throws. */
export function draftEmailReply(db: Db, messageId: string, d: DraftDeps): DraftResult {
  try {
    if (!emailAutoReplyOn(d.env)) return refuse('flag_off', 'EMAIL_AUTO_REPLY is not true');
    const problem = replyFactsProblem(d.facts);
    if (problem || (d.facts.status !== 'ready')) return refuse('facts_not_ready', problem ?? 'reply facts are not ready');
    const pm = db.prepare(`SELECT ${PM_COLS} FROM processed_messages WHERE message_id = ?`).get(messageId) as PmRow | undefined;
    if (!pm) return refuse('unknown_message', 'no such processed message');
    const ac = parseAutoClass(pm.auto_class);
    if (!ac || ac.verdict !== 'safe' || !ac.eligible || ac.kinds.length === 0) return refuse('not_safe', 'the classifier did not mark this mail as safe to answer');
    const block = autoReplyBlock(db, pm);
    if (block) return refuse('blocked', block);
    const text = buildReplyText(ac.kinds, d.facts.facts, d.ownerName === undefined ? ownerNameFromResume() : d.ownerName);
    if (!text.ok) return refuse('fact_missing', `reply-facts.json has no value for: ${text.missing.join(', ') || 'any ask'}`);
    const style = checkStyle(text.text, 'reply', d.styleCfg);
    if (!style.ok) return refuse('style_gate', `style rules failed: ${[...new Set(style.hits.map((h) => h.rule))].join(', ')}`);
    const fact = (d.factCheck ?? makeReplyFactCheck(d.facts.facts))(text.text);
    if (fact.verdict === 'block') return refuse('fact_gate_block', 'fact gate blocked the text');
    const body = fact.normalized_text;
    const subject = replySubject(pm.subject);
    const addr = addrOf(pm.from_addr) as string;
    const g = gateOutbound(`${subject}\n${body}`, {
      recipientKey: addr, expectedRecipientKey: addr, allowedUrls: [], allowedEmails: [],
      secretValues: secretValuesFromEnv(d.env), factVerdict: fact.verdict,
    });
    if (!g.ok) return refuse('output_gate_text', `output gate: ${g.reasons.join(', ')}`);
    const at = d.now.toISOString().slice(0, 19).replace('T', ' ');
    try {
      const r = db.prepare(
        `INSERT INTO email_replies (message_id, thread_id, job_id, to_addr, subject, body, kind, status, created_at, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`,
      ).run(pm.message_id, pm.thread_id, pm.job_id, addr, subject, body, ac.kinds.join(','), at, at);
      // The ask is answered by us: it no longer "needs you" (the notice says it was answered automatically).
      db.prepare('UPDATE processed_messages SET needs_you = 0 WHERE message_id = ?').run(pm.message_id);
      return { ok: true, id: Number(r.lastInsertRowid), kinds: ac.kinds };
    } catch (e) {
      if (/UNIQUE/i.test(e instanceof Error ? e.message : '')) return refuse('already_replied', 'this message already has a reply row');
      throw e;
    }
  } catch (e) {
    return refuse('error', clean(e instanceof Error ? e.message : String(e), 120));
  }
}

// ---------------------------------------------------------------- after a reply check: classify-driven drafting and owner notes

export interface ProcessResult {
  /** The flag is on but the facts file is not usable: the caller tells the owner (throttled). */
  factsProblem: string | null;
  drafted: number;
  owner: number;
  record: number;
}

/**
 * Runs right after a reply check, BEFORE the owner notice. Looks only at rows not announced yet (so mail the owner already saw is never answered
 * later), and does nothing at all while EMAIL_AUTO_REPLY is not true. Sets `auto_note` (the sentence the notice shows) and `needs_you`.
 */
export function processAutoReplies(db: Db, d: DraftDeps): ProcessResult {
  const res: ProcessResult = { factsProblem: null, drafted: 0, owner: 0, record: 0 };
  if (!emailAutoReplyOn(d.env)) return res;
  res.factsProblem = replyFactsProblem(d.facts);
  const rows = db.prepare(`SELECT ${PM_COLS} FROM processed_messages WHERE notified_at IS NULL AND auto_class IS NOT NULL AND auto_note IS NULL ORDER BY processed_at, rowid LIMIT 60`).all() as PmRow[];
  const note = db.prepare('UPDATE processed_messages SET auto_note = ?, needs_you = ? WHERE message_id = ?');
  for (const pm of rows) {
    const ac = parseAutoClass(pm.auto_class);
    if (!ac) continue;
    const humanAsk = !!pm.job_id && ['replied', 'unknown', 'interview', 'offer'].includes(pm.classification ?? '');
    if (ac.verdict === 'record_only') {
      note.run('no answer needed (acknowledgement)', 0, pm.message_id);
      res.record++;
    } else if (ac.verdict === 'safe' && ac.eligible) {
      if (res.factsProblem) {
        note.run(`needs you: ${res.factsProblem}`, 1, pm.message_id);
        res.owner++;
        continue;
      }
      const r = draftEmailReply(db, pm.message_id, d);
      if (r.ok) {
        note.run(`answered automatically: ${kindsLabel(r.kinds)} (queued, the mail drip sends it)`, 0, pm.message_id);
        res.drafted++;
      } else {
        note.run(`needs you: no automatic reply (${r.reason})`, 1, pm.message_id);
        res.owner++;
      }
    } else if (ac.verdict === 'safe') {
      note.run('needs you: a plain ask, but this mail is not safely matched to one of our emails', 1, pm.message_id);
      res.owner++;
    } else {
      const why = ac.owner.map((k) => OWNER_REASON_TEXT[k]).join('; ') || 'not a plain ask';
      const rejection = ac.owner.includes('rejection') || ac.owner.includes('bounce');
      note.run(`${rejection ? 'recorded, not answered' : 'needs you'}: ${why}`, rejection ? pm.needs_you : humanAsk ? 1 : pm.needs_you, pm.message_id);
      if (!rejection && humanAsk) res.owner++;
    }
  }
  return res;
}

// ---------------------------------------------------------------- claim and marks

export type ReplyClaim =
  | { claimed: true; id: number; to: string; subject: string; body: string; thread_id: string }
  | { claimed: false; reason: 'not_approved' | 'flag_off' | 'blocked' | 'unverified_address' | 'no_clean_reply_check' | 'cap'; detail?: string };

/**
 * The sender's claim, called RIGHT BEFORE gmail.send_email: ONE immediate transaction. The row is `approved`; EMAIL_AUTO_REPLY is still true; the
 * inbound message is still safe to answer (job outcome, sender, thread not escalated, no newer inbound); the recipient is a verified contact; a
 * clean mailbox reply check no older than maxAgeMin exists; the shared daily `send_email` counter has room (consumed only here, on success).
 * Then approved -> sending. A blocked row is cancelled (it will not be tried again); a cap or missing check leaves it approved.
 */
export function claimEmailReplyForSend(db: Db, id: number, g: { now: Date; maxAgeMin: number; sendLimit: number; env: NodeJS.ProcessEnv }): ReplyClaim {
  return db.transaction((): ReplyClaim => {
    const row = db.prepare("SELECT id, message_id, thread_id, to_addr, subject, body FROM email_replies WHERE id = ? AND status = 'approved'").get(id) as
      | { id: number; message_id: string; thread_id: string; to_addr: string; subject: string; body: string } | undefined;
    if (!row) return { claimed: false, reason: 'not_approved' };
    if (!emailAutoReplyOn(g.env)) return { claimed: false, reason: 'flag_off' };
    const pm = db.prepare(`SELECT ${PM_COLS} FROM processed_messages WHERE message_id = ?`).get(row.message_id) as PmRow | undefined;
    const block = pm ? autoReplyBlock(db, pm, { atClaim: true }) : 'the inbound message is unknown';
    if (block) {
      db.prepare("UPDATE email_replies SET status = 'cancelled', note = ? WHERE id = ? AND status = 'approved'").run(clean(`cancelled at claim: ${block}`, 160), id);
      return { claimed: false, reason: 'blocked', detail: block };
    }
    if (!isVerifiedAddress(db, row.to_addr)) {
      db.prepare("UPDATE email_replies SET status = 'cancelled', note = 'cancelled at claim: recipient is not a verified contact' WHERE id = ? AND status = 'approved'").run(id);
      return { claimed: false, reason: 'unverified_address' };
    }
    if (!hasFreshCleanReplyCheck(db, g.now, g.maxAgeMin)) return { claimed: false, reason: 'no_clean_reply_check' };
    if (!checkAndIncrement(db, 'send_email', g.sendLimit)) return { claimed: false, reason: 'cap' };
    const ok = db.prepare("UPDATE email_replies SET status = 'sending' WHERE id = ? AND status = 'approved'").run(id).changes > 0;
    return ok ? { claimed: true, id: row.id, to: row.to_addr, subject: row.subject, body: row.body, thread_id: row.thread_id } : { claimed: false, reason: 'not_approved' };
  }).immediate();
}

/** After the email went out. Only an `approved` or `sending` row becomes sent. */
export function markEmailReplySent(db: Db, id: number, messageId: string | null): { ok: boolean } {
  const ok = db.prepare("UPDATE email_replies SET status = 'sent', sent_at = datetime('now'), reply_message_id = ? WHERE id = ? AND status IN ('approved', 'sending')").run(messageId, id).changes > 0;
  return { ok };
}

/** A policy or hook denial (nothing was sent). A send error that may have gone out leaves the row `sending` (stuck, never re-sent). */
export function markEmailReplyFailed(db: Db, id: number): { ok: boolean } {
  return { ok: db.prepare("UPDATE email_replies SET status = 'failed' WHERE id = ? AND status IN ('approved', 'sending')").run(id).changes > 0 };
}

// ---------------------------------------------------------------- picking, listing, owner commands

export interface PendingReply { id: number; job_id: string | null; thread_id: string; to_addr: string }

/** Approved replies, oldest first. Only `approved` is ever picked: `sending` (stuck) and every other status never is. */
export function listApprovedEmailReplies(db: Db): PendingReply[] {
  try {
    return db.prepare("SELECT id, job_id, thread_id, to_addr FROM email_replies WHERE status = 'approved' ORDER BY id").all() as PendingReply[];
  } catch {
    return [];
  }
}

export function listStuckEmailReplies(db: Db): Array<{ id: number; job_id: string | null; to_addr: string }> {
  try {
    return db.prepare("SELECT id, job_id, to_addr FROM email_replies WHERE status = 'sending' ORDER BY id").all() as Array<{ id: number; job_id: string | null; to_addr: string }>;
  } catch {
    return [];
  }
}

/** Auto replies sent today (UTC day, like the daily counters). */
export function emailRepliesSentToday(db: Db): number {
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM email_replies WHERE status = 'sent' AND date(sent_at) = date('now')").get() as { n: number }).n;
  } catch {
    return 0;
  }
}

export interface EmailReplyRow {
  id: number; message_id: string; thread_id: string; job_id: string | null; to_addr: string; subject: string; body: string; kind: string;
  status: EmailReplyStatus; reply_message_id: string | null; note: string | null; created_at: string; approved_at: string | null; sent_at: string | null;
}

export function listEmailReplies(db: Db, statuses?: readonly EmailReplyStatus[], limit = 100): EmailReplyRow[] {
  const st = statuses && statuses.length ? statuses : (['drafted', 'approved', 'sending', 'failed'] as const);
  return db.prepare(`SELECT * FROM email_replies WHERE status IN (${st.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`).all(...st, limit) as EmailReplyRow[];
}

export function getEmailReply(db: Db, id: number): EmailReplyRow | null {
  return (db.prepare('SELECT * FROM email_replies WHERE id = ?').get(id) as EmailReplyRow | undefined) ?? null;
}

/** Owner cancel: a drafted, approved or failed reply is never sent. A `sending` row needs `resolve` (the owner checks Gmail first). */
export function skipEmailReply(db: Db, id: number): { ok: boolean; reason?: string } {
  const r = db.prepare("UPDATE email_replies SET status = 'cancelled', note = 'cancelled by the owner' WHERE id = ? AND status IN ('drafted', 'approved', 'failed')").run(id);
  if (r.changes > 0) return { ok: true };
  const row = db.prepare('SELECT status FROM email_replies WHERE id = ?').get(id) as { status: string } | undefined;
  return { ok: false, reason: row ? `reply is ${row.status}${row.status === 'sending' ? ' (check Gmail Sent, then: resolve <id> sent|cancelled)' : ''}` : 'no such reply' };
}

/** Owner repair for a stuck `sending` row after checking Gmail Sent. Never sends. */
export function resolveStuckEmailReply(db: Db, id: number, as: 'sent' | 'cancelled'): { ok: boolean; reason?: string } {
  const r = as === 'sent'
    ? db.prepare("UPDATE email_replies SET status = 'sent', sent_at = datetime('now'), note = 'marked sent by the owner' WHERE id = ? AND status = 'sending'").run(id)
    : db.prepare("UPDATE email_replies SET status = 'cancelled', note = 'cancelled by the owner after a stuck send' WHERE id = ? AND status = 'sending'").run(id);
  return r.changes > 0 ? { ok: true } : { ok: false, reason: 'the reply is not in sending' };
}
