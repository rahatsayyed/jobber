// src/outreach/escalations.ts
// The owner's Inbox: open escalations grouped, de-duplicated for display and joined to the person, company and job when known.
// Read functions work on the dashboard's read-only handle (an old database without `snoozed_until` or `inbound_messages` still works).
// The two writes (resolve, snooze) are the only changes the owner can make; nothing here sends anything to a third party.
// Escalation text is untrusted model and third-party text: it is cleaned here (cleanText) and rendered as plain text everywhere.
import BetterSqlite3 from 'better-sqlite3';
import { cleanText } from '../dash/clean.js';
import { migrateSchedulerTables } from '../scheduler/runLog.js';

type Db = BetterSqlite3.Database;

export type EscGroup = 'human' | 'platform' | 'noise';
export type EscStatus = 'open' | 'snoozed' | 'resolved' | 'all';

export const GROUP_ORDER: EscGroup[] = ['human', 'platform', 'noise'];
export const GROUP_LABELS: Record<EscGroup, string> = {
  human: 'Replies and needs you',
  platform: 'Platform and tool problems',
  noise: 'Flagged (blocked or unscreened)',
};

const MAX_ROWS = 500;
const MAX_IDS = 200;
const REASON_MAX = 300;
const DETAIL_MAX = 600;
const EXCERPT_MAX = 1500;
const RAW_MAX = 1500;

const NOISE_RE = /^\s*\[(blocked|unscreened)\b|injection[_ ]suspect/i;
// Reason words that mean the tool or the page broke (checked before the human words, so "reply form drift" stays a tool problem).
const PROBLEM_RE = /drift|limit|quota|dialog|menu|refs?\b|unclickable|unreadable|unreachable|mismatch|halt|cannot|not found|failed|streak|missing|not_actionable|no_button|exhausted|in_progress|refused/i;
const HUMAN_RE = /reply[_ ]needed|inquiry|recruiter|referral|salary|compensation|interview|slot|inbound|question|asks?\b|wants to|needs[_ ]owner/i;
const THREAD_URL_RE = /^[A-Za-z0-9_=-]{1,120}$/;

export interface Classified { group: EscGroup; flag: string | null }

/** Priority for the owner: real people and apply rows first, platform and tool problems second, blocked or injection-suspect noise last. */
export function classifyEscalation(platform: string | null, reason: string, detail: string | null): Classified {
  const r = String(reason ?? '');
  const blocked = /^\s*\[blocked:\s*([^\]]*)\]/i.exec(r);
  const inputFlags = /\[input flags:\s*([^\]]*)\]/i.exec(r)?.[1]?.trim();
  const flag = blocked
    ? `blocked: ${blocked[1].trim()}`
    : /^\s*\[unscreened\]/i.test(r)
      ? 'unscreened'
      : inputFlags ? `input flags: ${inputFlags}` : null;
  if (NOISE_RE.test(r)) return { group: 'noise', flag: flag ?? 'injection suspected' };
  if (PROBLEM_RE.test(r)) return { group: 'platform', flag };
  if (platform === 'apply' || HUMAN_RE.test(r) || HUMAN_RE.test(String(detail ?? ''))) return { group: 'human', flag };
  return { group: 'platform', flag };
}

/** The LinkedIn messaging thread for a stored thread_ref. Other platforms: no URL is known, so none is invented. */
export function linkedinThreadUrl(platform: string | null, threadRef: string | null): string | null {
  if (platform !== 'linkedin' || !threadRef || !THREAD_URL_RE.test(threadRef)) return null;
  // LinkedIn thread ids are "2-" plus url-safe base64 WITH '=' padding; the stored ref has no '=' (the ref charset excludes it),
  // and an unpadded id shows "this conversation failed to load".
  const dash = threadRef.indexOf('-');
  const tail = dash >= 0 ? threadRef.slice(dash + 1) : '';
  const padded = tail !== '' && tail.length % 4 !== 0 ? `${threadRef}${'='.repeat(4 - (tail.length % 4))}` : threadRef;
  return `https://www.linkedin.com/messaging/thread/${padded}/`;
}

export const ASK_KINDS = ['recruiter_inquiry', 'interview_slot', 'salary', 'question', 'reply', 'other'] as const;
export type AskKind = (typeof ASK_KINDS)[number];

const SALARY_RE = /salary|ctc|compensation|expected pay|\bpay\b|\$\s?\d+\s*(\/|per)\s*(hr|hour)|per hour|hourly rate/i;
const SLOT_RE = /interview|schedul|time slot|\bslot\b|availab|calendar|\bcall\b/i;
const INQUIRY_RE = /recruiter|opportunit|\brole\b|hiring|position|open to|inquiry|job/i;

