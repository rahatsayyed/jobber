// Per-item budget knobs of the window dispatcher (RUN_MAX_WALL_SEC, RUN_STALL_SEC) and the usage-limit text pattern.
// Pure: no fs, no Date.now(), no randomness. (The stream-json BudgetTracker of the old headless runs is gone; the dispatcher
// watches the interactive window's transcript and pane instead, see windowDispatch.ts.)

export interface Budget {
  maxWallSec: number;
}

export const BUDGET_DEFAULTS: Budget = { maxWallSec: 3600 };

function intInRange(raw: string | undefined, min: number, max: number, dflt: number): number {
  if (raw === undefined) return dflt;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return dflt;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : dflt;
}

/** RUN_MAX_WALL_SEC (30..7200, default 3600): the longest one dispatched item may take before it is stopped as `timeout`. */
export function loadBudget(env: NodeJS.ProcessEnv = process.env): Budget {
  return {
    maxWallSec: intInRange(env.RUN_MAX_WALL_SEC, 30, 7200, BUDGET_DEFAULTS.maxWallSec),
  };
}

export const STALL_DEFAULT_SEC = 600;

/** RUN_STALL_SEC (60..3600, default 600). */
export function loadStallSec(env: NodeJS.ProcessEnv = process.env): number {
  return intInRange(env.RUN_STALL_SEC, 60, 3600, STALL_DEFAULT_SEC);
}

/** The stall limit in ms for the dispatcher when RUN_STALL_SEC is set and valid; undefined keeps the dispatcher default. */
export function stallMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.RUN_STALL_SEC;
  if (raw === undefined || raw.trim() === '') return undefined;
  return loadStallSec(env) * 1000;
}

// One warning line per budget env key that is set but invalid (outside its range), for the daemon start and the doctor.
export function budgetEnvWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const check = (key: string, min: number, max: number, dflt: number): void => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return;
    if (intInRange(raw, min, max, -1) === -1) out.push(`${key}=${raw.trim()} is outside ${min}..${max}, using ${dflt}`);
  };
  check('RUN_MAX_WALL_SEC', 30, 7200, BUDGET_DEFAULTS.maxWallSec);
  check('RUN_STALL_SEC', 60, 3600, STALL_DEFAULT_SEC);
  return out;
}

export const LIMIT_RE = /(usage|rate) limit (reached|exceeded)|(plan|session) limit reached|hit your limit/i;
