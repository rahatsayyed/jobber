// src/outreach/quiet.ts: quiet hours, the fixed wake interval and the mail drip's uniform draw.
import type { OutreachConfig } from './config.js';

export type Rng = () => number;

/** Quiet hours (a safety rule, not a throttle): [start, end) local hours in the offset timezone, wrapping midnight. */
export interface QuietConfig {
  quietStartHour: number;
  quietEndHour: number;
  tzOffsetMinutes: number;
}

export const IST_OFFSET_MINUTES = 330;

/** Minutes between two scheduler wakes: a fixed poll interval, not a throttle. Each wake plans every due task up to the real caps; the run lock stops two wakes overlapping. */
export const WAKE_INTERVAL_MIN = 10;

export function quietFromConfig(cfg: OutreachConfig): QuietConfig {
  return {
    quietStartHour: cfg.quietStartHour,
    quietEndHour: cfg.quietEndHour,
    tzOffsetMinutes: IST_OFFSET_MINUTES,
  };
}

function localHour(at: Date, tzOffsetMinutes: number): number {
  return new Date(at.getTime() + tzOffsetMinutes * 60000).getUTCHours();
}

export function inQuietHours(at: Date, cfg: QuietConfig): boolean {
  const h = localHour(at, cfg.tzOffsetMinutes);
  const { quietStartHour: s, quietEndHour: e } = cfg;
  if (s === e) return false;
  return s < e ? h >= s && h < e : h >= s || h < e;
}

/** A uniform draw between lo and hi minutes, in ms (the mail drip gap; the range is the randomness). */
export function drawUniformMinMs(rng: Rng, loMin: number, hiMin: number): number {
  return Math.round((loMin + rng() * (hiMin - loMin)) * 60000);
}

/** First moment at or after `at` when the local clock reads quietEndHour:00. */
function quietEnd(at: Date, cfg: QuietConfig): Date {
  const local = new Date(at.getTime() + cfg.tzOffsetMinutes * 60000);
  const end = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), cfg.quietEndHour, 0, 0),
  );
  if (end.getTime() <= local.getTime()) end.setUTCDate(end.getUTCDate() + 1);
  return new Date(end.getTime() - cfg.tzOffsetMinutes * 60000);
}

/** The next wake: a fixed interval after `now`, moved to the end of quiet hours when it would land inside them. */
export function nextWake(now: Date, cfg: QuietConfig): Date {
  const t = new Date(now.getTime() + WAKE_INTERVAL_MIN * 60000);
  return inQuietHours(t, cfg) ? quietEnd(t, cfg) : t;
}
