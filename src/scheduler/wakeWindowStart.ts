// src/scheduler/wakeWindowStart.ts
// The windows of the `wake` lane (sources, pipeline, boards, apply) read their environment once, when their claude starts
// (scripts/window-env.ts). The values that matter for safety or caps and can change in .env later are recorded in
// .jobber/window-start/<window>.json (no secrets, no addresses): the dry-run flag, the daily limits and the match threshold.
// The doctor warns when .env differs; the wake refuses to type into a window that started live while the scheduler is in a dry run. Pure
// apart from the one file read in windowStartedLive.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDryRun } from '../safety/dryRun.js';

const EXACT = ['JOBBER_DRY_RUN', 'MAX_APPLIES_PER_DAY', 'MATCH_THRESHOLD'];
const CAP_PREFIXES = ['LINKEDIN_', 'NAUKRI_', 'WELLFOUND_', 'APPLY_', 'SCOUT_', 'SITE_'];

const isCapKey = (k: string): boolean => CAP_PREFIXES.some((p) => k.startsWith(p)) && /_MAX_|_LIMIT|_PER_DAY/.test(k);

// The recorded values come from the window's ALLOWLISTED launch env, not from the whole .env. A key the window does not receive is NOT
// recorded: the old format recorded it as '' and the doctor then compared that '' with the value in .env (a false "old settings"
// warning). The dry-run flag is always recorded (an unset flag is ''). `_fmt: '2'` marks the new format.
export function wakeStartValues(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { _fmt: '2' };
  out.JOBBER_DRY_RUN = (env.JOBBER_DRY_RUN ?? '').trim();
  for (const k of EXACT) if (k !== 'JOBBER_DRY_RUN' && typeof env[k] === 'string') out[k] = (env[k] as string).trim();
  for (const k of Object.keys(env).sort()) {
    if (isCapKey(k) && typeof env[k] === 'string') out[k] = (env[k] as string).trim();
  }
  return out;
}

/** Recorded keys whose value differs from the current environment. */
export function wakeStartDiff(started: Record<string, unknown>, now: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(started)) {
    if (k === 'at' || k === '_fmt' || typeof v !== 'string') continue;
    // An old-format record holds '' for keys the window never received: that cannot be told from "not passed", so it is skipped.
    if (started._fmt !== '2' && v === '' && k !== 'JOBBER_DRY_RUN') continue;
    if (v !== (now[k] ?? '').trim()) out.push(k);
  }
  return out;
}

export const windowStartFile = (root: string, window: string): string => path.join(root, '.jobber', 'window-start', `${window}.json`);

/**
 * True when the scheduler is in a dry run but the window started live (its tools read JOBBER_DRY_RUN once at start). Nothing may be typed then.
 * No record (an older start script, or tests) means no opinion: false.
 */
export function windowStartedLive(root: string, window: string, dry: boolean): boolean {
  if (!dry) return false;
  try {
    const rec = JSON.parse(readFileSync(windowStartFile(root, window), 'utf8')) as { JOBBER_DRY_RUN?: string };
    return !isDryRun({ JOBBER_DRY_RUN: rec.JOBBER_DRY_RUN });
  } catch {
    return false;
  }
}
