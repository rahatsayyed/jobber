// tests/outreach-pacing.test.ts
import { describe, it, expect } from 'vitest';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import {
  drawActionGapMs,
  drawBurstSize,
  drawWaitMs,
  inQuietHours,
  nextWake,
  pacingFromConfig,
  type Rng,
} from '../src/outreach/pacing.js';

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cfg = pacingFromConfig(loadOutreachConfig({}), loadTuning({}));

describe('user tuning', () => {
  it('changes burst and wait ranges from env', () => {
    const t = loadTuning({
      PACING_MIN_BURST: '3',
      PACING_MAX_BURST: '3',
      PACING_MIN_WAIT_MIN: '60',
      PACING_MAX_WAIT_MIN: '60',
      PACING_JITTER_PCT: '0',
    });
    const custom = pacingFromConfig(loadOutreachConfig({}), t);
    const rng = mulberry32(9);
    expect(drawBurstSize(rng, custom)).toBe(3);
    expect(drawWaitMs(rng, custom)).toBe(60 * 60000);
  });
});

describe('inQuietHours (IST, regardless of server timezone)', () => {
  it('treats 01:30 IST as quiet even when the clock is UTC', () => {
    expect(inQuietHours(new Date('2026-10-14T20:00:00Z'), cfg)).toBe(true); // 01:30 IST
  });
  it('treats 07:00 IST and 00:59 IST as not quiet', () => {
    expect(inQuietHours(new Date('2026-10-14T01:30:00Z'), cfg)).toBe(false); // 07:00 IST
    expect(inQuietHours(new Date('2026-10-14T19:29:00Z'), cfg)).toBe(false); // 00:59 IST
  });
  it('supports a window that wraps midnight', () => {
    const wrap = { ...cfg, quietStartHour: 23, quietEndHour: 5 };
    expect(inQuietHours(new Date('2026-10-14T18:00:00Z'), wrap)).toBe(true); // 23:30 IST
    expect(inQuietHours(new Date('2026-10-14T05:00:00Z'), wrap)).toBe(false); // 10:30 IST
  });
});

describe('draws', () => {
  it('bursts stay in range and every size appears', () => {
    const rng = mulberry32(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const n = drawBurstSize(rng, cfg);
      expect(n).toBeGreaterThanOrEqual(cfg.minBurst);
      expect(n).toBeLessThanOrEqual(cfg.maxBurst);
      seen.add(n);
    }
    expect(seen.size).toBe(cfg.maxBurst - cfg.minBurst + 1);
  });

  it('gaps and waits stay within the jittered bounds', () => {
    const rng = mulberry32(2);
    for (let i = 0; i < 500; i++) {
      const g = drawActionGapMs(rng, cfg) / 1000;
      expect(g).toBeGreaterThanOrEqual(cfg.minActionGapSec * (1 - cfg.jitter));
      expect(g).toBeLessThanOrEqual(cfg.maxActionGapSec * (1 + cfg.jitter));
      const w = drawWaitMs(rng, cfg) / 60000;
      expect(w).toBeGreaterThanOrEqual(cfg.minWaitMin * (1 - cfg.jitter));
      expect(w).toBeLessThanOrEqual(cfg.maxWaitMin * (1 + cfg.jitter));
    }
  });

  it('never repeats the same sequence for different seeds, and repeats for the same seed', () => {
    const run = (seed: number) => {
      const rng = mulberry32(seed);
      return Array.from({ length: 10 }, () => drawWaitMs(rng, cfg));
    };
    expect(run(3)).toEqual(run(3));
    expect(run(3)).not.toEqual(run(4));
  });
});

describe('nextWake', () => {
  it('is always after now and never inside quiet hours', () => {
    const rng = mulberry32(5);
    let now = new Date('2026-10-14T00:00:00Z');
    for (let i = 0; i < 2000; i++) {
      const next = nextWake(now, rng, cfg);
      expect(next.getTime()).toBeGreaterThan(now.getTime());
      expect(inQuietHours(next, cfg)).toBe(false);
      now = next;
    }
  });

  it('pushes a wake that lands in quiet hours to after the window ends', () => {
    const rng = () => 0; // minimum wait
    const start = new Date('2026-10-14T19:25:00Z'); // 00:55 IST
    const next = nextWake(start, rng, cfg);
    const hourIst = new Date(next.getTime() + 330 * 60000).getUTCHours();
    expect(hourIst).toBeGreaterThanOrEqual(7);
  });
});
