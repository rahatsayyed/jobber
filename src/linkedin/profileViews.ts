// Daily ceiling `linkedin_profile_view` (LINKEDIN_MAX_PROFILE_VIEWS_PER_DAY, rolling 24 hours): every
// navigation of the main-account session to a /in/ profile page is charged here, right before the
// page is opened. The two choke points are the linkedin_open handler (src/mcp/linkedin.ts, which
// covers both the runtime and the engine path) and the accepted-invite check. A view that is refused
// is never opened. Reads only decide; dry run and halts are handled by their own gates, unchanged.
import type BetterSqlite3 from 'better-sqlite3';
import { loadOutreachConfig } from '../outreach/config.js';
import { tryConsume } from '../outreach/limits.js';
import { isProfileUrl } from './urls.js';

export const PROFILE_VIEW_LIMIT_CODE = 'profile_view_limit';

/** true: the view may go ahead (and was counted); false: the daily ceiling is used up. A non-profile URL is free. */
export function consumeProfileView(db: BetterSqlite3.Database, env: NodeJS.ProcessEnv, now: Date, url: string): boolean {
  if (!isProfileUrl(url)) return true;
  try {
    return tryConsume(db, 'linkedin_profile_view', loadOutreachConfig(env), now);
  } catch {
    // Counter unreadable: fail closed for the platform, like the other ceilings.
    return false;
  }
}
