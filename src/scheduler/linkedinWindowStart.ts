// src/scheduler/linkedinWindowStart.ts
// The `linkedin` window reads its environment once, when its claude starts (scripts/window-env.ts). These are the values that
// matter for safety or caps and can change in .env later: the dry-run flag, the Easy Apply switch and the daily limits. The
// start script records them in .jobber/window-start/linkedin.json (no secrets, no addresses); the doctor warns when .env differs
// and the lane refuses to type while the scheduler is in a dry run but the window started live. Pure.
export const LINKEDIN_START_KEYS = [
  'JOBBER_DRY_RUN',
  'APPLY_LINKEDIN_EASY',
  'MAX_APPLIES_PER_DAY',
  'LINKEDIN_MAX_INVITES_PER_DAY',
  'LINKEDIN_MAX_MESSAGES_PER_DAY',
  'LINKEDIN_MAX_EASY_APPLIES_PER_DAY',
  'LINKEDIN_ACTIVE_HOURS',
] as const;

/** The values of LINKEDIN_START_KEYS in `env` (an unset key is the empty string). */
export function linkedinStartValues(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of LINKEDIN_START_KEYS) out[k] = (env[k] ?? '').trim();
  return out;
}

/** Keys whose recorded start value differs from the current environment. */
export function linkedinStartDiff(started: Record<string, unknown>, now: Record<string, string | undefined>): string[] {
  const cur = linkedinStartValues(now);
  const out: string[] = [];
  for (const k of LINKEDIN_START_KEYS) {
    if (typeof started[k] === 'string' && started[k] !== cur[k]) out.push(k);
  }
  return out;
}
