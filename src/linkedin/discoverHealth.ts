// Zero-card detection for the LinkedIn search tools. A search page that really has results can never legitimately
// give 0 cards, so 0 cards is split in two: a REAL empty page (explicit "no results" wording) and a BROKEN parse
// (the page shows job or post links, or a lot of text, and no card was built). A broken parse is a failure, never
// "ok / no_new": it keeps a consecutive-failure streak per tool and search in `scheduler_state` (shown by
// `npm run status -- health`). The result carries a compact page summary so the linkedin-operator (a model) can
// diagnose and heal first (scroll, wait, dismiss an overlay, retry). The owner is alerted only for CRITICAL things:
// a logged-out or guest page, a bot wall (see runtime.afterNavigation), or a broken parse that stays broken for
// SUSTAINED_MS despite the semantic fallback and the operator's retries. Each critical key alerts at most once per hour.
import type BetterSqlite3 from 'better-sqlite3';
import { getState, setState } from '../scheduler/runLog.js';
import { b, code, E, headline, html, lines, line } from '../platform/tgHtml.js';
import type { Notifier } from '../platform/notify.js';
import type { RawSnapshot } from './types.js';

export const BROKEN_CODE = 'no_cards_parse_drift';
export const BROKEN_PREFIX = 'li_discover_broken:';
const ALERT_PREFIX = 'li_discover_alert:';
export const ALERT_EVERY_MS = 3600_000;
/** A streak this long is shown as a problem in `status health`. */
export const STREAK_ALERT_AT = 3;
/** Visible text above which a page with no cards and no empty-state wording is treated as a broken parse. */
export const SUBSTANTIAL_TEXT_CHARS = 1500;

const EMPTY_STATE =
  /\b(?:no (?:matching )?(?:jobs?|results?|posts?|content)(?: (?:found|match))?|we (?:could not|couldn['’]t|didn['’]t) find|did not match any|0 results|no results (?:found|for))\b/i;

/** A broken parse that lasted this long with no good read in between is critical. */
export const SUSTAINED_MS = 24 * 3600_000;
const GUEST_WALL =
  /\b(?:sign in to (?:view|see|continue)|join now to see|join linkedin|new to linkedin\??|already on linkedin\??\s*sign in|see who you already know|continue to sign in)\b/i;

/** Compact, gated-by-the-caller page summary a model can read to decide what to do next. Page text is untrusted. */
export interface PageSummary {
  headings: string[];
  job_links: number;
  post_links: number;
  dialog: string | null;
  notices: string[];
  login_wall: boolean;
  guest_hint: string | null;
  body_chars: number;
}

export function guestHint(snap: RawSnapshot): string | null {
  if (snap.hasPasswordInput) return 'password field on the page';
  const m = GUEST_WALL.exec(`${snap.title}\n${snap.dialogText ?? ''}\n${snap.bodyText.slice(0, 6000)}`);
  return m ? m[0].toLowerCase() : null;
}

export function pageSummary(snap: RawSnapshot, clean: (s: string, max: number) => string): PageSummary {
  const hint = guestHint(snap);
  return {
    headings: (snap.headings ?? []).slice(0, 8).map((h) => clean(h, 80)).filter(Boolean),
    job_links: snap.linkEvidence?.jobs ?? 0,
    post_links: snap.linkEvidence?.posts ?? 0,
    dialog: snap.dialogText ? clean(snap.dialogText, 200) || null : null,
    notices: snap.notices.slice(0, 3).map((n) => clean(n, 120)).filter(Boolean),
    login_wall: hint !== null,
    guest_hint: hint,
    body_chars: snap.bodyText.length,
  };
}

export type ZeroKind ='real_empty' | 'broken';

/** Classify a search page that produced 0 cards. Evidence: explicit empty-state text first, then links, then text volume. */
export function classifyZeroCards(snap: RawSnapshot): ZeroKind {
  if (EMPTY_STATE.test(snap.bodyText)) return 'real_empty';
  const ev = snap.linkEvidence;
  if (ev && ev.jobs + ev.posts > 0) return 'broken';
  if (snap.bodyText.length >= SUBSTANTIAL_TEXT_CHARS) return 'broken';
  return 'real_empty';
}

