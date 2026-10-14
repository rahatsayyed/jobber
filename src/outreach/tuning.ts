// src/outreach/tuning.ts
import { COOLDOWN_DAYS, GAPS_DAYS } from './cadence.js';

export interface Tuning {
  minBurst: number;
  maxBurst: number;
  minActionGapSec: number;
  maxActionGapSec: number;
  minWaitMin: number;
  maxWaitMin: number;
  jitter: number;
  cooldownDays: { ignored: number; not_now: number; explicit_stop: number };
  cadenceGapsDays: number[];
}

export const TUNING_DEFAULTS: Tuning = {
  minBurst: 1,
  maxBurst: 4,
  minActionGapSec: 120,
  maxActionGapSec: 360,
  minWaitMin: 8,
  maxWaitMin: 40,
  jitter: 0.25,
  cooldownDays: { ...COOLDOWN_DAYS },
  cadenceGapsDays: [...GAPS_DAYS],
};

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function pair(
  env: NodeJS.ProcessEnv,
  loKey: string,
  hiKey: string,
  loDefault: number,
  hiDefault: number,
  min: number,
  max: number,
): [number, number] {
  const lo = int(env[loKey], loDefault, min, max);
  const hi = int(env[hiKey], hiDefault, min, max);
  return lo <= hi ? [lo, hi] : [loDefault, hiDefault];
}

function gaps(value: string | undefined, fallback: number[]): number[] {
  if (value === undefined || value.trim() === '') return [...fallback];
  const nums = value.split(',').map((s) => Number(s.trim()));
  const ok = nums.length === fallback.length && nums.every((n) => Number.isInteger(n) && n >= 1 && n <= 365);
  return ok ? nums : [...fallback];
}

export function loadTuning(env: NodeJS.ProcessEnv = process.env): Tuning {
  const d = TUNING_DEFAULTS;
  const [minBurst, maxBurst] = pair(env, 'PACING_MIN_BURST', 'PACING_MAX_BURST', d.minBurst, d.maxBurst, 1, 50);
  const [minActionGapSec, maxActionGapSec] = pair(
    env,
    'PACING_MIN_ACTION_GAP_SEC',
    'PACING_MAX_ACTION_GAP_SEC',
    d.minActionGapSec,
    d.maxActionGapSec,
    1,
    86400,
  );
  const [minWaitMin, maxWaitMin] = pair(env, 'PACING_MIN_WAIT_MIN', 'PACING_MAX_WAIT_MIN', d.minWaitMin, d.maxWaitMin, 1, 1440);
  return {
    minBurst,
    maxBurst,
    minActionGapSec,
    maxActionGapSec,
    minWaitMin,
    maxWaitMin,
    jitter: int(env.PACING_JITTER_PCT, Math.round(d.jitter * 100), 0, 90) / 100,
    cooldownDays: {
      ignored: int(env.COOLDOWN_IGNORED_DAYS, d.cooldownDays.ignored, 1, 3650),
      not_now: int(env.COOLDOWN_NOT_NOW_DAYS, d.cooldownDays.not_now, 1, 3650),
      explicit_stop: int(env.COOLDOWN_EXPLICIT_STOP_DAYS, d.cooldownDays.explicit_stop, 1, 3650),
    },
    cadenceGapsDays: gaps(env.CADENCE_GAPS_DAYS, d.cadenceGapsDays),
  };
}
