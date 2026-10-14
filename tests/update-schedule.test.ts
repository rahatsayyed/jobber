import { describe, it, expect } from 'vitest';
import { pickRunTime, isDue } from '../src/update/schedule.js';
import { inQuietHours } from '../src/outreach/pacing.js';

const quiet = { startHour: 1, endHour: 7, tzOffsetMinutes: 330 };
const istHour = (d: Date) => new Date(d.getTime() + 330 * 60000).getUTCHours();

describe('pickRunTime', () => {
  it('never lands in quiet hours (IST) for many draws, including an overnight window', () => {
    for (let i = 0; i < 500; i++) {
      const t = pickRunTime(new Date('2026-10-14T20:30:00Z'), Math.random, quiet);
      const h = istHour(t);
      expect(h >= 7 || h < 1).toBe(true);
    }
    const overnight = { startHour: 22, endHour: 6, tzOffsetMinutes: 330 };
    for (let i = 0; i < 200; i++) {
      const h = istHour(pickRunTime(new Date('2026-10-14T00:00:00Z'), Math.random, overnight));
      expect(h >= 6 && h < 22).toBe(true);
    }
  });
  it('is strictly after the input and within the next 48 hours; deterministic for a fixed rng', () => {
    const now = new Date('2026-10-14T10:00:00Z');
    const a = pickRunTime(now, () => 0.5, quiet);
    expect(a.getTime()).toBeGreaterThan(now.getTime());
    expect(a.getTime() - now.getTime()).toBeLessThan(48 * 3600_000);
    expect(pickRunTime(now, () => 0.5, quiet).getTime()).toBe(a.getTime());
  });
  it('quiet window of zero length (start equals end) allows every minute', () => {
    expect(() => pickRunTime(new Date(), Math.random, { startHour: 3, endHour: 3, tzOffsetMinutes: 0 })).not.toThrow();
  });
  it('lands on the next local day and tolerates rng at or above 1', () => {
    const now = new Date('2026-10-14T10:00:00Z'); // 15:30 IST Oct 14
    const t = pickRunTime(now, () => 5, quiet);
    const local = new Date(t.getTime() + 330 * 60000);
    expect(local.getUTCDate()).toBe(15);
    expect(pickRunTime(now, () => -1, quiet).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('isDue', () => {
  it('due when never scheduled, when time passed, not during quiet hours, not before', () => {
    const noon = new Date('2026-10-14T06:30:00Z'); // 12:00 IST
    expect(isDue(noon, null, quiet)).toBe(true);
    expect(isDue(noon, '2026-10-14T05:00:00Z', quiet)).toBe(true);
    expect(isDue(noon, '2026-10-14T07:00:00Z', quiet)).toBe(false);
    expect(isDue(new Date('2026-10-13T21:30:00Z'), null, quiet)).toBe(false); // 03:00 IST, quiet
  });
});

describe('quiet semantics match outreach pacing', () => {
  it('isDue agrees with inQuietHours for every hour, incl. wrap and zero-length windows', () => {
    const windows = [
      { startHour: 1, endHour: 7 },
      { startHour: 22, endHour: 6 },
      { startHour: 3, endHour: 3 },
    ];
    for (const w of windows) {
      for (let h = 0; h < 24; h++) {
        const at = new Date(Date.UTC(2026, 9, 14, h, 0, 0) - 330 * 60000);
        const q = { ...w, tzOffsetMinutes: 330 };
        const pacing = { quietStartHour: w.startHour, quietEndHour: w.endHour, tzOffsetMinutes: 330 } as Parameters<typeof inQuietHours>[1];
        expect(isDue(at, null, q)).toBe(!inQuietHours(at, pacing));
      }
    }
  });
});
