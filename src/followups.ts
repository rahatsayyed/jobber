// file: src/followups.ts
// Follow-up cadence and stale sweep, adapted from MadsLorentzen/ai-job-search .claude/commands/outcome.md (MIT, (c) 2026
// Mads Lorentzen): >= 10 quiet days, at most 2 follow-ups, draft-only until approved, 60-day stale -> no_response.
import type BetterSqlite3 from 'better-sqlite3';
import { recordOutcome } from './db.js';
import { checkAndIncrement } from './lib/rateLimit.js';
import { normalizeText } from './atsText.js';
import { getBaseResume } from './resume.js';
import { checkTextWithNormalized } from './resumeFacts.js';
import { buildReplyQueries, isAutomatedSender, REPLY_WINDOW_DAYS, STALE_DAYS } from './replies.js';
import type { SentEmail } from './db.js';
import { buildEmailParts, loadEmailLinks, stripMarkers } from './emailHtml.js';

const DAY = 86_400_000;
const parseSqlTime = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);
const daysBetween = (from: string, now: Date) => Math.floor((now.getTime() - parseSqlTime(from)) / DAY);
const sqlNow = (now: Date) => now.toISOString().slice(0, 19).replace('T', ' ');

export interface FollowupCandidate {
  job_id: string; company: string | null; title: string | null; email_to: string; subject: string | null; body: string | null;
  thread_id: string | null; message_id: string | null; sent_at: string; followups_sent: number; days_quiet: number; next_n: 1 | 2 | 3 | 4;
}

interface Row {
  job_id: string; company: string | null; title: string | null; email_to: string; subject: string | null; body: string | null;
  thread_id: string | null; message_id: string | null; sent_at: string; n_sent: number; last_fu: string | null; last_skip: string | null; pending: number;
}

function rows(db: BetterSqlite3.Database): Row[] {
  return db.prepare(`
    WITH sent AS (
      SELECT job_id, MIN(email_sent_at) AS sent_at, MAX(email_to) AS email_to, MAX(email_subject) AS subject, MAX(email_body) AS body,
             MAX(email_thread_id) AS thread_id, MAX(email_message_id) AS message_id
      FROM outreach_queue WHERE email_status = 'sent' AND email_sent_at IS NOT NULL GROUP BY job_id
    ), fu AS (
      SELECT job_id, SUM(status = 'sent') AS n_sent, MAX(CASE WHEN status = 'sent' THEN sent_at END) AS last_fu,
             MAX(CASE WHEN status = 'skipped' THEN decided_at END) AS last_skip, SUM(status IN ('drafted', 'approved', 'sending')) AS pending
      FROM followups GROUP BY job_id
    )
    SELECT s.job_id, j.company, j.title, s.email_to, s.subject, s.body, s.thread_id, s.message_id, s.sent_at,
           coalesce(fu.n_sent, 0) AS n_sent, fu.last_fu, fu.last_skip, coalesce(fu.pending, 0) AS pending
    FROM sent s LEFT JOIN jobs j ON j.id = s.job_id LEFT JOIN fu ON fu.job_id = s.job_id`).all() as Row[];
}

/** Latest contact: the cold email, a sent follow-up, or the moment the user skipped a draft (so a skip does not make the job a candidate again at once). */
const lastContact = (r: Row) => [r.sent_at, r.last_fu, r.last_skip].filter((x): x is string => !!x).sort().pop() as string;

/** Jobs that must never get a (further) follow-up or a stale no_response: any outcome; any processed reply that is not noise or an
 *  auto-acknowledgement (replied, rejected, offer, interview, bounce, even a still-pending or skipped proposal); ANY processed message matched
 *  to the job from a non-automated sender, whatever its class (C1); every candidate of an ambiguous reply or bounce (M5); and every other job
 *  sent to the same address as a job with an outcome, a human reply, or a bounce. `jobs.excluded_reason` and include overrides are
 *  deliberately ignored (Plan 2 AF1/W9): an emailed job keeps its follow-up and stale handling. */
