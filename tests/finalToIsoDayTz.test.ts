import { describe, it, expect, afterEach } from 'vitest';
import { toIsoDay } from '../src/db.js';

describe('toIsoDay is independent of the process timezone (final review M4)', () => {
  const saved = process.env.TZ;
  afterEach(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });

  it.each(['Asia/Kolkata', 'UTC', 'America/Los_Angeles', 'Pacific/Auckland'])('a datetime without a timezone is UTC under TZ=%s', (tz) => {
    process.env.TZ = tz;
    expect(toIsoDay('2026-10-08T02:00:00')).toBe('2026-10-08');
    expect(toIsoDay('2026-10-08 02:00:00')).toBe('2026-10-08');
    expect(toIsoDay('2026-10-08T23:30:00.123')).toBe('2026-10-08');
  });
  it('datetimes with an explicit zone keep their instant (UTC day)', () => {
    process.env.TZ = 'Asia/Kolkata';
    expect(toIsoDay('2026-10-08T02:00:00Z')).toBe('2026-10-08');
    expect(toIsoDay('2026-10-08T02:00:00+05:30')).toBe('2026-10-07');
  });
});
