// src/heal/config.ts
// Self-heal settings (env, read by the scheduler daemon at start; the agent never sets any of them).
export type HealMode = 'off' | 'suggest' | 'auto';

const intIn = (raw: string | undefined, lo: number, hi: number, dflt: number): number => {
  const t = (raw ?? '').trim();
  const n = Number(t);
  return t !== '' && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
};

/** HEAL_MODE: exactly `off` or `auto` selects those; blank or anything else is `suggest` (the safe middle). */
export function healMode(env: NodeJS.ProcessEnv): HealMode {
  const v = (env.HEAL_MODE ?? '').trim();
  return v === 'off' || v === 'auto' ? v : 'suggest';
}
/** Heal attempts per rolling 24 hours (1..20, default 3). */
export const healMaxPerDay = (env: NodeJS.ProcessEnv): number => intIn(env.HEAL_MAX_PER_DAY, 1, 20, 3);
/** Hours before the same signature may be healed again (1..168, default 6). */
export const healCooldownHours = (env: NodeJS.ProcessEnv): number => intIn(env.HEAL_COOLDOWN_HOURS, 1, 168, 6);
/** Minutes a landed fix is watched for recurrence before it counts as stable (5..240, default 30). */
export const healWatchMin = (env: NodeJS.ProcessEnv): number => intIn(env.HEAL_WATCH_MIN, 5, 240, 30);

/** Fixed (not env): wall clock of one fixer item, idle wait before a restart, size caps of a landing. */
export const FIXER_DEADLINE_MS = 90 * 60_000;
export const IDLE_WAIT_MS = 10 * 60_000;
export const IDLE_POLL_MS = 15_000;
export const MAX_FILES = 12;
export const MAX_CHANGED_LINES = 400;
export const REQUEUE_MAX = 3;
/** A `gave_up` or `rolled_back` signature that recurs after this many days may be healed again. */
export const REOPEN_AFTER_DAYS = 7;
/** A ledger row stuck in `healing` this long (daemon died mid-heal) is released. */
export const HEALING_STALE_MS = 3 * 3600_000;
/** A skipped live check is retried no sooner than this; after the bound the owner is told once (the fix still never lands untested). */
export const LIVE_RETRY_MS = 5 * 60_000;
export const LIVE_SKIP_BOUND_MS = 6 * 3600_000;
/** The worker window that runs the fixer. */
export const FIXER_WINDOW = 'fixer';