/** Bare lowercase address: `Jane <hr@x.com>` gives `hr@x.com`; a string without angle brackets is used whole. */
export const bare = (s: string): string => { const m = /<([^<>]{1,320})>/.exec(s.slice(0, 1000)); return (m ? m[1] : s).trim().toLowerCase(); };

export function blockedJobIds(db: BetterSqlite3.Database): Set<string> {
  const blocked = new Set<string>();
  const addrs = new Set<string>();
  const all = <T,>(sql: string) => db.prepare(sql).all() as T[];
  for (const r of all<{ job_id: string }>('SELECT DISTINCT job_id FROM job_outcomes')) blocked.add(r.job_id);
  for (const r of all<{ job_id: string }>("SELECT DISTINCT job_id FROM processed_messages WHERE job_id IS NOT NULL AND (classification NOT IN ('noise', 'auto_ack') OR coalesce(action, '') != 'ignored')")) blocked.add(r.job_id);
  // C1: ANY processed message matched to a job from a non-automated sender blocks it, whatever its class or action (a real reply filed as
  // noise/auto-ack must never leave the job a follow-up candidate). Automated senders (no-reply, ATS, job boards, mailer-daemon) keep the rules above.
  for (const r of all<{ job_id: string; from_addr: string | null }>('SELECT job_id, from_addr FROM processed_messages WHERE job_id IS NOT NULL')) {
    if (!isAutomatedSender(r.from_addr)) blocked.add(r.job_id);
  }
  // M5: an ambiguous reply/bounce (no single job) blocks EVERY candidate job, unless it is ignored noise/auto-ack from an automated sender;
  // a bounce also blocks every job sent to a candidate's address.
  const bouncedCandidates = new Set<string>();
  for (const r of all<{ candidates: string; classification: string | null; action: string | null; from_addr: string | null }>('SELECT candidates, classification, action, from_addr FROM processed_messages WHERE candidates IS NOT NULL')) {
    let ids: unknown;
    try { ids = JSON.parse(r.candidates); } catch { ids = []; }
    if (!Array.isArray(ids)) continue;
    const quiet = ['noise', 'auto_ack'].includes(r.classification ?? '') && (r.action ?? '') === 'ignored' && isAutomatedSender(r.from_addr);
    if (quiet) continue;
    for (const id of ids) if (typeof id === 'string') { blocked.add(id); if (r.classification === 'bounce' || r.action === 'bounced') bouncedCandidates.add(id); }
  }
  for (const r of all<{ job_id: string; a: string }>("SELECT job_id, email_to AS a FROM outreach_queue WHERE email_to IS NOT NULL")) if (bouncedCandidates.has(r.job_id)) addrs.add(bare(r.a));
  // Z1: a no_response outcome blocks its own job (above) but does not propagate to siblings at the same address.
  for (const r of all<{ a: string }>("SELECT DISTINCT q.email_to AS a FROM outreach_queue q JOIN job_outcomes o ON o.job_id = q.job_id WHERE q.email_to IS NOT NULL AND o.outcome != 'no_response'")) addrs.add(bare(r.a));
  for (const r of all<{ a: string }>("SELECT DISTINCT from_addr AS a FROM processed_messages WHERE from_addr IS NOT NULL AND classification NOT IN ('noise', 'auto_ack', 'bounce') AND coalesce(action, '') != 'bounced'")) addrs.add(bare(r.a));
  for (const r of all<{ a: string }>("SELECT DISTINCT q.email_to AS a FROM processed_messages p JOIN outreach_queue q ON q.job_id = p.job_id WHERE (p.classification = 'bounce' OR p.action = 'bounced') AND q.email_to IS NOT NULL")) addrs.add(bare(r.a));
  for (const r of all<{ job_id: string; a: string }>("SELECT job_id, email_to AS a FROM outreach_queue WHERE email_to IS NOT NULL AND email_status = 'sent'")) if (addrs.has(bare(r.a))) blocked.add(r.job_id);
  return blocked;
}

