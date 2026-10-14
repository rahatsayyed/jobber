// src/scheduler/due.ts
import type BetterSqlite3 from 'better-sqlite3';
import { dueTouchesFor } from '../outreach/dueTouches.js';
import { TUNING_DEFAULTS, type Tuning } from '../outreach/tuning.js';
import { getState } from './runLog.js';

type Db = BetterSqlite3.Database;

export interface DueCounts {
  followupsDue: number;
  newOutreachReady: number;
  inboxLastCheckedMinAgo: number | null;
  naukriSearchLastHoursAgo: number | null;
}

function agoMs(db: Db, key: string, now: Date): number | null {
  const v = getState(db, key);
  if (!v) return null;
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, now.getTime() - t);
}

/**
 * followupsDue comes from dueTouchesFor (derived, no stored next_due_at).
 * newOutreachReady SQL: outreach_queue rows still queued whose job is not excluded and which carry
 * a pending connect (connect_profile_url and connect_note set, connect_status NULL or 'queued').
 * Email-only and apply-only rows are not counted.
 */
export function countDue(db: Db, now: Date, tuning: Tuning = TUNING_DEFAULTS): DueCounts {
  const followupsDue = dueTouchesFor(db, now, tuning).length;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM outreach_queue q
        WHERE q.status = 'queued'
          AND q.connect_profile_url IS NOT NULL AND q.connect_note IS NOT NULL
          AND (q.connect_status IS NULL OR q.connect_status = 'queued')
          AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = q.job_id AND j.excluded_reason IS NULL)`,
    )
    .get() as { n: number };
  const inbox = agoMs(db, 'inbox_last_checked_at', now);
  const naukri = agoMs(db, 'naukri_search_last_at', now);
  return {
    followupsDue,
    newOutreachReady: row.n,
    inboxLastCheckedMinAgo: inbox === null ? null : Math.floor(inbox / 60000),
    naukriSearchLastHoursAgo: naukri === null ? null : naukri / 3600000,
  };
}
