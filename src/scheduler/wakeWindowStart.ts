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

/** The recorded start values of `env`: the exact keys plus every cap-looking key of the listed prefixes (an unset exact key is ''). */
export function wakeStartValues(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of EXACT) out[k] = (env[k] ?? '').trim();
  for (const k of Object.keys(env).sort()) {
    if (isCapKey(k) && typeof env[k] === 'string') out[k] = (env[k] as string).trim();
  }
  return out;
}

/** Recorded keys whose value differs from the current environment. */
export function wakeStartDiff(started: Record<string, unknown>, now: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(started)) {
    if (k === 'at' || typeof v !== 'string') continue;
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
