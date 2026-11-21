// src/platform/digest.ts
// Telegram noise control: every code-sent notice has a KIND, and the closed table below says if it is `urgent` (sent at once) or `routine`
// (written to the `notice_queue` table and sent as ONE silent digest per TELEGRAM_DIGEST_EVERY_MIN to the `wakes` topic). Zero LLM.
// TELEGRAM_DIGEST=off restores the old behaviour: every routine notice is sent at once as before.
// The queue holds counts and short cleaned fields only (never raw page or mail text). Rows are marked sent only after Telegram accepted the digest.
import type BetterSqlite3 from 'better-sqlite3';
import { E, bullets, clean, headline, html, htmlToPlain, lines, section, BLANK } from './tgHtml.js';
import { inQuietHours, IST_OFFSET_MINUTES, type QuietConfig } from '../outreach/quiet.js';
import { getState, setState } from '../scheduler/runLog.js';
import type { TopicName } from '../telegram/topics.js';

type Db = BetterSqlite3.Database;

export type Urgency = 'urgent' | 'routine';

export interface KindInfo { urgency: Urgency; topic: TopicName; reason: string }

/** The closed list. A kind that is not here cannot be routed. URGENT: owner needed, system blocked, safety refusal, self-heal, dry-run mismatch. */
export const NOTICE_KINDS = {
  // ---- urgent: owner needed
  reply_needs_you: { urgency: 'urgent', topic: 'inbox', reason: 'a reply or recruiter inquiry asks the owner for something' },
  reply_interview_offer: { urgency: 'urgent', topic: 'inbox', reason: 'an interview or offer mail: the owner decides' },
  email_reply_cancelled: { urgency: 'urgent', topic: 'inbox', reason: 'an automatic reply was cancelled: the owner answers by hand' },
  reply_facts_unusable: { urgency: 'urgent', topic: 'inbox', reason: 'automatic replies are on but the facts file is unusable: plain asks come to the owner' },
  apply_needs_you: { urgency: 'urgent', topic: 'assist', reason: 'an apply parked for the owner (login, unanswerable question, apply:assist)' },
  apply_captcha: { urgency: 'urgent', topic: 'assist', reason: 'a captcha waits for the owner to solve it by hand' },
  escalation_critical: { urgency: 'urgent', topic: 'inbox', reason: 'critical open escalations (replies, recruiter inquiries, platform problems)' },
  handoff_reminder: { urgency: 'urgent', topic: 'alerts', reason: 'pending handoff items ask for the owner' },
  manual_report_failed: { urgency: 'urgent', topic: 'inbox', reason: 'an owner-submitted request found no job or failed' },
  // ---- urgent: blocks the system
  wake_blocked: { urgency: 'urgent', topic: 'wakes', reason: 'kill switch or halt stopped a wake' },
  wake_failed: { urgency: 'urgent', topic: 'alerts', reason: 'a wake failed, crashed, ran out of budget or ended incomplete' },
  usage_backoff: { urgency: 'urgent', topic: 'alerts', reason: 'usage limit reached: the scheduler backs off' },
  drip_failed: { urgency: 'urgent', topic: 'alerts', reason: 'a mail or LinkedIn drip run crashed or ended unclean' },
  mail_held: { urgency: 'urgent', topic: 'mail', reason: 'a mail row is held or stuck: check Gmail Sent before it is released' },
  window_down: { urgency: 'urgent', topic: 'alerts', reason: 'a worker window stays down: items are skipped' },
  reply_check_held: { urgency: 'urgent', topic: 'alerts', reason: 'the reply check failed: follow-ups and replies are held' },
  session_alert: { urgency: 'urgent', topic: 'alerts', reason: 'logged-out LinkedIn or Naukri session or a critical discover alert' },
  daemon_down: { urgency: 'urgent', topic: 'alerts', reason: 'the stack or a daemon is not running' },
  update_error: { urgency: 'urgent', topic: 'alerts', reason: 'auto-update or backup failed' },
  // ---- urgent: safety refusals, self-heal, dry-run mismatch
  classifier_block: { urgency: 'urgent', topic: 'alerts', reason: 'the input classifier blocked a read or send' },
  fact_gate_block: { urgency: 'urgent', topic: 'alerts', reason: 'the fact gate blocked an outbound text' },
  heal: { urgency: 'urgent', topic: 'alerts', reason: 'self-heal event: landed, rolled back, gave up or fix ready' },
  dry_run_mismatch: { urgency: 'urgent', topic: 'alerts', reason: 'dry-run flag and window state do not match' },
  // ---- routine: digest only
  mail_sent: { urgency: 'routine', topic: 'mail', reason: 'one cold email or follow-up went out' },
  email_reply_sent: { urgency: 'routine', topic: 'mail', reason: 'one automatic email reply went out' },
  linkedin_action: { urgency: 'routine', topic: 'linkedin', reason: 'one invite, DM, reply or Easy Apply' },
  linkedin_accept_check: { urgency: 'routine', topic: 'linkedin', reason: 'accept check done' },
  linkedin_inbox_read: { urgency: 'routine', topic: 'linkedin', reason: 'inbox read, nothing the owner must do' },
  linkedin_inbox_notice: { urgency: 'routine', topic: 'inbox', reason: 'new LinkedIn threads and queued replies that need nothing from the owner' },
  replies_seen: { urgency: 'routine', topic: 'mail', reason: 'email replies that need nothing from the owner (acks, rejections, noise)' },
  wake_summary: { urgency: 'routine', topic: 'wakes', reason: 'a wake that ended ok' },
  wake_skipped: { urgency: 'routine', topic: 'wakes', reason: 'a wake was skipped for a normal reason (ceilings used up)' },
  manual_report: { urgency: 'routine', topic: 'inbox', reason: 'progress of an owner-submitted request that did not fail' },
  window_recycled: { urgency: 'routine', topic: 'alerts', reason: 'an idle window was recycled' },
  apply_done: { urgency: 'routine', topic: 'wakes', reason: 'a successful apply' },
  jd_read: { urgency: 'routine', topic: 'wakes', reason: 'a job description read' },
  hiring_posts: { urgency: 'routine', topic: 'wakes', reason: 'hiring posts found' },
  backup_done: { urgency: 'routine', topic: 'alerts', reason: 'a backup finished' },
  update_done: { urgency: 'routine', topic: 'alerts', reason: 'an update finished' },
} as const satisfies Record<string, KindInfo>;

