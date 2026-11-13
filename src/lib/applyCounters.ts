// Per-platform daily apply counters (calendar day, UTC like every `daily_counters` row).
//
// Before this module one row, key `easy_apply`, was shared by LinkedIn Easy Apply, Naukri native Apply, Wellfound
// native Apply and the browser (ATS) applier, so Naukri applies used up the LinkedIn room. Now:
//   easy_apply_linkedin  -> LinkedIn Easy Apply    (limit: LINKEDIN_MAX_EASY_APPLIES_PER_DAY)
//   easy_apply_naukri    -> Naukri native Apply    (limit: NAUKRI_MAX_APPLIES_PER_DAY)
//   easy_apply_wellfound -> Wellfound native Apply (limit: WELLFOUND_MAX_APPLIES_PER_DAY)
//   easy_apply (legacy)  -> the browser (ATS) applier only (limit: MAX_APPLIES_PER_DAY, unchanged there)
// Each platform path reads and increments only its own key. The rolling 24 hour ceilings in `rate_events`
// (linkedin_easy_apply, naukri_apply, wellfound_apply) are unchanged and still checked beside these counters.
import type BetterSqlite3 from 'better-sqlite3';
import { checkAndIncrement } from './rateLimit.js';

export type ApplyCounterPlatform = 'linkedin' | 'naukri' | 'wellfound';

export const APPLY_COUNTER_KEY: Record<ApplyCounterPlatform, string> = {
  linkedin: 'easy_apply_linkedin',
  naukri: 'easy_apply_naukri',
  wellfound: 'easy_apply_wellfound',
};

/** The legacy shared key; after this change only the browser (ATS) applier consumes it. */
export const LEGACY_APPLY_COUNTER_KEY = 'easy_apply';

/** The rolling ceiling key (rate_events) that is consumed together with each platform counter. */
const RATE_EVENT_KEY: Record<ApplyCounterPlatform, string> = {
  linkedin: 'linkedin_easy_apply',
  naukri: 'naukri_apply',
  wellfound: 'wellfound_apply',
};

/**
 * Makes sure today's row of the platform counter exists. A missing row is seeded from the number of ceiling events
 * recorded today (UTC day) for that platform, which is exactly what the counter would hold: this covers the first day
 * after the deploy (the old shared row is never copied, so a Naukri apply is not charged to LinkedIn and nobody can
 * exceed a cap because of the switch). INSERT OR IGNORE: an existing row is never touched. Call it BEFORE the
 * ceiling event of the same apply is recorded, otherwise that event would be counted twice.
 */
export function seedApplyCounter(db: BetterSqlite3.Database, platform: ApplyCounterPlatform): void {
  db.prepare("INSERT OR IGNORE INTO daily_counters (day, key, count) VALUES (date('now'), ?, ?)").run(APPLY_COUNTER_KEY[platform], eventsToday(db, platform));
}

function eventsToday(db: BetterSqlite3.Database, platform: ApplyCounterPlatform): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND substr(at, 1, 10) = date('now')").get(RATE_EVENT_KEY[platform]) as { n: number }).n;
}

/**
 * Today's count of one platform's apply counter. Read only (safe in read-only tools): with no row yet it returns what
 * seedApplyCounter would store. Callers treat a throw as no room (fail-safe).
 */
export function applyCounterUsed(db: BetterSqlite3.Database, platform: ApplyCounterPlatform): number {
  const row = db.prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?").get(APPLY_COUNTER_KEY[platform]) as { count: number } | undefined;
  return row ? row.count : eventsToday(db, platform);
}

/** Atomic check and increment of one platform's counter against its own limit. Seed (seedApplyCounter) before the ceiling event. */
export function consumeApplyCounter(db: BetterSqlite3.Database, platform: ApplyCounterPlatform, limit: number): boolean {
  return checkAndIncrement(db, APPLY_COUNTER_KEY[platform], limit);
}

/** Today's count of the legacy key (the browser/ATS applier). */
export function atsApplyUsed(db: BetterSqlite3.Database): number {
  const row = db.prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?").get(LEGACY_APPLY_COUNTER_KEY) as { count: number } | undefined;
  return row?.count ?? 0;
}