// ---- Autonomous mode (flagged: FOLLOWUPS_AUTONOMOUS=true; the legacy 10-day / 2-follow-up flow is the library default) ----

export type FollowupMode = 'legacy' | 'autonomous';
export function followupMode(env: NodeJS.ProcessEnv = process.env): FollowupMode { return env.FOLLOWUPS_AUTONOMOUS === 'true' ? 'autonomous' : 'legacy'; }
export const AUTONOMOUS_MAX = 4;
/** The 4th message of the autonomous sequence is a feedback request, not a follow-up. */
export function followupKind(n: number): 'followup' | 'feedback' { return n >= 4 ? 'feedback' : 'followup'; }
export const EMAIL_FOLLOWUP_GAPS_DEFAULT: readonly number[] = [3, 4, 5, 7];
/** EMAIL_FOLLOWUP_GAPS_DAYS: exactly 4 integers in 1..365, else the default (independent of CADENCE_GAPS_DAYS). */
export function emailFollowupGaps(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.EMAIL_FOLLOWUP_GAPS_DAYS;
  if (raw === undefined || raw.trim() === '') return [...EMAIL_FOLLOWUP_GAPS_DEFAULT];
  const nums = raw.split(',').map((x) => (/^\d+$/.test(x.trim()) ? Number(x.trim()) : NaN));
  return nums.length === AUTONOMOUS_MAX && nums.every((n) => Number.isInteger(n) && n >= 1 && n <= 365) ? nums : [...EMAIL_FOLLOWUP_GAPS_DEFAULT];
}
/** FOLLOWUP_CHECK_MAX_AGE_MIN: default 30, clamped to 5..240 (non-numeric gives the default). */
export function followupCheckMaxAgeMin(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FOLLOWUP_CHECK_MAX_AGE_MIN;
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.min(240, Math.max(5, Math.floor(n)));
}

export interface ModeOpts { mode?: FollowupMode; gapsDays?: readonly number[] }

/** A job is either follow-up eligible (10 <= quiet days < staleDays) or stale (quiet >= staleDays), never both.
 *  Autonomous mode: eligible when quiet days >= gapsDays[n_sent] (and n_sent < 4). */
export function listFollowupCandidates(db: BetterSqlite3.Database, now: Date = new Date(), opts: { afterDays?: number; max?: number; staleDays?: number } & ModeOpts = {}): FollowupCandidate[] {
  const auto = opts.mode === 'autonomous';
  const gaps = opts.gapsDays ?? EMAIL_FOLLOWUP_GAPS_DEFAULT;
  const after = opts.afterDays ?? 10;
  const max = auto ? AUTONOMOUS_MAX : opts.max ?? 2;
  const stale = opts.staleDays ?? STALE_DAYS;
  const blocked = blockedJobIds(db);
  return rows(db)
    .filter((r) => {
      const q = daysBetween(lastContact(r), now);
      if (blocked.has(r.job_id) || !r.email_to || r.pending !== 0 || r.n_sent >= max || q >= stale) return false;
      return auto ? q >= (gaps[r.n_sent] ?? EMAIL_FOLLOWUP_GAPS_DEFAULT[r.n_sent]) : q >= after;
    })
    .map((r) => ({
      job_id: r.job_id, company: r.company, title: r.title, email_to: r.email_to, subject: r.subject, body: r.body,
      thread_id: r.thread_id, message_id: r.message_id, sent_at: r.sent_at, followups_sent: r.n_sent,
      days_quiet: daysBetween(lastContact(r), now), next_n: (r.n_sent + 1) as 1 | 2 | 3 | 4,
    }));
}

// ---- Draft validation: the fact gate and the hard style rules run HERE, in code, not only in the prompt ----

