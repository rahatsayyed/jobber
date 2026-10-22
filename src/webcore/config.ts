import { isDryRun } from '../safety/dryRun.js';

// Shared web runtime config. Never throws; invalid values fall back, out-of-range values clamp.
// Dry run follows the single master flag JOBBER_DRY_RUN (see isDryRun).
export interface WebConfig {
  dryRun: boolean;
  minGapSec: number;
  maxCallsPerJob: number;
  maxJobMin: number;
  idleMs: number;
  settleMs: number;
}

function int(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return def;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  return {
    dryRun: isDryRun(env),
    minGapSec: int(env.WEB_MIN_GAP_SEC, 20, 0, 3600),
    maxCallsPerJob: int(env.WEB_MAX_CALLS_PER_JOB, 80, 1, 1000),
    maxJobMin: int(env.WEB_MAX_JOB_MIN, 15, 1, 240),
    idleMs: int(env.WEB_IDLE_MS, 600000, 60000, 3600000),
    settleMs: int(env.WEB_SETTLE_MS, 1500, 0, 30000),
  };
}
