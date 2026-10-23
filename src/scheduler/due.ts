// src/scheduler/due.ts
import type BetterSqlite3 from 'better-sqlite3';
import { MATCH_FAIL_LIMIT } from '../db.js';
import { planPipelineWork } from '../pipelineWork.js';
import { followupMode, listApprovedFollowups, listFollowupCandidates } from '../followups.js';
import { manualRequestsPending } from '../manual/requests.js';
import { dueTouchesFor } from '../outreach/dueTouches.js';
import { normalizeProfileKey } from '../outreach/people.js';
import { TUNING_DEFAULTS, type Tuning } from '../outreach/tuning.js';
import type { Platform } from './control.js';
import { getState } from './runLog.js';

type Db = BetterSqlite3.Database;

/** Platforms with followup and new-outreach work counted by the db. Wellfound has none: it only discovers, reads its inbox and applies. */
export type DuePlatform = Exclude<Platform, 'wellfound'>;

export interface DueCounts {
  followupsDue: number;
  newOutreachReady: number;
  followupsDueByPlatform: Record<DuePlatform, number>;
  newOutreachReadyByPlatform: Record<DuePlatform, number>;
  inboxLastCheckedMinAgo: number | null;
  naukriSearchLastHoursAgo: number | null;
  /** Hours since the last Wellfound discovery run (set by the discover tool); null when never, undefined: not tracked (never due). */
  wellfoundDiscoverLastHoursAgo?: number | null;
  /** Hours since the last LinkedIn discovery run (set by the discovery tools); null when never. */
  linkedinDiscoverLastHoursAgo?: number | null;
  /** Hours since the last code pass over the script providers; null when never, undefined: not tracked (never due). */
  scriptDiscoverLastHoursAgo?: number | null;
  /** Queued source_tasks an agent operator can work (the daily dead-slug `error` rows of single companies are noise and not counted). */
  sourceTasksQueued?: number;
  /** Jobs saved but not scored yet and not excluded: the pipeline's input. */
  unmatchedJobs?: number;
  /** Queued outreach rows with an email not yet sent. */
  emailQueued?: number;
  /** Email follow-ups the mail-operator may act on: approved rows, plus (autonomous mode only) drafted rows and candidates. */
  emailFollowupsReady?: number;
  /** Queued apply rows (apply_platform set and not none, apply not yet attempted, job not excluded). */
  applyQueued?: number;
  /** MAX_APPLIES_PER_DAY minus today's easy_apply counter, never below 0. */
  appliesLeftToday?: number;
  /** Owner-submitted manual requests not yet ingested (status pending): a wake is planned for them even when nothing else is due. */
  manualRequestsPending?: number;
}

// Same parsing as the apply tools: a non-negative integer, otherwise 5.
function maxAppliesPerDay(env: NodeJS.ProcessEnv): number {
  const raw = env.MAX_APPLIES_PER_DAY;
  return raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 5;
}

/** scheduler_state key set after each code pass over the script providers. */
export const SCRIPT_DISCOVER_KEY = 'script_discover_last_at';

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
export function countDue(db: Db, now: Date, tuning: Tuning = TUNING_DEFAULTS, env: NodeJS.ProcessEnv = process.env): DueCounts {
  const zero = (): Record<DuePlatform, number> => ({ linkedin: 0, naukri: 0 });
  const followupsDueByPlatform = zero();
  for (const t of dueTouchesFor(db, now, tuning)) {
    if (t.platform in followupsDueByPlatform) followupsDueByPlatform[t.platform as DuePlatform]++;
  }
  const seen = new Set<string>();
  const newByPlatform = zero();
  const add = (platform: string, key: string): void => {
    if (!(platform in newByPlatform)) return;
    const k = `${platform}:${key}`;
    if (seen.has(k)) return;
    seen.add(k);
    newByPlatform[platform as DuePlatform]++;
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
  const applyQueued = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT q.job_id) AS n FROM outreach_queue q
          WHERE q.status = 'queued'
            AND q.apply_platform IS NOT NULL AND q.apply_platform <> 'none'
            AND (? = 1 OR q.apply_platform <> 'linkedin_easy')
            AND (q.apply_status IS NULL OR q.apply_status = 'queued')
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = q.job_id AND j.excluded_reason IS NULL)`,
      )
      .get(env.APPLY_LINKEDIN_EASY === 'true' ? 1 : 0) as { n: number }
  ).n;
  const usedToday =
    (
      db.prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = 'easy_apply'").get() as
        | { count: number }
        | undefined
    )?.count ?? 0;
  const appliesLeftToday = Math.max(0, maxAppliesPerDay(env) - usedToday);
  const sum = (r: Record<DuePlatform, number>): number => r.linkedin + r.naukri;
  const inbox = agoMs(db, 'inbox_last_checked_at', now);
  const naukri = agoMs(db, 'naukri_search_last_at', now);
  const wellfound = agoMs(db, 'wellfound_discover_last_at', now);
  const discover = agoMs(db, 'linkedin_discover_last_at', now);
  const script = agoMs(db, SCRIPT_DISCOVER_KEY, now);
  const n = (sql: string): number => {
    try {
      return (db.prepare(sql).get() as { n: number }).n;
    } catch {
      return 0;
    }
  };
  // Same window, duplicate and repeated-contact rules as db.list_unscored_jobs (read-only here: nothing is marked).
  let unmatchedJobs = 0;
  try {
    unmatchedJobs = planPipelineWork(db, { now, failLimit: MATCH_FAIL_LIMIT }).offer.length;
  } catch {
    // counts are advisory
  }
  let emailFollowupsReady = 0;
  try {
    emailFollowupsReady = listApprovedFollowups(db).length;
    if (followupMode(env) === 'autonomous') {
      emailFollowupsReady += n("SELECT COUNT(*) AS n FROM followups WHERE status = 'drafted'");
      emailFollowupsReady += listFollowupCandidates(db, now).length;
    }
  } catch {
    // counts are advisory
  }
  return {
    followupsDue: sum(followupsDueByPlatform),
    newOutreachReady: sum(newByPlatform),
    followupsDueByPlatform,
    newOutreachReadyByPlatform: newByPlatform,
    inboxLastCheckedMinAgo: inbox === null ? null : Math.floor(inbox / 60000),
    naukriSearchLastHoursAgo: naukri === null ? null : naukri / 3600000,
    wellfoundDiscoverLastHoursAgo: wellfound === null ? null : wellfound / 3600000,
    linkedinDiscoverLastHoursAgo: discover === null ? null : discover / 3600000,
    scriptDiscoverLastHoursAgo: script === null ? null : script / 3600000,
    sourceTasksQueued: n("SELECT COUNT(*) AS n FROM source_tasks WHERE state = 'queued' AND NOT (reason = 'error' AND company IS NOT NULL)"),
    unmatchedJobs,
    emailQueued: n(
      `SELECT COUNT(*) AS n FROM outreach_queue q
        WHERE q.status = 'queued' AND q.email_to IS NOT NULL AND (q.email_status IS NULL OR q.email_status = 'queued')
          AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = q.job_id AND j.excluded_reason IS NULL)`,
    ),
    emailFollowupsReady,
    applyQueued,
    appliesLeftToday,
    manualRequestsPending: manualRequestsPending(db),
  };
}