export interface GateResult { verdict: 'pass' | 'warn' | 'block'; invented: string[]; unsupported: string[]; forbidden: string[]; warnings: string[]; normalized_text: string }
export type FollowupGate = (text: string, ctx: { extraSource: string; jobTitle: string | null; company: string | null }) => GateResult;

/** The real gate: `checkTextWithNormalized` (the function behind resume.check_text) over the base resume, with the original email as an extra source. */
export const makeGate = (getBase: () => Record<string, any>): FollowupGate => (text, ctx) =>
  checkTextWithNormalized(text, getBase(), { extraSource: ctx.extraSource, jobTitle: ctx.jobTitle ?? undefined, company: ctx.company ?? undefined });
export const realGate: FollowupGate = makeGate(getBaseResume);

/** user-data/fact-gate.json only lists three of these; the follow-up rules ban all of them. */
export const BANNED_FOLLOWUP = /just checking in|checking in|follow(?:ing)?[- ]?up|touching base|circling back|bump(?:ing)? (?:this|my)|\bany updates?\b|gentle reminder|per my last email/i;
export const FOLLOWUP_WORDS = { min: 40, max: 120 };

export interface SavedDraft { id: number; subject: string; body: string; warnings: string[] }

/** Stores a follow-up draft (status drafted, nothing is sent). Throws, storing nothing, unless the job is a current candidate, n is its next_n,
 *  the fact gate does not block (original email as extra source, job title and company blanked), the subject is `Re: <original subject>`,
 *  the body is 40-120 words and no banned phrase appears. Stores the gate's NORMALIZED subject and body (the text that was gated is the text that is sent). */
export function saveFollowupDraft(db: BetterSqlite3.Database, d: { job_id: string; n: number; subject: string; body: string }, now: Date = new Date(), gate: FollowupGate = realGate, mo: ModeOpts = {}): SavedDraft {
  const c = listFollowupCandidates(db, now, mo).find((x) => x.job_id === d.job_id);
  if (!c) throw new Error(`job ${d.job_id} is not a follow-up candidate (outcome or reply recorded, too recent, pending draft, or the maximum already sent)`);
  if (d.n !== c.next_n) throw new Error(`expected follow-up #${c.next_n} for job ${d.job_id}, got #${d.n}`);
  if (/[\r\n]/.test(d.subject)) throw new Error('subject must be a single line');
  const g = gate(`${d.subject}\n\n${d.body}`, { extraSource: `${c.subject ?? ''}\n\n${c.body ?? ''}`, jobTitle: c.title, company: c.company });
  if (g.verdict === 'block') throw new Error(`fact gate blocked this draft: ${[...g.invented, ...g.unsupported, ...g.forbidden.map((p) => `forbidden:${p}`)].join(', ')}`);
  const cut = /\n[ \t]*\n/.exec(g.normalized_text);
  if (!cut) throw new Error('draft must be a subject line, a blank line, then the body');
  // The gate saw the text without **...** markers; the stored body is that plain text, the HTML part is built in code from the marked one.
  const subject = stripMarkers(g.normalized_text.slice(0, cut.index)).trim();
  const markedBody = g.normalized_text.slice(cut.index + cut[0].length).trim();
  const parts = buildEmailParts(markedBody, loadEmailLinks());
  const body = parts.plain.trim();
  const expected = normalizeText(`Re: ${c.subject ?? ''}`).trim();
  if (subject !== expected) throw new Error(`subject must be exactly "${expected}"`);
  const banned = BANNED_FOLLOWUP.exec(`${subject}\n${body}`);
  if (banned) throw new Error(`banned phrase "${banned[0]}"`);
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < FOLLOWUP_WORDS.min || words > FOLLOWUP_WORDS.max) throw new Error(`body must be ${FOLLOWUP_WORDS.min}-${FOLLOWUP_WORDS.max} words, got ${words}`);
  const id = Number(db.prepare("INSERT INTO followups (job_id, n, subject, body, body_html, status) VALUES (?, ?, ?, ?, ?, 'drafted')").run(d.job_id, d.n, subject, body, parts.html).lastInsertRowid);
  return { id, subject, body, warnings: g.warnings };
}

