// src/outreach/tuning.ts
import { COOLDOWN_DAYS, GAPS_DAYS } from './cadence.js';

export interface Tuning {
  cooldownDays: { ignored: number; not_now: number; explicit_stop: number };
  cadenceGapsDays: number[];
}

export const TUNING_DEFAULTS: Tuning = {
  cooldownDays: { ...COOLDOWN_DAYS },
  cadenceGapsDays: [...GAPS_DAYS],
};

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function gaps(value: string | undefined, fallback: number[]): number[] {
  if (value === undefined || value.trim() === '') return [...fallback];
  const nums = value.split(',').map((s) => Number(s.trim()));
  const ok = nums.length === fallback.length && nums.every((n) => Number.isInteger(n) && n >= 1 && n <= 365);
  return ok ? nums : [...fallback];
}

export function loadTuning(env: NodeJS.ProcessEnv = process.env): Tuning {
  const d = TUNING_DEFAULTS;
  return {
    cooldownDays: {
      ignored: int(env.COOLDOWN_IGNORED_DAYS, d.cooldownDays.ignored, 1, 3650),
      not_now: int(env.COOLDOWN_NOT_NOW_DAYS, d.cooldownDays.not_now, 1, 3650),
      explicit_stop: int(env.COOLDOWN_EXPLICIT_STOP_DAYS, d.cooldownDays.explicit_stop, 1, 3650),
    },
    cadenceGapsDays: gaps(env.CADENCE_GAPS_DAYS, d.cadenceGapsDays),
  };
}
