// A failure must always carry a reason. Terminal non-success states are stored with a machine reason code (`external:no_popup`,
// `open_failed:nav_timeout`, `overlay_unknown:<title>`) and an optional short human detail. When the caller gives none, code stores
// `unspecified:<operator>:<run_id>` AND counts a defect (daily counter) with an alert-level line, so the gap is visible and not blank.
import type BetterSqlite3 from 'better-sqlite3';

/** apply_status values that end an application without success and so need a reason. */
export const APPLY_FAIL_STATUSES: ReadonlySet<string> = new Set(['failed', 'manual_review', 'needs_owner', 'needs_human', 'needs_answer', 'closed']);
/** email_status, connect_status and overall status values that need a reason. */
export const OTHER_FAIL_STATUSES: ReadonlySet<string> = new Set(['failed']);
export const DEFECT_COUNTER_KEY = 'defect:failure_without_reason';
export const LEGACY_REASON = 'legacy:unknown';

export function needsReason(field: string, value: string): boolean {
  return field === 'apply_status' ? APPLY_FAIL_STATUSES.has(value) : OTHER_FAIL_STATUSES.has(value);
}

const clean = (s: string | undefined | null, max: number): string => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The text stored for a failure: `<code>` or `<code> - <detail>`; empty when the caller gave no code. */
export function composeReason(reason?: string | null, detail?: string | null): string {
  const code = clean(reason, 120);
  if (!code) return '';
  const d = clean(detail, 200);
  return d ? `${code} - ${d}` : code;
}

/** The fallback code when nobody gave a reason. */
export function unspecifiedReason(operator?: string | null, runId?: string | null): string {
  const op = clean(operator, 40).replace(/[^A-Za-z0-9_-]/g, '') || 'unknown';
  const run = clean(runId, 60).replace(/[^A-Za-z0-9_-]/g, '') || 'norun';
  return `unspecified:${op}:${run}`;
}

/** Counts one defect (a failure written without a reason) and prints one alert-level line. Never throws. */
export function recordMissingReason(db: BetterSqlite3.Database, what: string, stored: string): void {
  try {
    db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), ?, 1) ON CONFLICT(day, key) DO UPDATE SET count = count + 1").run(DEFECT_COUNTER_KEY);
  } catch { /* the counter is advisory */ }
  try { console.error(`[ALERT] defect: ${what} written without a reason, stored as ${stored}`); } catch { /* ignore */ }
}

/** Defects counted today (for status output). */
export function missingReasonCountToday(db: BetterSqlite3.Database): number {
  try {
    const r = db.prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?").get(DEFECT_COUNTER_KEY) as { count: number } | undefined;
    return r?.count ?? 0;
  } catch { return 0; }
}

export interface BackfillResult { applyRows: number; emailRows: number; connectRows: number; followups: number }

// One-off, idempotent: rows already failed or in a manual state with an empty reason get `legacy:unknown`, so no screen shows blank.
// A row that already has a reason is never touched; a second run changes nothing. `dry` only counts.
export function backfillLegacyReasons(db: BetterSqlite3.Database, opts: { dry?: boolean } = {}): BackfillResult {
  const blank = (c: string): string => `(${c} IS NULL OR TRIM(${c}) = '')`;
  const applyWhere = `apply_status IN ('failed', 'manual_review') AND ${blank('apply_note')}`;
  const emailWhere = `email_status = 'failed' AND ${blank('status_reason')}`;
  const connectWhere = `connect_status = 'failed' AND ${blank('status_reason')}`;
  const fuWhere = `status = 'failed' AND ${blank('fail_reason')}`;
  const count = (t: string, w: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${w}`).get() as { n: number }).n;
  const out: BackfillResult = {
    applyRows: count('outreach_queue', applyWhere), emailRows: count('outreach_queue', emailWhere),
    connectRows: count('outreach_queue', connectWhere), followups: count('followups', fuWhere),
  };
  if (opts.dry) return out;
  db.transaction(() => {
    db.prepare(`UPDATE outreach_queue SET apply_note = ? WHERE ${applyWhere}`).run(LEGACY_REASON);
    db.prepare(`UPDATE outreach_queue SET status_reason = ? WHERE ${emailWhere}`).run(LEGACY_REASON);
    db.prepare(`UPDATE outreach_queue SET status_reason = ? WHERE ${connectWhere}`).run(LEGACY_REASON);
    db.prepare(`UPDATE followups SET fail_reason = ? WHERE ${fuWhere}`).run(LEGACY_REASON);
  })();
  return out;
}