/** Approve or skip drafted rows. The decision time is stored: a skip counts as the last contact so the job is not re-drafted at once. */
export function setFollowupApproval(db: BetterSqlite3.Database, ids: number[], approve: boolean): number {
  const upd = db.prepare("UPDATE followups SET status = ?, decided_at = datetime('now') WHERE id = ? AND status = 'drafted'");
  const jobOf = db.prepare("SELECT job_id FROM followups WHERE id = ? AND status = 'drafted'");
  const blocked = blockedJobIds(db);
  let n = 0;
  db.transaction(() => {
    for (const id of ids) {
      const j = (jobOf.get(id) as { job_id: string } | undefined)?.job_id;
      // A draft whose job became blocked (outcome, reply, bounce) is never approved: it is skipped and not counted.
      if (j !== undefined && blocked.has(j)) { upd.run('skipped', id); continue; }
      n += upd.run(approve ? 'approved' : 'skipped', id).changes;
    }
  })();
  return n;
}

/** Approved, unsent follow-ups, minus any job that has since got an outcome or a reply (even a pending proposal) or whose address bounced. */
export function listApprovedFollowups(db: BetterSqlite3.Database): Array<{ id: number; job_id: string; n: number; subject: string; body: string; body_html: string; email_to: string; thread_id: string | null }> {
  const blocked = blockedJobIds(db);
  const all = db.prepare(`SELECT f.id, f.job_id, f.n, f.subject, f.body, f.body_html,
      (SELECT MAX(q.email_to) FROM outreach_queue q WHERE q.job_id = f.job_id AND q.email_status = 'sent') AS email_to,
      (SELECT MAX(q.email_thread_id) FROM outreach_queue q WHERE q.job_id = f.job_id AND q.email_status = 'sent') AS thread_id
    FROM followups f WHERE f.status = 'approved' ORDER BY f.id`).all() as any[];
  // A draft saved before the HTML part existed gets it built now (links, no emphasis).
  return all.filter((r) => r.email_to && !blocked.has(r.job_id)).map((r) => (r.body_html ? r : { ...r, body_html: buildEmailParts(r.body ?? '', loadEmailLinks()).html }));
}

/** Rows left in `sending` (claimed, but never marked sent or failed: the sender stopped mid-send). Never re-sent automatically: the user decides. */
export function listStuckSending(db: BetterSqlite3.Database): Array<{ id: number; job_id: string; n: number }> {
  return db.prepare("SELECT id, job_id, n FROM followups WHERE status = 'sending' ORDER BY id").all() as Array<{ id: number; job_id: string; n: number }>;
}

/** The sender's claim step, called right BEFORE gmail.send_email: approved -> sending, atomically. Returns false (send nothing) when the row is
 *  not approved (already claimed, sent, skipped, cancelled, failed, unknown), has no sent cold email to reply to, or its job is blocked now. */
export function claimFollowupForSend(db: BetterSqlite3.Database, id: number): boolean {
  return db.transaction(() => {
    const row = db.prepare("SELECT job_id FROM followups WHERE id = ? AND status = 'approved'").get(id) as { job_id: string } | undefined;
    if (!row) return false;
    if (!listApprovedFollowups(db).some((r) => r.id === id)) return false;
    return db.prepare("UPDATE followups SET status = 'sending' WHERE id = ? AND status = 'approved'").run(id).changes > 0;
  }).immediate();
}

/** Called AFTER the email went out, so it records the truth. Accepts only `approved` or `sending` rows (a skipped or cancelled row was never
 *  claimed, so it cannot become sent). A `sending` row is never cancelled by an outcome (skipPendingFollowups leaves it), so a send in flight is
 *  still recorded as sent; `late_block` tells the caller to warn the user ("sent, but a reply/outcome arrived meanwhile"). Pre-send protection
 *  lives in claimFollowupForSend, listApprovedFollowups and setFollowupApproval. */