/** The closed ask enum, derived in code (never by the model): reason words first, then the stored inbound class, then keywords in the text. */
export function deriveAskKind(i: { klass?: string | null; reason: string; detail?: string | null; excerpt?: string | null }): AskKind {
  const reason = String(i.reason ?? '');
  if (SALARY_RE.test(reason)) return 'salary';
  if (/interview[_ ]?(time|slot)|\bslot\b|schedul/i.test(reason)) return 'interview_slot';
  if (i.klass === 'interview') return 'interview_slot';
  if (i.klass === 'recruiter_inquiry') return 'recruiter_inquiry';
  if (i.klass === 'reply') return 'reply';
  if (PROBLEM_RE.test(reason)) return 'other';
  if (/inquiry/i.test(`${reason} ${i.detail ?? ''}`)) return 'recruiter_inquiry';
  if (/reply[_ ]needed/i.test(reason)) return 'reply';
  const text = `${reason}\n${i.detail ?? ''}\n${i.excerpt ?? ''}`;
  if (SALARY_RE.test(text)) return 'salary';
  if (SLOT_RE.test(text)) return 'interview_slot';
  if (INQUIRY_RE.test(text)) return 'recruiter_inquiry';
  if (/\?|question/i.test(text)) return 'question';
  return 'other';
}

const ASK_LABELS: Record<AskKind, string> = {
  recruiter_inquiry: 'Recruiter inquiry', interview_slot: 'Interview slot', salary: 'Asks for salary', question: 'Has a question', reply: 'Wants a reply', other: 'Needs a look',
};

/** The short plain-words reason the dashboard and Telegram show instead of the raw code. */
export function reasonLabel(group: EscGroup, askKind: AskKind): string {
  if (group === 'noise') return 'Flagged by the injection screen';
  if (group === 'platform') return 'Platform problem';
  return ASK_LABELS[askKind];
}

/** One plain line on what the owner should do (or that nothing is needed). Closed text built in code; the raw reason only selects the line. */
export function whatToDo(group: EscGroup, askKind: AskKind, platform: string | null, reason: string): string {
  const r = String(reason ?? '');
  if (group === 'noise') return 'The text looked like it was aimed at an AI, so it is hidden by default. Open the thread yourself if it matters.';
  if (group === 'human') {
    if (platform === 'apply') return 'An application needs you (captcha, login or a question). Finish it by hand or ignore it.';
    if (askKind === 'salary') return 'Asks about pay. Answer yourself on the platform; the agent never answers this.';
    if (askKind === 'interview_slot') return 'Wants a time. Reply with your availability yourself on the platform.';
    return 'Open the thread, read it and reply yourself. The agent never answers this.';
  }
  if (/note[_ ]?(limit|quota)|quota[_ ]exhausted/i.test(r)) return 'LinkedIn note quota used: invites now go without a note; nothing to do.';
  if (/layout/i.test(r)) return 'The page layout changed and the agent skipped that step. Nothing to do unless it keeps coming back.';
  if (/mismatch|employer/i.test(r)) return 'The person did not match the record, so they were skipped. Nothing to do.';
  if (/dialog|menu|refs?\b|unclickable|unreadable|not_actionable|no_button|click/i.test(r)) return 'LinkedIn showed a screen the agent could not use. Nothing was sent; nothing to do.';
  return 'A tool had a problem and skipped the step. Usually nothing to do; run /health if it keeps coming back.';
}

export interface EscItem {
  /** Newest row id of the group (what the owner quotes). */
  id: number;
  /** Every row id the display merged; actions apply to all of them. */
  ids: number[];
  count: number;
  platform: string | null;
  reason: string;
  detail: string | null;
  group: EscGroup;
  flag: string | null;
  created_at: string;
  first_at: string;
  threadRef: string | null;
  threadUrl: string | null;
  personId: number | null;
  personName: string | null;
  personCompany: string | null;
  jobTitle: string | null;
  resolved_at: string | null;
  snoozed_until: string | null;
  /** Sender as shown in the thread (stored), else the person record. */
  senderName: string | null;
  senderHeadline: string | null;
  /** Latest inbound message text. Untrusted; cleaned and capped, plain text only. Null on old rows. */
  excerpt: string | null;
  messageAt: string | null;
  askKind: AskKind;
  /** Plain-words reason and what-to-do line, built in code. */
  label: string;
  todo: string;
  /** Total times the conversation was reported (sum over merged rows). */
  updates: number;
  /** Newest activity (last update or creation). */
  last_at: string;
  /** Text the input screen blocked, for the collapsed owner-only toggle. Never returned by an MCP tool. */
  rawText: string | null;
}

export interface EscCounts { open: number; snoozed: number; resolved: number }