export interface Streak { count: number; since: string; last_at: string; search: string; diag: string | null }

const keyOf = (tool: string, search: string) => `${BROKEN_PREFIX}${tool}:${search}`;

export function readStreak(db: BetterSqlite3.Database, tool: string, search: string): Streak | null {
  try {
    const raw = getState(db, keyOf(tool, search));
    return raw ? (JSON.parse(raw) as Streak) : null;
  } catch {
    return null;
  }
}

/** Count one more broken parse for this tool and search; returns the new streak. */
export function bumpStreak(db: BetterSqlite3.Database, tool: string, search: string, now: Date, diag: string | null): Streak {
  const prev = readStreak(db, tool, search);
  const next: Streak = {
    count: (prev?.count ?? 0) + 1, since: prev?.since ?? now.toISOString(), last_at: now.toISOString(), search,
    diag: diag ?? prev?.diag ?? null,
  };
  setState(db, keyOf(tool, search), JSON.stringify(next), now);
  return next;
}

export function clearStreak(db: BetterSqlite3.Database, tool: string, search: string): void {
  try { db.prepare('DELETE FROM scheduler_state WHERE key = ?').run(keyOf(tool, search)); } catch { /* best effort */ }
}

/** Every open broken-parse streak, for `status health`. */
export function listStreaks(db: BetterSqlite3.Database): Array<Streak & { tool: string }> {
  try {
    const rows = db.prepare('SELECT key, value FROM scheduler_state WHERE key LIKE ?').all(`${BROKEN_PREFIX}%`) as Array<{ key: string; value: string }>;
    const out: Array<Streak & { tool: string }> = [];
    for (const r of rows) {
      try {
        const s = JSON.parse(r.value) as Streak;
        out.push({ ...s, tool: r.key.slice(BROKEN_PREFIX.length).split(':')[0] });
      } catch { /* skip an unreadable row */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Owner alert text (Telegram HTML), no page text: tool, search, streak, since, diag path. */
export function brokenAlertHtml(tool: string, s: Streak, layout: string): string {
  return html(lines([
    headline(E.fail, `LinkedIn ${tool === 'search_jobs' ? 'job' : 'post'} search is not reading any cards`),
    line('search', code(s.search)),
    line('failed in a row', `${s.count} (since ${s.since.slice(0, 16).replace('T', ' ')} UTC)`),
    line('layout', code(layout)),
    s.diag ? line('evidence', code(s.diag)) : null,
    b('The page has results but 0 cards were parsed. Nothing is being discovered from it.'),
  ]));
}

/** Critical alert text for a logged-out, guest or blocked LinkedIn page (no page text). */
export function sessionAlertHtml(what: string, where: string): string {
  return html(lines([
    headline(E.fail, 'LinkedIn needs you: session problem'),
    line('what', code(what)),
    line('page', code(where)),
    b('LinkedIn work is stopped until you log in again (npm run linkedin:login).'),
  ]));
}

/** Send a CRITICAL alert unless one with this key went out in the last hour. Never throws. */
export async function criticalAlert(
  db: BetterSqlite3.Database, notify: Notifier | undefined, key: string, text: string, now: Date,
): Promise<boolean> {
  if (!notify) return false;
  try {
    const last = Date.parse(getState(db, ALERT_PREFIX + key) ?? '');
    if (Number.isFinite(last) && now.getTime() - last < ALERT_EVERY_MS) return false;
    const r = await notify.send(text, { topic: 'alerts', html: true, silent: false });
    if (r.ok) setState(db, ALERT_PREFIX + key, now.toISOString(), now);
    return r.ok;
  } catch {
    return false;
  }
}

/** True when the streak has been broken for SUSTAINED_MS with no good read in between. */
export const isSustained = (s: Streak, now: Date): boolean => now.getTime() - Date.parse(s.since) >= SUSTAINED_MS;

/** Alert only a sustained broken parse (the system and the operator had 24h to heal it). */
export const maybeAlert = (
  db: BetterSqlite3.Database, notify: Notifier | undefined, tool: string, s: Streak, layout: string, now: Date,
): Promise<boolean> => (isSustained(s, now) ? criticalAlert(db, notify, `sustained:${tool}`, brokenAlertHtml(tool, s, layout), now) : Promise.resolve(false));