export function markFollowupSent(db: BetterSqlite3.Database, id: number, messageId: string | null): { ok: boolean; late_block: boolean } {
  const row = db.prepare("SELECT job_id FROM followups WHERE id = ? AND status IN ('approved', 'sending') AND sent_at IS NULL").get(id) as { job_id: string } | undefined;
  if (!row) return { ok: false, late_block: false };
  const late_block = blockedJobIds(db).has(row.job_id);
  const ok = db.prepare("UPDATE followups SET status = 'sent', sent_at = datetime('now'), message_id = ? WHERE id = ? AND status IN ('approved', 'sending') AND sent_at IS NULL").run(messageId, id).changes > 0;
  return { ok, late_block: ok && late_block };
}

export function markFollowupFailed(db: BetterSqlite3.Database, id: number): boolean {
  return db.prepare("UPDATE followups SET status = 'failed' WHERE id = ? AND status IN ('approved', 'sending')").run(id).changes > 0;
}

/** Every sent job that is NOT blocked yet (recent, follow-up candidate, pending draft or stale), as SentEmail rows, so the reply search
 *  covers each one whatever the age of its cold email. */
export function listReplyWatchJobs(db: BetterSqlite3.Database): SentEmail[] {
  const blocked = blockedJobIds(db);
  return rows(db).filter((r) => !blocked.has(r.job_id)).map((r) => ({
    job_id: r.job_id, company: r.company, title: r.title, email_to: r.email_to, subject: r.subject, body: r.body, message_id: r.message_id, thread_id: r.thread_id, sent_at: r.sent_at,
  }));
}

/** The reply-search queries for list_sent_emails: every sent email in `sent` (the tool's since_days window) plus every unblocked sent job
 *  (follow-up candidate, pending draft or stale) whatever its age, chunked by buildReplyQueries, newer_than REPLY_WINDOW_DAYS. */
export function replyWatchQueries(db: BetterSqlite3.Database, sent: SentEmail[]): string[] {
  const seen = new Set(sent.map((s) => s.job_id));
  return buildReplyQueries([...sent, ...listReplyWatchJobs(db).filter((s) => !seen.has(s.job_id))], REPLY_WINDOW_DAYS);
}

export interface StaleCandidate { job_id: string; company: string | null; title: string | null; days_quiet: number; followups_sent: number; why: 'silent 60+ days' | 'no reply after 2 follow-ups' | 'no reply after 4 follow-ups' }

/** Sent jobs gone quiet. Jobs with an outcome, a reply (even an unresolved proposal) or a bounce are never listed: the user decides those. */
export function listStale(db: BetterSqlite3.Database, now: Date = new Date(), opts: { staleDays?: number; afterDays?: number; max?: number } & ModeOpts = {}): StaleCandidate[] {
  const auto = opts.mode === 'autonomous';
  const gaps = opts.gapsDays ?? EMAIL_FOLLOWUP_GAPS_DEFAULT;
  const stale = opts.staleDays ?? STALE_DAYS;
  const after = auto ? gaps[AUTONOMOUS_MAX - 1] ?? 7 : opts.afterDays ?? 10;
  const max = auto ? AUTONOMOUS_MAX : opts.max ?? 2;
  const blocked = blockedJobIds(db);
  const out: StaleCandidate[] = [];
  for (const r of rows(db)) {
    if (blocked.has(r.job_id)) continue;
    const q = daysBetween(lastContact(r), now);
    const why = q >= stale ? 'silent 60+ days' : r.n_sent >= max && q >= after ? (auto ? 'no reply after 4 follow-ups' : 'no reply after 2 follow-ups') : null;
    if (why) out.push({ job_id: r.job_id, company: r.company, title: r.title, days_quiet: q, followups_sent: r.n_sent, why });
  }
  return out;
}

