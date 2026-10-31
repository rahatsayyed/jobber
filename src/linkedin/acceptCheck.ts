// Typed, read-only LinkedIn "was my invite accepted" check. Code picks the next 'sent' invite from the legacy
// `connections` table, the tool opens that profile and reads the first-degree signal in code; the model passes nothing.
// A first-degree profile with no Connect button flips the row to 'connected', which is the acceptance signal
// `dueTouchesFor` reads (src/outreach/dueTouches.ts loadConnectedKeys), so the existing cadence then makes the
// person due for role_ask / rapport. Anything unclear changes nothing (fail closed). Never clicks, never sends.
import type BetterSqlite3 from 'better-sqlite3';
import { haltReason } from '../outreach/limits.js';
import { normalizeProfileKey } from '../outreach/people.js';
import { isDryRun, recordDryRun } from '../safety/dryRun.js';
import { connectionState } from './connectionState.js';
import { activateContact } from './touches.js';
import { isProfileUrl } from './urls.js';
import { verifyProfileUrl } from './verify.js';
import type { RawSnapshot } from './types.js';

type Db = BetterSqlite3.Database;

/** Most profiles one scheduler wake (one MCP server process) may check. */
export const ACCEPT_CHECK_MAX_PER_WAKE = 8;
/** A profile is not looked at again within this many hours. */
export const ACCEPT_RECHECK_HOURS = 20;
/** An invite is checked for at most this many days after it was sent. */
export const ACCEPT_WINDOW_DAYS = 21;
/** Random pause between two profiles of one wake. */
export const ACCEPT_PACE_MIN_MS = 3000;
export const ACCEPT_PACE_MAX_MS = 8000;

export interface AcceptCandidate { profile_url: string; key: string }

interface Row { profile_url: string; sent_at: string; accept_checked_at: string | null }

