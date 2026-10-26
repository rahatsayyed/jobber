// tests/outreach-quiet.test.ts
import { describe, it, expect } from 'vitest';
import { loadOutreachConfig } from '../src/outreach/config.js';
import {
  WAKE_INTERVAL_MIN,
  drawUniformMinMs,
  inQuietHours,
  nextWake,
  quietFromConfig,
} from '../src/outreach/quiet.js';

const cfg = quietFromConfig(loadOutreachConfig({}));

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

describe('drawUniformMinMs', () => {
  it('maps the rng range onto lo..hi minutes', () => {
    expect(drawUniformMinMs(() => 0, 5, 8)).toBe(5 * 60000);
    expect(drawUniformMinMs(() => 1, 5, 8)).toBe(8 * 60000);
    expect(drawUniformMinMs(() => 0.5, 5, 7)).toBe(6 * 60000);
  });
});

describe('nextWake', () => {
  it('is a fixed interval after now, with no randomness', () => {
    const now = new Date('2026-10-14T06:00:00Z'); // 11:30 IST
    expect(nextWake(now, cfg).getTime()).toBe(now.getTime() + WAKE_INTERVAL_MIN * 60000);
  });

  it('pushes a wake that lands in quiet hours to the end of the window', () => {
    const start = new Date('2026-10-14T19:25:00Z'); // 00:55 IST, the next wake is 01:05 IST
    const next = nextWake(start, cfg);
    expect(new Date(next.getTime() + 330 * 60000).getUTCHours()).toBe(cfg.quietEndHour);
    expect(next.getTime()).toBeGreaterThan(start.getTime());
  });

  for (const w of [
    { quietStartHour: 0, quietEndHour: 23 },
    { quietStartHour: 22, quietEndHour: 6 },
  ]) {
    it(`never lands in quiet hours (window ${w.quietStartHour}-${w.quietEndHour})`, () => {
      const wide = { ...cfg, ...w };
      for (let h = 0; h < 48; h++) {
        const now = new Date(Date.UTC(2026, 9, 14, 0, 0, 0) + h * 3600000);
        const next = nextWake(now, wide);
        expect(next.getTime()).toBeGreaterThan(now.getTime());
        expect(inQuietHours(next, wide)).toBe(false);
      }
    });
  }
});