interface Raw {
  id: number; platform: string | null; person_id: number | null; thread_ref: string | null; reason: string; detail: string | null;
  created_at: string; resolved_at: string | null; snoozed_until: string | null;
  pid: number | null; pname: string | null; pcompany: string | null; pheadline: string | null; job_title: string | null; job_company: string | null;
  sender_name: string | null; sender_headline: string | null; message_excerpt: string | null; message_at: string | null; ask_kind: string | null;
  seen_count: number | null; updated_at: string | null; raw_text: string | null; klass: string | null;
}

const NEW_COLS = ['sender_name', 'sender_headline', 'message_excerpt', 'message_at', 'ask_kind', 'seen_count', 'updated_at', 'raw_text'] as const;

function hasTable(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
function hasSnooze(db: Db): boolean {
  return (db.prepare('PRAGMA table_info(escalations)').all() as { name: string }[]).some((c) => c.name === 'snoozed_until');
}

function statusWhere(status: EscStatus, snz: string): string {
  if (status === 'open') return `e.resolved_at IS NULL AND (${snz} IS NULL OR ${snz} <= @now)`;
  if (status === 'snoozed') return `e.resolved_at IS NULL AND ${snz} IS NOT NULL AND ${snz} > @now`;
  if (status === 'resolved') return 'e.resolved_at IS NOT NULL';
  return '1 = 1';
}

export function countEscalations(db: Db, now: Date): EscCounts {
  if (!hasTable(db, 'escalations')) return { open: 0, snoozed: 0, resolved: 0 };
  const snz = hasSnooze(db) ? 'e.snoozed_until' : 'NULL';
  const n = (s: EscStatus): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM escalations e WHERE ${statusWhere(s, snz)}`).get({ now: now.toISOString() }) as { c: number }).c;
  return { open: n('open'), snoozed: n('snoozed'), resolved: n('resolved') };
}

export function listEscalations(
  db: Db,
  opts: { now: Date; status?: EscStatus; platform?: string; group?: EscGroup; limit?: number },
): { items: EscItem[]; counts: EscCounts } {
  const counts = countEscalations(db, opts.now);
  if (!hasTable(db, 'escalations')) return { items: [], counts };
  const status = opts.status ?? 'open';
  const snz = hasSnooze(db) ? 'e.snoozed_until' : 'NULL';
  const inbound = hasTable(db, 'inbound_messages')
    ? '(SELECT im.person_id FROM inbound_messages im WHERE im.platform = e.platform AND im.thread_ref = e.thread_ref AND im.person_id IS NOT NULL ORDER BY im.id DESC LIMIT 1)'
    : 'NULL';
  const people = hasTable(db, 'people');
  const touchJob = people && hasTable(db, 'touches') && hasTable(db, 'jobs');
  const pidExpr = `COALESCE(e.person_id, ${inbound})`;
  const where = [statusWhere(status, snz)];
  const params: Record<string, unknown> = { now: opts.now.toISOString(), lim: MAX_ROWS };
  if (opts.platform) {
    where.push('e.platform = @platform');
    params.platform = opts.platform;
  }
  const have = new Set((db.prepare('PRAGMA table_info(escalations)').all() as { name: string }[]).map((c) => c.name));
  const nc = NEW_COLS.map((c) => `${have.has(c) ? `e.${c}` : 'NULL'} AS ${c}`).join(', ');
  const klass = hasTable(db, 'inbound_messages')
    ? '(SELECT im.klass FROM inbound_messages im WHERE im.platform = e.platform AND im.thread_ref = e.thread_ref ORDER BY im.id DESC LIMIT 1)'
    : 'NULL';
  const sql = `SELECT e.id, e.platform, e.person_id, e.thread_ref, e.reason, e.detail, e.created_at, e.resolved_at, ${snz} AS snoozed_until, ${nc},
      ${klass} AS klass,
      ${people ? `(SELECT p.headline FROM people p WHERE p.id = ${pidExpr})` : 'NULL'} AS pheadline,
      ${pidExpr} AS pid,
      ${people ? `(SELECT p.name FROM people p WHERE p.id = ${pidExpr})` : 'NULL'} AS pname,
      ${people ? `(SELECT p.company FROM people p WHERE p.id = ${pidExpr})` : 'NULL'} AS pcompany,
      ${touchJob ? `(SELECT j.title FROM touches t JOIN jobs j ON j.id = t.job_id WHERE t.person_id = ${pidExpr} ORDER BY t.id DESC LIMIT 1)` : 'NULL'} AS job_title,
      ${touchJob ? `(SELECT j.company FROM touches t JOIN jobs j ON j.id = t.job_id WHERE t.person_id = ${pidExpr} ORDER BY t.id DESC LIMIT 1)` : 'NULL'} AS job_company
    FROM escalations e WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT @lim`;
  const rows = db.prepare(sql).all(params) as Raw[];

  const merged = new Map<string, EscItem>();
  for (const r of rows) {
    const reason = cleanText(r.reason, REASON_MAX);
    const detail = r.detail === null ? null : cleanText(r.detail, DETAIL_MAX);
    // One conversation is one card: rows of the same platform and thread merge whatever their wording. Rows without a thread merge when identical.
    const key = r.thread_ref ? [r.platform, r.thread_ref].join('\u0001') : [r.platform, reason, r.pid, detail].join('\u0001');
    const seen = Math.max(1, r.seen_count ?? 1);
    const excerpt = r.message_excerpt === null ? null : cleanText(r.message_excerpt, EXCERPT_MAX);
    const sender = r.sender_name ? cleanText(r.sender_name, 200) : r.pname === null ? null : cleanText(r.pname, 200);
    const headline = r.sender_headline ? cleanText(r.sender_headline, 300) : r.pheadline ? cleanText(r.pheadline, 300) : r.pcompany ? cleanText(r.pcompany, 200) : null;
    const raw = r.raw_text ? cleanText(r.raw_text, RAW_MAX) : null;
    const hit = merged.get(key);
    if (hit) {
      // Older rows only fill what the newest row lacks.
      hit.ids.push(r.id);
      hit.count += 1;
      hit.updates += seen;
      if (r.created_at < hit.first_at) hit.first_at = r.created_at;
      hit.excerpt ??= excerpt;
      hit.messageAt ??= r.message_at;
      hit.senderName ??= sender;
      hit.senderHeadline ??= headline;
      hit.rawText ??= raw;
      continue;
    }
    const c = classifyEscalation(r.platform, reason, detail);
    const askKind = (ASK_KINDS as readonly string[]).includes(r.ask_kind ?? '')
      ? (r.ask_kind as AskKind)
      : deriveAskKind({ klass: r.klass, reason, detail, excerpt });
    merged.set(key, {
      senderName: sender, senderHeadline: headline, excerpt, messageAt: r.message_at, askKind,
      label: reasonLabel(c.group, askKind), todo: whatToDo(c.group, askKind, r.platform, reason),
      updates: seen, last_at: r.updated_at ?? r.created_at, rawText: raw,
      id: r.id, ids: [r.id], count: 1, platform: r.platform, reason, detail, group: c.group, flag: c.flag,
      created_at: r.created_at, first_at: r.created_at, threadRef: r.thread_ref, threadUrl: linkedinThreadUrl(r.platform, r.thread_ref),
      personId: r.pid, personName: r.pname === null ? null : cleanText(r.pname, 200), personCompany: r.pcompany === null ? null : cleanText(r.pcompany, 200),
      jobTitle: r.job_title === null ? null : `${cleanText(r.job_title, 200)}${r.job_company ? ` at ${cleanText(r.job_company, 100)}` : ''}`,
      resolved_at: r.resolved_at, snoozed_until: r.snoozed_until,
    });
  }
  // Within a group: newest activity first.
  const items = [...merged.values()]
    .filter((i) => !opts.group || i.group === opts.group)
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0) || b.id - a.id);
  return { items: opts.limit ? items.slice(0, opts.limit) : items, counts };
}

function cleanIds(ids: number[]): number[] {
  return [...new Set(ids)].filter((i) => Number.isInteger(i) && i > 0).slice(0, MAX_IDS);
}

/** Marks open escalations handled. Returns how many rows changed (an already resolved row is left alone). */
export function resolveEscalations(db: Db, ids: number[], now: Date): number {
  const list = cleanIds(ids);
  if (!list.length) return 0;
  const stmt = db.prepare('UPDATE escalations SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL');
  return db.transaction(() => list.reduce((n, id) => n + stmt.run(now.toISOString(), id).changes, 0))();
}

/** Hides open escalations until `until`. A resolved row is never snoozed. */
export function snoozeEscalations(db: Db, ids: number[], until: Date, now: Date): number {
  const list = cleanIds(ids);
  if (!list.length || until.getTime() <= now.getTime()) return 0;
  const stmt = db.prepare('UPDATE escalations SET snoozed_until = ? WHERE id = ? AND resolved_at IS NULL');
  return db.transaction(() => list.reduce((n, id) => n + stmt.run(until.toISOString(), id).changes, 0))();
}

/** The dashboard's narrow write: one short-lived connection (its own handle is read-only), migrated so `snoozed_until` exists. */
export function withEscalationWriter<T>(path: string, fn: (db: Db) => T): T {
  const db = new BetterSqlite3(path, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    migrateSchedulerTables(db);
    return fn(db);
  } finally {
    db.close();
  }
}