/** Eligible 'sent' invites, one per normalized profile, oldest check first (never checked first), then oldest invite. */
export function listAcceptCandidates(db: Db, now: Date, skip: ReadonlySet<string> = new Set()): AcceptCandidate[] {
  const windowCut = new Date(now.getTime() - ACCEPT_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const recheckCut = new Date(now.getTime() - ACCEPT_RECHECK_HOURS * 3600 * 1000).toISOString();
  let rows: Row[];
  let done: { profile_url: string }[];
  try {
    rows = db
      .prepare(
        `SELECT profile_url, sent_at, accept_checked_at FROM connections
          WHERE status = 'sent' AND profile_url IS NOT NULL AND profile_url <> '' AND sent_at IS NOT NULL AND sent_at >= ?
            AND (accept_checked_at IS NULL OR accept_checked_at <= ?)
          ORDER BY accept_checked_at IS NOT NULL, accept_checked_at ASC, sent_at ASC, id ASC`,
      )
      .all(windowCut, recheckCut) as Row[];
    done = db.prepare("SELECT profile_url FROM connections WHERE status IN ('messaged', 'connected') AND profile_url IS NOT NULL").all() as { profile_url: string }[];
  } catch {
    return [];
  }
  const already = new Set(done.map((d) => normalizeProfileKey(d.profile_url)));
  const seen = new Set<string>();
  const out: AcceptCandidate[] = [];
  for (const r of rows) {
    if (!isProfileUrl(r.profile_url)) continue;
    const key = normalizeProfileKey(r.profile_url);
    if (seen.has(key) || skip.has(key) || already.has(key)) continue;
    seen.add(key);
    out.push({ profile_url: r.profile_url, key });
  }
  return out;
}

/** How many profiles the next wake may check (what the planner plans), at most ACCEPT_CHECK_MAX_PER_WAKE. */
export function countAcceptCandidates(db: Db, now: Date): number {
  return Math.min(ACCEPT_CHECK_MAX_PER_WAKE, listAcceptCandidates(db, now).length);
}

function rowsOfKey(db: Db, key: string): { id: number }[] {
  const all = db.prepare("SELECT id, profile_url FROM connections WHERE status = 'sent' AND profile_url IS NOT NULL").all() as { id: number; profile_url: string }[];
  return all.filter((r) => normalizeProfileKey(r.profile_url) === key);
}

/** Idempotent setter: every 'sent' row of this profile becomes 'connected'. A 'messaged' (or already 'connected') row is never touched. Returns rows changed. */
export function markConnectionAccepted(db: Db, profileUrl: string, now: Date): number {
  const upd = db.prepare("UPDATE connections SET status = 'connected', accept_checked_at = ? WHERE id = ? AND status = 'sent'");
  let n = 0;
  const key = normalizeProfileKey(profileUrl);
  for (const r of rowsOfKey(db, key)) n += upd.run(now.toISOString(), r.id).changes;
  // The person must be 'active' to be due for the first DM (a sent invite already does this; this covers older rows).
  const person = db.prepare("SELECT id FROM people WHERE platform = 'linkedin' AND profile_key = ?").get(key) as { id: number } | undefined;
  if (person) activateContact(db, person.id, now);
  return n;
}

/** Records that the profile was looked at (any outcome except halted or dry run), so it is not picked again for ACCEPT_RECHECK_HOURS. */
export function stampAcceptChecked(db: Db, profileUrl: string, now: Date): void {
  const upd = db.prepare("UPDATE connections SET accept_checked_at = ? WHERE id = ? AND status = 'sent'");
  for (const r of rowsOfKey(db, normalizeProfileKey(profileUrl))) upd.run(now.toISOString(), r.id);
}

export type AcceptStatus = 'accepted' | 'pending' | 'not_accepted' | 'unclear' | 'none' | 'dry_run' | 'halted' | 'rate_limited' | 'failed';
export interface AcceptResult { status: AcceptStatus; code: string; remaining: number }

export interface AcceptIo {
  /** Opens the profile in the locked session; returns the snapshot or a failure code ('halted' for a halt). */
  open(url: string): Promise<{ ok: true; snapshot: RawSnapshot } | { ok: false; code: string }>;
}
export interface AcceptDeps {
  db: Db;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** Per-process state: keys already tried and how many checks ran, so a failure or dry run is never picked twice in one wake. */
  state: { tried: Set<string>; checked: number };
  /** Kill switch reason (STOP file, JOBBER_KILL, platform halt) or null. */
  killed?: () => string | null;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Decision from the profile's own header signals. Fail closed: only a visible first-degree profile without Connect and with Message is accepted. */
export function decideAccepted(p: NonNullable<RawSnapshot['profile']>): { status: 'accepted' | 'pending' | 'not_accepted' | 'unclear'; code: string } {
  const cs = connectionState(p);
  if (cs.state === 'pending') return { status: 'pending', code: cs.code };
  if (cs.state === 'connected') {
    const hasMessage = p.hasMessageButton || p.actions.some((a) => /^message$/i.test(String(a).trim()));
    if (p.actions.length > 0 && hasMessage) return { status: 'accepted', code: cs.code };
    return { status: 'unclear', code: 'first_degree_without_message' };
  }
  if (cs.code === 'connect_available') return { status: 'not_accepted', code: 'connect_available' };
  return { status: 'unclear', code: cs.code };
}

export async function checkNextAccepted(io: AcceptIo, deps: AcceptDeps): Promise<AcceptResult> {
  const { db, env, now, state } = deps;
  const left = (): number => {
    try { return Math.max(0, Math.min(ACCEPT_CHECK_MAX_PER_WAKE - state.checked, listAcceptCandidates(db, now(), state.tried).length)); } catch { return 0; }
  };
  try {
    if (deps.killed?.() || haltReason(db, 'linkedin')) return { status: 'halted', code: 'halted', remaining: 0 };
  } catch {
    return { status: 'failed', code: 'halt_state_unreadable', remaining: 0 };
  }
  if (state.checked >= ACCEPT_CHECK_MAX_PER_WAKE) return { status: 'rate_limited', code: 'per_wake_limit', remaining: 0 };
  const next = listAcceptCandidates(db, now(), state.tried)[0];
  if (!next) return { status: 'none', code: 'no_candidate', remaining: 0 };
  if (isDryRun(env)) {
    state.tried.add(next.key);
    recordDryRun(db, { runId: null, action: 'linkedin_check_accepted', platform: 'linkedin', payload: { profile: next.key } }, now(), env);
    return { status: 'dry_run', code: 'dry_run', remaining: left() };
  }
  if (state.checked > 0) {
    const rnd = deps.random ?? Math.random;
    const ms = ACCEPT_PACE_MIN_MS + Math.floor(rnd() * (ACCEPT_PACE_MAX_MS - ACCEPT_PACE_MIN_MS));
    await (deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }
  state.tried.add(next.key);
  const r = await io.open(next.profile_url);
  if (!r.ok) {
    if (r.code === 'halted') return { status: 'halted', code: 'halted', remaining: 0 };
    stampAcceptChecked(db, next.profile_url, now());
    state.checked += 1;
    return { status: 'failed', code: r.code, remaining: left() };
  }
  state.checked += 1;
  stampAcceptChecked(db, next.profile_url, now());
  const snap = r.snapshot;
  if (!verifyProfileUrl(next.profile_url, snap.url).ok) return { status: 'failed', code: 'profile_url_mismatch', remaining: left() };
  if (!snap.profile) return { status: 'unclear', code: 'no_profile', remaining: left() };
  const d = decideAccepted(snap.profile);
  if (d.status === 'accepted') markConnectionAccepted(db, next.profile_url, now());
  return { status: d.status, code: d.code, remaining: left() };
}