export type NoticeKind = keyof typeof NOTICE_KINDS;
export const urgencyOf = (kind: NoticeKind): Urgency => NOTICE_KINDS[kind].urgency;

// ---- env ----
export const DIGEST_DEFAULT_MIN = 60;
export const DIGEST_MIN = 15;
export const DIGEST_MAX = 1440;

/** `off` (any case, trimmed) is the old behaviour; everything else is on. */
export function digestOn(env: NodeJS.ProcessEnv): boolean {
  return (env.TELEGRAM_DIGEST ?? '').trim().toLowerCase() !== 'off';
}
export function digestEveryMin(env: NodeJS.ProcessEnv): number {
  const raw = (env.TELEGRAM_DIGEST_EVERY_MIN ?? '').trim();
  if (!raw) return DIGEST_DEFAULT_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DIGEST_DEFAULT_MIN;
  return Math.min(DIGEST_MAX, Math.max(DIGEST_MIN, Math.round(n)));
}

// ---- queue ----
export function ensureNoticeQueue(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notice_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      topic TEXT NOT NULL,
      urgency TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      sent_in_digest_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notice_queue_unsent ON notice_queue (sent_in_digest_at, at);
  `);
}

export type Payload = Record<string, unknown>;

/** Counts and short cleaned fields only: numbers, booleans, strings (cleaned, secrets redacted, 60 chars), one level of plain objects. */
export function sanitizePayload(p: Payload | undefined, depth = 0): Payload {
  const out: Payload = {};
  if (!p) return out;
  for (const [k, v] of Object.entries(p).slice(0, 24)) {
    const key = k.replace(/[^\w.-]/g, '').slice(0, 30);
    if (!key) continue;
    if (typeof v === 'number') { if (Number.isFinite(v)) out[key] = v; }
    else if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = clean(v, 60);
    else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 1) out[key] = sanitizePayload(v as Payload, depth + 1);
  }
  return out;
}

export interface QueueRow { id: number; at: string; kind: string; topic: string; urgency: string; payload: Payload; sent_in_digest_at: string | null }

export function enqueueNotice(db: Db, kind: NoticeKind, payload: Payload | undefined, now: Date): number {
  ensureNoticeQueue(db);
  const info = NOTICE_KINDS[kind];
  const json = JSON.stringify(sanitizePayload(payload)).slice(0, 2000);
  return Number(db.prepare('INSERT INTO notice_queue (at, kind, topic, urgency, payload) VALUES (?, ?, ?, ?, ?)').run(now.toISOString(), kind, info.topic, info.urgency, json).lastInsertRowid);
}

function parseRows(raw: Array<Omit<QueueRow, 'payload'> & { payload: string }>): QueueRow[] {
  return raw.map((r) => {
    let payload: Payload = {};
    try { const v = JSON.parse(r.payload) as unknown; if (v && typeof v === 'object') payload = v as Payload; } catch { /* keep empty */ }
    return { ...r, payload };
  });
}

/** Rows not yet in a digest (oldest first). A missing table is an empty queue. */
export function unsentRows(db: Db): QueueRow[] {
  try {
    return parseRows(db.prepare('SELECT * FROM notice_queue WHERE sent_in_digest_at IS NULL ORDER BY id').all() as never);
  } catch { return []; }
}

/** Rows noted since an instant, sent or not (the on-demand status view). */
export function rowsSince(db: Db, sinceIso: string): QueueRow[] {
  try {
    return parseRows(db.prepare('SELECT * FROM notice_queue WHERE at >= ? ORDER BY id').all(sinceIso) as never);
  } catch { return []; }
}

export function markSent(db: Db, ids: number[], now: Date): void {
  if (!ids.length) return;
  const up = db.prepare('UPDATE notice_queue SET sent_in_digest_at = ? WHERE id = ? AND sent_in_digest_at IS NULL');
  db.transaction(() => { for (const id of ids) up.run(now.toISOString(), id); })();
}

export function pruneQueue(db: Db, now: Date, keepDays = 14): void {
  try { db.prepare('DELETE FROM notice_queue WHERE sent_in_digest_at IS NOT NULL AND sent_in_digest_at < ?').run(new Date(now.getTime() - keepDays * 86_400_000).toISOString()); } catch { /* ignore */ }
}

// ---- routing ----
export type TgSend = (topic: TopicName, text: string, opts?: { html?: boolean; silent?: boolean }) => Promise<unknown>;

export interface RouteDeps { db?: Db; tg?: TgSend; env?: NodeJS.ProcessEnv; now: () => Date }
export interface NoticeSpec {
  kind: NoticeKind;
  /** Telegram HTML of the full notice: sent at once for urgent kinds (and in `off` mode for routine ones). */
  text: string;
  /** Topic override for the at-once send (default: the table's topic). */
  topic?: TopicName;
  silent?: boolean;
  /** What the digest shows (counts and short fields). */
  payload?: Payload;
}
export type RouteResult = 'sent' | 'queued' | 'dropped';

const SEND_TIMEOUT_MS = 10_000;

async function sendNow(post: TgSend, topic: TopicName, text: string, silent: boolean | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => post(topic, text, { html: true, ...(silent === undefined ? {} : { silent }) })).catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, SEND_TIMEOUT_MS); timer.unref?.(); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * The one routing point of code-sent notices. Urgent kind: sent at once. Routine kind: written to the queue (digest on) or sent at once
 * (TELEGRAM_DIGEST=off, the old behaviour). No Telegram setup (`tg` absent): nothing at all. Never throws.
 */
export async function routeNotice(d: RouteDeps, spec: NoticeSpec): Promise<RouteResult> {
  try {
    if (!d.tg) return 'dropped';
    const info = NOTICE_KINDS[spec.kind];
    if (!info) return 'dropped';
    const env = d.env ?? process.env;
    if (info.urgency === 'routine' && digestOn(env) && d.db) {
      try { enqueueNotice(d.db, spec.kind, spec.payload, d.now()); return 'queued'; } catch { /* fall through: better a message than a lost notice */ }
    }
    await sendNow(d.tg, spec.topic ?? info.topic, spec.text, spec.silent);
    return 'sent';
  } catch {
    return 'dropped';
  }
}

// ---- digest content ----
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const plural = (c: number, one: string, many = `${one}s`): string => `${c} ${c === 1 ? one : many}`;
const bump = (m: Map<string, number>, k: string, by = 1): void => { m.set(k, (m.get(k) ?? 0) + by); };
const listOf = (m: Map<string, number>, max = 8): string => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k, c]) => `${k} ${c}`).join(', ');

/** What the system does about a problem code (short, fixed text). */
const PROBLEM_ACTION: Record<string, string> = {
  source_errors: 'fallback readers retry at the next code pass',
  stopped: 'unfinished work is due again at the next wake',
  escalated: 'listed in /escalations',
  skipped_ceilings: 'resumes when the daily ceiling resets',
  inbox_unclear: 'listed in /escalations',
};

export interface DigestContent {
  empty: boolean;
  /** Telegram HTML; empty string when there is nothing to say. */
  text: string;
  needsYou: number;
}

export function istClock(d: Date): string {
  const t = new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}
function istSpan(from: Date, to: Date): string {
  const dayOf = (d: Date): string => new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
  const same = dayOf(from) === dayOf(to);
  return `${same ? '' : `${dayOf(from).slice(5)} `}${istClock(from)} to ${istClock(to)} IST`;
}

/** Open escalations that ask for the owner (not info only). A missing table gives 0. */
export function needsYouCount(db: Db): number {
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM escalations WHERE resolved_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= datetime('now'))").get() as { n: number }).n;
  } catch { return 0; }
}

/** The digest of some queue rows over a time span. Pure: reads nothing but its arguments. */
export function composeDigest(rows: QueueRow[], span: { from: Date; to: Date }, needsYou: number): DigestContent {
  if (rows.length === 0) return { empty: true, text: '', needsYou };
  let coldM = 0, followM = 0, dryMail = 0, autoReply = 0;
  const li = new Map<string, number>();
  let dryLi = 0;
  const applies = new Map<string, number>();
  let jdRead = 0, hiringPosts = 0, inboxReads = 0, acceptChecks = 0;
  let newJobs = 0, scored = 0, matched = 0, prepared = 0, wakes = 0, queuedEmail = 0, queuedConnect = 0, queuedApply = 0, followupsDrafted = 0;
  const bySource = new Map<string, number>();
  let liThreads = 0, liReplies = 0, liNeed = 0, mailReplies = 0, mailNeed = 0;
  const problems = new Map<string, number>();
  let manual = 0, manualJobs = 0, recycled = 0;
  for (const r of rows) {
    const p = r.payload;
    switch (r.kind) {
      case 'mail_sent': if (p.dry === true) dryMail++; else if (s(p.kind) === 'followup') followM++; else coldM++; break;
      case 'email_reply_sent': if (p.dry !== true) autoReply++; else dryMail++; break;
      case 'linkedin_action': if (p.dry === true) dryLi++; else bump(li, s(p.action) || 'action'); break;
      case 'linkedin_accept_check': acceptChecks++; break;
      case 'linkedin_inbox_read': inboxReads++; break;
      case 'linkedin_inbox_notice': liThreads += n(p.inbound); liReplies += n(p.drafts); liNeed += n(p.needs); break;
      case 'replies_seen': mailReplies += n(p.count); mailNeed += n(p.needs); break;
      case 'apply_done': bump(applies, s(p.platform) || 'web'); break;
      case 'jd_read': jdRead += Math.max(1, n(p.count)); break;
      case 'hiring_posts': hiringPosts += n(p.count); break;
      case 'window_recycled': recycled++; break;
      case 'manual_report': manual++; manualJobs += n(p.jobs); break;
      case 'wake_skipped': bump(problems, 'skipped_ceilings'); break;
      case 'wake_summary': {
        wakes++;
        newJobs += n(p.newJobs); scored += n(p.scored); matched += n(p.matched); prepared += n(p.prepared);
        queuedEmail += n(p.emailsQueued); queuedConnect += n(p.connectsQueued); queuedApply += n(p.appliesQueued); followupsDrafted += n(p.followups);
        const src = p.bySource;
        if (src && typeof src === 'object') for (const [k, v] of Object.entries(src as Payload)) bump(bySource, k, n(v));
        if (n(p.sourceErrors) > 0) bump(problems, 'source_errors', n(p.sourceErrors));
        if (n(p.stopped) > 0) bump(problems, 'stopped', n(p.stopped));
        if (n(p.escalated) > 0) bump(problems, 'escalated', n(p.escalated));
        break;
      }
      default: break; // an urgent kind in the queue (a restart or a mode change left it): shown as a problem count
    }
    if (NOTICE_KINDS[r.kind as NoticeKind]?.urgency === 'urgent') bump(problems, r.kind);
  }
  const sentLines: string[] = [];
  const emails = coldM + followM + autoReply;
  if (emails) sentLines.push(`${plural(emails, 'email')}${coldM || followM || autoReply ? ` (${[coldM && `${coldM} cold`, followM && `${followM} follow-up`, autoReply && `${autoReply} auto reply`].filter(Boolean).join(', ')})` : ''}`);
  if (li.size) sentLines.push(`LinkedIn: ${listOf(li)}`);
  if (applies.size) sentLines.push(`applies: ${listOf(applies)}`);
  if (dryMail || dryLi) sentLines.push(`dry run, nothing really sent: ${dryMail} mail, ${dryLi} LinkedIn`);
  const foundLines: string[] = [];
  if (newJobs) foundLines.push(`${plural(newJobs, 'new job')}${bySource.size ? ` (${listOf(bySource)})` : ''}`);
  if (hiringPosts) foundLines.push(plural(hiringPosts, 'hiring post'));
  if (jdRead) foundLines.push(`${plural(jdRead, 'job description')} read`);
  const workLines: string[] = [];
  if (scored || matched) workLines.push(`scored ${scored}, matched ${matched}`);
  if (prepared) workLines.push(`${prepared} prepared for outreach`);
  if (queuedEmail || queuedConnect || queuedApply) workLines.push(`queued: ${[queuedEmail && `${queuedEmail} email`, queuedConnect && `${queuedConnect} connect`, queuedApply && `${queuedApply} apply`].filter(Boolean).join(', ')}`);
  if (followupsDrafted) workLines.push(`${followupsDrafted} follow-up${followupsDrafted === 1 ? '' : 's'} drafted`);
  if (manual) workLines.push(`${plural(manual, 'manual request')} reported (${plural(manualJobs, 'job')})`);
  const replyLines: string[] = [];
  if (mailReplies) replyLines.push(`${plural(mailReplies, 'email reply', 'email replies')}${mailNeed ? ` (${mailNeed} need you)` : ''}`);
  if (liThreads || liReplies) replyLines.push(`LinkedIn: ${liThreads} new thread${liThreads === 1 ? '' : 's'}, ${liReplies} repl${liReplies === 1 ? 'y' : 'ies'} queued${liNeed ? ` (${liNeed} need you)` : ''}`);
  const probLines = [...problems.entries()].map(([k, c]) => `${k.replace(/_/g, ' ')} ${c}${PROBLEM_ACTION[k] ? `: ${PROBLEM_ACTION[k]}` : ''}`);
  const quietLines: string[] = [];
  if (wakes) quietLines.push(`${plural(wakes, 'wake')} ran`);
  if (acceptChecks || inboxReads) quietLines.push(`${acceptChecks} accept check${acceptChecks === 1 ? '' : 's'}, ${inboxReads} inbox read${inboxReads === 1 ? '' : 's'}`);
  if (recycled) quietLines.push(`${plural(recycled, 'window')} recycled`);
  const nextLines = needsYou > 0 ? [`${needsYou} item${needsYou === 1 ? '' : 's'} need${needsYou === 1 ? 's' : ''} you: send /escalations`] : [];
  const sections = [
    section('Sent', [bullets(sentLines)]),
    section('Found', [bullets(foundLines)]),
    section('Matched and prepared', [bullets(workLines)]),
    section('Replies seen', [bullets(replyLines)]),
    section('Problems', [bullets(probLines)]),
    section('Background', [bullets(quietLines)]),
    section('Next for you', [bullets(nextLines)]),
  ].filter((h) => h.s !== '');
  const head = headline(probLines.length ? E.warn : E.ok, `Jobber summary ${istSpan(span.from, span.to)}`);
  const text = html(lines([head, ...sections.flatMap((h) => [BLANK, h])]));
  return { empty: false, text, needsYou };
}

/** Digest of the queue over a span for the status command: plain text, or the "nothing happened" line. */
export function renderStatusDigest(db: Db, now: Date, sinceMs: number): string {
  const from = new Date(now.getTime() - sinceMs);
  const c = composeDigest(rowsSince(db, from.toISOString()), { from, to: now }, needsYouCount(db));
  const hours = sinceMs % 3_600_000 === 0 ? `${sinceMs / 3_600_000}h` : `${Math.round(sinceMs / 60_000)} min`;
  if (c.empty) return `nothing happened in the last ${hours}${c.needsYou ? `; ${c.needsYou} item${c.needsYou === 1 ? '' : 's'} need you (/escalations)` : ''}`;
  return htmlToPlain(c.text);
}

/** `1h`, `90m`, `3h`, `2d`; null when it is not a duration. */
export function parseSince(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^(\d{1,4})\s*(m|min|h|d)?$/i.exec(v.trim());
  if (!m) return null;
  const k = Number(m[1]);
  const unit = (m[2] ?? 'h').toLowerCase();
  const ms = unit === 'd' ? k * 86_400_000 : unit === 'h' ? k * 3_600_000 : k * 60_000;
  return ms > 0 && ms <= 30 * 86_400_000 ? ms : null;
}

// ---- the daemon tick ----
export const KEY_DIGEST_LAST_AT = 'tg_digest_last_at';

export interface DigestTickDeps {
  db: Db;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  quiet: QuietConfig;
  /** Sends the digest HTML; ok only when Telegram accepted it. */
  send: (text: string) => Promise<{ ok: boolean }>;
}

export type DigestTickResult = 'off' | 'quiet' | 'not_due' | 'empty' | 'sent' | 'send_failed';

/** One check: at most one message per period, none in quiet hours (the next digest then holds the whole span), none when empty. */
export async function digestTickOnce(d: DigestTickDeps): Promise<DigestTickResult> {
  if (!digestOn(d.env)) return 'off';
  const now = d.now();
  const last = Date.parse(getState(d.db, KEY_DIGEST_LAST_AT) ?? '');
  if (!Number.isFinite(last)) { setState(d.db, KEY_DIGEST_LAST_AT, now.toISOString(), now); return 'not_due'; }
  if (now.getTime() - last < digestEveryMin(d.env) * 60_000) return 'not_due';
  if (inQuietHours(now, d.quiet)) return 'quiet';
  ensureNoticeQueue(d.db);
  const rows = unsentRows(d.db);
  if (rows.length === 0) { setState(d.db, KEY_DIGEST_LAST_AT, now.toISOString(), now); pruneQueue(d.db, now); return 'empty'; }
  const from = new Date(Math.min(last, Date.parse(rows[0].at)));
  const c = composeDigest(rows, { from, to: now }, needsYouCount(d.db));
  const r = await d.send(c.text);
  if (!r.ok) return 'send_failed'; // rows stay queued; the next tick retries
  markSent(d.db, rows.map((x) => x.id), now);
  setState(d.db, KEY_DIGEST_LAST_AT, now.toISOString(), now);
  pruneQueue(d.db, now);
  return 'sent';
}

/** The daemon's tick (about every 30 seconds). Never throws. */
export function digestTick(d: DigestTickDeps): () => Promise<void> {
  return async () => {
    try { await digestTickOnce(d); } catch { /* a digest failure must never stop the scheduler */ }
  };
}