export function resolveStale(db: BetterSqlite3.Database, jobIds: string[], now: Date = new Date(), mo: ModeOpts = {}): { recorded: string[]; skipped: string[] } {
  const eligible = new Set(listStale(db, now, mo).map((s) => s.job_id));
  const recorded: string[] = [];
  const skipped: string[] = [];
  db.transaction(() => {
    for (const id of jobIds) {
      if (!eligible.has(id)) { skipped.push(id); continue; }
      recordOutcome(db, id, 'no_response', `stale resolved no_response (${sqlNow(now).slice(0, 10)})`);
      recorded.push(id);
    }
  })();
  return { recorded, skipped };
}

// ---- reply_checks, guarded claim, auto-approve ----

/** Records one reply-watcher run. clean = no errors (a truncated or failed read is never clean). */
export function recordReplyCheck(db: BetterSqlite3.Database, c: { messages: number; errors: number }, now: Date): { id: number; clean: boolean } {
  const clean = c.errors === 0;
  const id = Number(db.prepare('INSERT INTO reply_checks (checked_at, clean, messages, errors) VALUES (?, ?, ?, ?)').run(sqlNow(now), clean ? 1 : 0, c.messages, c.errors).lastInsertRowid);
  return { id, clean };
}

/** True when the LATEST reply check is clean and no older than maxAgeMin (inclusive). */
export function hasFreshCleanReplyCheck(db: BetterSqlite3.Database, now: Date, maxAgeMin: number): boolean {
  const r = db.prepare('SELECT checked_at, clean FROM reply_checks ORDER BY checked_at DESC, id DESC LIMIT 1').get() as { checked_at: string; clean: number } | undefined;
  if (!r || r.clean !== 1) return false;
  const age = now.getTime() - parseSqlTime(r.checked_at);
  return age >= 0 && age <= maxAgeMin * 60_000;
}

export type ClaimResult = { claimed: true } | { claimed: false; reason: 'not_approved' | 'blocked' | 'no_clean_reply_check' | 'cap' };

/** Autonomous claim: ONE immediate transaction. approved (and not blocked), then a fresh clean reply check, then the shared send_email counter
 *  (consumed only here, on success), then approved -> sending. Any refusal writes nothing. */
export function claimFollowupGuarded(db: BetterSqlite3.Database, id: number, g: { now: Date; maxAgeMin: number; sendLimit: number }): ClaimResult {
  return db.transaction((): ClaimResult => {
    const row = db.prepare("SELECT job_id FROM followups WHERE id = ? AND status = 'approved'").get(id) as { job_id: string } | undefined;
    if (!row) return { claimed: false, reason: 'not_approved' };
    if (!listApprovedFollowups(db).some((r) => r.id === id)) return { claimed: false, reason: 'blocked' };
    if (!hasFreshCleanReplyCheck(db, g.now, g.maxAgeMin)) return { claimed: false, reason: 'no_clean_reply_check' };
    if (!checkAndIncrement(db, 'send_email', g.sendLimit)) return { claimed: false, reason: 'cap' };
    const ok = db.prepare("UPDATE followups SET status = 'sending' WHERE id = ? AND status = 'approved'").run(id).changes > 0;
    return ok ? { claimed: true } : { claimed: false, reason: 'not_approved' };
  }).immediate();
}

/** Autonomous approval: every drafted row whose job is not blocked is approved; blocked ones are skipped. */
export function approveDraftedFollowups(db: BetterSqlite3.Database, _now: Date = new Date()): { approved: number[]; skipped: number[] } {
  const drafted = db.prepare("SELECT id, job_id FROM followups WHERE status = 'drafted' ORDER BY id").all() as Array<{ id: number; job_id: string }>;
  const blocked = blockedJobIds(db);
  const ok = drafted.filter((d) => !blocked.has(d.job_id)).map((d) => d.id);
  const no = drafted.filter((d) => blocked.has(d.job_id)).map((d) => d.id);
  setFollowupApproval(db, ok, true);
  setFollowupApproval(db, no, false);
  return { approved: ok, skipped: no };
}
