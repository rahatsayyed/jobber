// src/outreach/pacing.ts
import type { OutreachConfig } from './config.js';
import type { Tuning } from './tuning.js';

export type Rng = () => number;

export interface PacingConfig {
  quietStartHour: number;
  quietEndHour: number;
  tzOffsetMinutes: number;
  minBurst: number;
  maxBurst: number;
  minActionGapSec: number;
  maxActionGapSec: number;
  minWaitMin: number;
  maxWaitMin: number;
  jitter: number;
}

export const IST_OFFSET_MINUTES = 330;

export function pacingFromConfig(cfg: OutreachConfig, tuning: Tuning): PacingConfig {
  return {
    quietStartHour: cfg.quietStartHour,
    quietEndHour: cfg.quietEndHour,
    tzOffsetMinutes: IST_OFFSET_MINUTES,
    minBurst: tuning.minBurst,
    maxBurst: tuning.maxBurst,
    minActionGapSec: tuning.minActionGapSec,
    maxActionGapSec: tuning.maxActionGapSec,
    minWaitMin: tuning.minWaitMin,
    maxWaitMin: tuning.maxWaitMin,
    jitter: tuning.jitter,
  };
}

const uniform = (rng: Rng, lo: number, hi: number): number => lo + rng() * (hi - lo);
const jittered = (rng: Rng, value: number, j: number): number => value * (1 + (rng() * 2 - 1) * j);

function localHour(at: Date, tzOffsetMinutes: number): number {
  return new Date(at.getTime() + tzOffsetMinutes * 60000).getUTCHours();
}

export function inQuietHours(at: Date, cfg: PacingConfig): boolean {
  const h = localHour(at, cfg.tzOffsetMinutes);
  const { quietStartHour: s, quietEndHour: e } = cfg;
  if (s === e) return false;
  return s < e ? h >= s && h < e : h >= s || h < e;
}

export function drawBurstSize(rng: Rng, cfg: PacingConfig): number {
  return cfg.minBurst + Math.floor(rng() * (cfg.maxBurst - cfg.minBurst + 1));
}

export function drawActionGapMs(rng: Rng, cfg: PacingConfig): number {
  return Math.round(jittered(rng, uniform(rng, cfg.minActionGapSec, cfg.maxActionGapSec), cfg.jitter) * 1000);
}

/** A uniform draw between lo and hi minutes, in ms (the mail drip gap; the range is the randomness, no jitter on top). */
export function drawUniformMinMs(rng: Rng, loMin: number, hiMin: number): number {
  return Math.round(uniform(rng, loMin, hiMin) * 60000);
}

export function drawWaitMs(rng: Rng, cfg: PacingConfig): number {
  return Math.round(jittered(rng, uniform(rng, cfg.minWaitMin, cfg.maxWaitMin), cfg.jitter) * 60000);
}

/** First moment at or after `at` when the local clock reads quietEndHour:00. */
function quietEnd(at: Date, cfg: PacingConfig): Date {
  const local = new Date(at.getTime() + cfg.tzOffsetMinutes * 60000);
  const end = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), cfg.quietEndHour, 0, 0),
  );
  if (end.getTime() <= local.getTime()) end.setUTCDate(end.getUTCDate() + 1);
  return new Date(end.getTime() - cfg.tzOffsetMinutes * 60000);
}

export function nextWake(now: Date, rng: Rng, cfg: PacingConfig): Date {
  let t = new Date(now.getTime() + drawWaitMs(rng, cfg));
  if (inQuietHours(t, cfg)) {
    let end = quietEnd(t, cfg);
    t = new Date(end.getTime() + Math.round(uniform(rng, 0, 90) * 60000));
    for (let i = 0; i < 3 && inQuietHours(t, cfg); i++) {
      end = quietEnd(t, cfg);
      t = new Date(end.getTime() + Math.round(uniform(rng, 0, 90) * 60000));
    }
    if (inQuietHours(t, cfg)) t = quietEnd(t, cfg);
  }
  return t;
}
