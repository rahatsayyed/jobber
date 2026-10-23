// src/outreach/limits.ts
import type BetterSqlite3 from 'better-sqlite3';
import type { OutreachConfig } from './config.js';

type Db = BetterSqlite3.Database;

export type LimitKey =
  | 'linkedin_invite' | 'linkedin_message' | 'naukri_apply' | 'naukri_message'
  | 'wellfound_apply' | 'wellfound_message' | 'wellfound_discover'
  | 'apply_attempt' | 'site_account' | 'linkedin_discover';

const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;

const WINDOW_MS: Record<LimitKey, number> = {
  linkedin_invite: WEEK_MS,
  linkedin_message: WEEK_MS,
  naukri_apply: DAY_MS,
  naukri_message: DAY_MS,
  wellfound_apply: DAY_MS,
  wellfound_message: DAY_MS,
  wellfound_discover: DAY_MS,
  apply_attempt: DAY_MS,
  site_account: DAY_MS,
  linkedin_discover: DAY_MS,
};

function limitFor(key: LimitKey, cfg: OutreachConfig): number {
  switch (key) {
    case 'linkedin_invite':
      return cfg.linkedinMaxInvitesPerWeek;
    case 'linkedin_message':
      return cfg.linkedinMaxMessagesPerWeek;
    case 'naukri_apply':
      return cfg.naukriMaxAppliesPerDay;
    case 'naukri_message':
      return cfg.naukriMaxMessagesPerDay;
    case 'wellfound_apply':
      return cfg.wellfoundMaxAppliesPerDay;
    case 'wellfound_message':
      return cfg.wellfoundMaxMessagesPerDay;
    case 'wellfound_discover':
      return cfg.wellfoundMaxDiscoverPerDay;
    case 'apply_attempt':
      return cfg.applyMaxAttemptsPerDay;
    case 'site_account':
      return cfg.siteMaxAccountsPerDay;
    case 'linkedin_discover':
      return cfg.linkedinMaxDiscoverPerDay;
  }
}

export function recordEvent(db: Db, key: LimitKey, at: Date): void {
  db.prepare('INSERT INTO rate_events (key, at) VALUES (?, ?)').run(key, at.toISOString());
}

export function countSince(db: Db, key: LimitKey, since: Date): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND at > ?')
    .get(key, since.toISOString()) as { n: number };
  return row.n;
}

export interface CeilingStatus {
  used: number;
  limit: number;
  ok: boolean;
}

export function ceilings(db: Db, cfg: OutreachConfig, now: Date): Record<LimitKey, CeilingStatus> {
  const out = {} as Record<LimitKey, CeilingStatus>;
  for (const key of Object.keys(WINDOW_MS) as LimitKey[]) {
    const used = countSince(db, key, new Date(now.getTime() - WINDOW_MS[key]));
    const limit = limitFor(key, cfg);
    out[key] = { used, limit, ok: used < limit };
  }
  return out;
}

export function tryConsume(db: Db, key: LimitKey, cfg: OutreachConfig, now: Date): boolean {
  const run = db.transaction((): boolean => {
    const used = countSince(db, key, new Date(now.getTime() - WINDOW_MS[key]));
    if (used >= limitFor(key, cfg)) return false;
    recordEvent(db, key, now);
    return true;
  });
  return run.immediate();
}

export function haltPlatform(db: Db, platform: string, reason: string, at: Date): void {
  db.prepare(
    `INSERT INTO halt_flags (platform, reason, set_at, cleared_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(platform) DO UPDATE SET reason = excluded.reason, set_at = excluded.set_at, cleared_at = NULL`,
  ).run(platform, reason, at.toISOString());
}

export function clearHalt(db: Db, platform: string, at: Date): void {
  db.prepare('UPDATE halt_flags SET cleared_at = ? WHERE platform = ?').run(at.toISOString(), platform);
}

function activeReason(db: Db, platform: string): string | null {
  const row = db
    .prepare('SELECT reason FROM halt_flags WHERE platform = ? AND cleared_at IS NULL')
    .get(platform) as { reason: string } | undefined;
  return row ? row.reason : null;
}

// For a platform other than all, the global all halt applies too: own reason first, then all.
export function haltReason(db: Db, platform: string): string | null {
  const own = activeReason(db, platform);
  if (platform === 'all') return own;
  return own ?? activeReason(db, 'all');
}
