// src/scheduler/due.ts
import type BetterSqlite3 from 'better-sqlite3';
import { dueTouchesFor } from '../outreach/dueTouches.js';
import { normalizeProfileKey } from '../outreach/people.js';
import { TUNING_DEFAULTS, type Tuning } from '../outreach/tuning.js';
import type { Platform } from './control.js';
import { getState } from './runLog.js';

type Db = BetterSqlite3.Database;

export interface DueCounts {
  followupsDue: number;
  newOutreachReady: number;
  followupsDueByPlatform: Record<Platform, number>;
  newOutreachReadyByPlatform: Record<Platform, number>;
  inboxLastCheckedMinAgo: number | null;
  naukriSearchLastHoursAgo: number | null;
}

// null when the key was never set; 0 (ran just now, so not due) when the stored value is unparseable.
function agoMs(db: Db, key: string, now: Date): number | null {
  const v = getState(db, key);
  if (!v) return null;
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, now.getTime() - t);
}

/**
 * followupsDue comes from dueTouchesFor (derived, no stored next_due_at; excludes people with an
 * in-flight touch).
 * newOutreachReady is the number of distinct people/profiles with queued work, deduplicated:
 *  - touches with status 'queued' (keyed platform + people.profile_key), plus
 *  - outreach_queue rows with status='queued', connect_profile_url and connect_note set,
 *    connect_status NULL or 'queued', job not excluded (keyed linkedin + normalized URL).
 * Email-only and apply-only rows are not counted. Counts are also split per platform.
 */
export function countDue(db: Db, now: Date, tuning: Tuning = TUNING_DEFAULTS): DueCounts {
  const zero = (): Record<Platform, number> => ({ linkedin: 0, naukri: 0 });
  const followupsDueByPlatform = zero();
  for (const t of dueTouchesFor(db, now, tuning)) {
    if (t.platform in followupsDueByPlatform) followupsDueByPlatform[t.platform as Platform]++;
  }
  const seen = new Set<string>();
  const newByPlatform = zero();
  const add = (platform: string, key: string): void => {
    if (!(platform in newByPlatform)) return;
    const k = `${platform}:${key}`;
    if (seen.has(k)) return;
    seen.add(k);
    newByPlatform[platform as Platform]++;
  };
  const queuedTouches = db
    .prepare(
      `SELECT DISTINCT p.platform, p.profile_key FROM touches t JOIN people p ON p.id = t.person_id
        WHERE t.status = 'queued'`,
    )
    .all() as { platform: string; profile_key: string }[];
  for (const r of queuedTouches) add(r.platform, normalizeProfileKey(r.profile_key));
  const rows = db
    .prepare(
      `SELECT q.connect_profile_url AS url FROM outreach_queue q
        WHERE q.status = 'queued'
          AND q.connect_profile_url IS NOT NULL AND q.connect_note IS NOT NULL
          AND (q.connect_status IS NULL OR q.connect_status = 'queued')
          AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = q.job_id AND j.excluded_reason IS NULL)`,
    )
    .all() as { url: string }[];
  for (const r of rows) add('linkedin', normalizeProfileKey(r.url));
  const sum = (r: Record<Platform, number>): number => r.linkedin + r.naukri;
  const inbox = agoMs(db, 'inbox_last_checked_at', now);
  const naukri = agoMs(db, 'naukri_search_last_at', now);
  return {
    followupsDue: sum(followupsDueByPlatform),
    newOutreachReady: sum(newByPlatform),
    followupsDueByPlatform,
    newOutreachReadyByPlatform: newByPlatform,
    inboxLastCheckedMinAgo: inbox === null ? null : Math.floor(inbox / 60000),
    naukriSearchLastHoursAgo: naukri === null ? null : naukri / 3600000,
  };
}
