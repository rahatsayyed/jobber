// Typed, read-only "which of my sent invites were accepted" check from ONE page: LinkedIn's own recent-connections list
// (newest first). One page load (plus at most two small scrolls) replaces one profile page per invite. Code opens the fixed
// URL, reads the visible entries (name, headline, profile link), and marks as `connected` every `connections` row with
// status 'sent' whose normalized profile URL matches an entry (markConnectionAccepted, which also activates the contact).
// Fail closed: an unreadable page, a login redirect or fewer than RECENT_MIN_ENTRIES parsed entries change nothing and
// return `unclear`. A name alone never marks anything. Runs at most once per 24 hours (a scheduler_state timestamp).
// Never clicks, never sends. Page text is untrusted: every name and headline goes through gateField.
import type BetterSqlite3 from 'better-sqlite3';
import { haltReason } from '../outreach/limits.js';
import { normalizeProfileKey } from '../outreach/people.js';
import { isDryRun, recordDryRun } from '../safety/dryRun.js';
import { getState, setState } from '../scheduler/runLog.js';
import { listAcceptCandidates, markConnectionAccepted } from './acceptCheck.js';
import { canonicalProfile } from './findProfiles.js';
import { gateField, MAX_FIELD_CHARS } from './state.js';
import type { RawSnapshot } from './types.js';

type Db = BetterSqlite3.Database;

export const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
/** scheduler_state key: when the recent-connections page was last read. */
export const ACCEPT_RECENT_KEY = 'linkedin_accept_recent_last_at';
/** The page is read at most once per this many hours. */
export const ACCEPT_RECENT_EVERY_HOURS = 24;
/** Fewer parsed entries than this means the page was not read properly: nothing is marked. */
export const RECENT_MIN_ENTRIES = 3;
/** Small scrolls after the first read, at most. */
export const RECENT_MAX_SCROLLS = 2;
const SCROLL_PAUSE_MIN_MS = 1500;
const SCROLL_PAUSE_MAX_MS = 3500;

export interface RecentEntry { key: string; profile_url: string; name: string; headline: string }

export type RecentStatus = 'ok' | 'unclear' | 'none' | 'dry_run' | 'halted' | 'rate_limited' | 'failed';
export interface RecentResult { status: RecentStatus; code: string; entries: number; marked: number }

export interface RecentIo {
  /** Opens the connections page in the locked session; returns its snapshot or a failure code ('halted' for a halt). */
  open(url: string): Promise<{ ok: true; snapshot: RawSnapshot } | { ok: false; code: string }>;
  /** Scrolls the open page a little and returns a fresh snapshot, or null when that is not possible. */
  scroll(): Promise<RawSnapshot | null>;
}
export interface RecentDeps {
  db: Db;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  killed?: () => string | null;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Hours since the page was last read; null when never (or unreadable stamp is treated as just now). */
export function hoursSinceRecentCheck(db: Db, now: Date): number | null {
  const v = getState(db, ACCEPT_RECENT_KEY);
  if (!v) return null;
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, now.getTime() - t) / 3600000;
}

/** Entries of one snapshot: canonical /in/ links only, names and headlines gated; an injection-suspect entry is dropped. */
export function entriesOf(snap: RawSnapshot): RecentEntry[] {
  const out: RecentEntry[] = [];
  for (const r of snap.results ?? []) {
    const profile_url = canonicalProfile(String(r.href ?? '').trim());
    if (!profile_url) continue;
    const name = gateField(String(r.name ?? ''), MAX_FIELD_CHARS.name);
    if (name.blocked || !name.text) continue;
    const head = gateField(String(r.headline ?? ''), MAX_FIELD_CHARS.headline);
    out.push({ key: normalizeProfileKey(profile_url), profile_url, name: name.text, headline: head.blocked ? '' : head.text });
  }
  return out;
}

const onConnectionsPage = (url: string): boolean => {
  try { return /^\/mynetwork\/invite-connect\/connections(\/|$)/.test(new URL(url).pathname.toLowerCase()); } catch { return false; }
};

export async function checkAcceptedRecent(io: RecentIo, deps: RecentDeps): Promise<RecentResult> {
  const { db, env, now } = deps;
  const res = (status: RecentStatus, code: string, entries = 0, marked = 0): RecentResult => ({ status, code, entries, marked });
  try {
    if (deps.killed?.() || haltReason(db, 'linkedin')) return res('halted', 'halted');
  } catch {
    return res('failed', 'halt_state_unreadable');
  }
  const age = hoursSinceRecentCheck(db, now());
  if (age !== null && age < ACCEPT_RECENT_EVERY_HOURS) return res('rate_limited', 'already_checked_today');
  // Open invites by normalized key (any age in the window, any check state): the only rows this tool may flip.
  const open = new Map(listAcceptCandidates(db, now(), new Set(), { minAgeDays: 0, recheckHours: 0 }).map((c) => [c.key, c.profile_url]));
  if (open.size === 0) return res('none', 'no_open_invites');
  if (isDryRun(env)) {
    recordDryRun(db, { runId: null, action: 'linkedin_check_accepted_recent', platform: 'linkedin', payload: { open_invites: open.size } }, now(), env);
    return res('dry_run', 'dry_run');
  }
  // Stamp as soon as the page is going to be loaded, whatever comes out: at most one load per 24 hours.
  setState(db, ACCEPT_RECENT_KEY, now().toISOString(), now());
  const first = await io.open(CONNECTIONS_URL);
  if (!first.ok) return first.code === 'halted' ? res('halted', 'halted') : res('failed', first.code);
  if (!onConnectionsPage(first.snapshot.url)) return res('unclear', 'unexpected_page');
  const seen = new Map<string, RecentEntry>();
  const take = (s: RawSnapshot): void => { for (const e of entriesOf(s)) if (!seen.has(e.key)) seen.set(e.key, e); };
  take(first.snapshot);
  const rnd = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  for (let i = 0; i < RECENT_MAX_SCROLLS; i++) {
    await sleep(SCROLL_PAUSE_MIN_MS + Math.floor(rnd() * (SCROLL_PAUSE_MAX_MS - SCROLL_PAUSE_MIN_MS)));
    const s = await io.scroll();
    if (!s || !onConnectionsPage(s.url)) break;
    take(s);
  }
  if (seen.size < RECENT_MIN_ENTRIES) return res('unclear', 'too_few_entries', seen.size);
  let marked = 0;
  for (const [key, profileUrl] of open) if (seen.has(key)) marked += markConnectionAccepted(db, profileUrl, now()) > 0 ? 1 : 0;
  return res('ok', 'read', seen.size, marked);
}
