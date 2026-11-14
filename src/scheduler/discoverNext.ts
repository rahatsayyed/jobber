// When the next LinkedIn discovery run is due: roughly hourly, with a random delay so the runs are never at exact hours.
// Stored in scheduler_state like the mail drip stores its next tick (a restart never resets the spacing).
import { getState, setState } from './runLog.js';

type Db = Parameters<typeof getState>[0];

export const LAST_KEY = 'linkedin_discover_last_at';
export const NEXT_KEY = 'linkedin_discover_next_at';
/** Random delay after a finished run, uniform between these bounds (constants, no env key). */
export const DISCOVER_MIN_GAP_MIN = 45;
export const DISCOVER_MAX_GAP_MIN = 90;
/** Used when the last run is known but no next time is stored (an older state). */
export const DISCOVER_FALLBACK_GAP_MIN = 60;

/** Uniform delay in whole milliseconds in [min, max] minutes; `rng` returns [0, 1) and is injectable for tests. */
export function discoverGapMs(rng: () => number = Math.random): number {
  const span = DISCOVER_MAX_GAP_MIN - DISCOVER_MIN_GAP_MIN;
  const r = Math.min(Math.max(rng(), 0), 0.999999999);
  return Math.round((DISCOVER_MIN_GAP_MIN + r * span) * 60000);
}

/** Records a finished run: last_at = now, next_at = now + a random 45 to 90 minutes. */
export function recordDiscoverRun(db: Db, now: Date, rng: () => number = Math.random): void {
  setState(db, LAST_KEY, now.toISOString(), now);
  setState(db, NEXT_KEY, new Date(now.getTime() + discoverGapMs(rng)).toISOString(), now);
}

/**
 * Is a LinkedIn discovery run due? Order: stored next_at; else last_at + 60 minutes; neither stored = due now
 * (the owner clearing both markers makes it due). An unparseable value reads as "just ran" (not due), like the other markers.
 */
export function linkedinDiscoverDue(db: Db, now: Date): boolean {
  const next = getState(db, NEXT_KEY);
  if (next) {
    const t = Date.parse(next);
    return Number.isNaN(t) ? false : now.getTime() >= t;
  }
  const last = getState(db, LAST_KEY);
  if (!last) return true;
  const t = Date.parse(last);
  return Number.isNaN(t) ? false : now.getTime() >= t + DISCOVER_FALLBACK_GAP_MIN * 60000;
}
