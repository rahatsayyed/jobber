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
  return `https://www.linkedin.com/messaging/thread/${threadRef}/`;
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
}

export interface EscCounts { open: number; snoozed: number; resolved: number }

interface Raw {
  id: number; platform: string | null; person_id: number | null; thread_ref: string | null; reason: string; detail: string | null;
  created_at: string; resolved_at: string | null; snoozed_until: string | null;
  pid: number | null; pname: string | null; pcompany: string | null; job_title: string | null; job_company: string | null;
}

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
  const sql = `SELECT e.id, e.platform, e.person_id, e.thread_ref, e.reason, e.detail, e.created_at, e.resolved_at, ${snz} AS snoozed_until,
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
    const key = [r.platform, reason, r.thread_ref, r.pid, detail].join('\u0001');
    const hit = merged.get(key);
    if (hit) {
      hit.ids.push(r.id);
      hit.count += 1;
      if (r.created_at < hit.first_at) hit.first_at = r.created_at;
      continue;
    }
    const c = classifyEscalation(r.platform, reason, detail);
    merged.set(key, {
      id: r.id, ids: [r.id], count: 1, platform: r.platform, reason, detail, group: c.group, flag: c.flag,
      created_at: r.created_at, first_at: r.created_at, threadRef: r.thread_ref, threadUrl: linkedinThreadUrl(r.platform, r.thread_ref),
      personId: r.pid, personName: r.pname === null ? null : cleanText(r.pname, 200), personCompany: r.pcompany === null ? null : cleanText(r.pcompany, 200),
      jobTitle: r.job_title === null ? null : `${cleanText(r.job_title, 200)}${r.job_company ? ` at ${cleanText(r.job_company, 100)}` : ''}`,
      resolved_at: r.resolved_at, snoozed_until: r.snoozed_until,
    });
  }
  // Rows came newest first, so within a group the order is already newest first (by the newest row of each merged item).
  const items = [...merged.values()]
    .filter((i) => !opts.group || i.group === opts.group)
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || b.id - a.id);
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
