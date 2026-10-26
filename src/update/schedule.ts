// src/update/schedule.ts
export interface QuietWindow {
  startHour: number;
  endHour: number;
  tzOffsetMinutes: number;
}

export type Rng = () => number;

const MIN_MS = 60000;
const DAY_MS = 24 * 60 * MIN_MS;

/** Same semantics as inQuietHours in src/outreach/quiet.ts: [start, end) local hours, wraps midnight, start === end is empty. */
function hourIsQuiet(hour: number, q: QuietWindow): boolean {
  const { startHour: s, endHour: e } = q;
  if (s === e) return false;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

function localHour(at: Date, tzOffsetMinutes: number): number {
  return new Date(at.getTime() + tzOffsetMinutes * MIN_MS).getUTCHours();
}

/** Uniform over the allowed minutes of the local day after `after`'s local day. */
export function pickRunTime(after: Date, rng: Rng, quiet: QuietWindow): Date {
  const localMs = after.getTime() + quiet.tzOffsetMinutes * MIN_MS;
  const nextDayStartLocal = Math.floor(localMs / DAY_MS) * DAY_MS + DAY_MS;
  const nextDayStartUtc = nextDayStartLocal - quiet.tzOffsetMinutes * MIN_MS;

  const allowed: number[] = [];
  for (let m = 0; m < 1440; m++) {
    if (!hourIsQuiet(Math.floor(m / 60), quiet)) allowed.push(m);
  }
  // A window covering all 24 hours cannot be satisfied; fall back to every minute.
  const pool = allowed.length > 0 ? allowed : Array.from({ length: 1440 }, (_, i) => i);

  let r = rng();
  if (!Number.isFinite(r) || r < 0) r = 0;
  if (r >= 1) r = 1 - Number.EPSILON;
  const minute = pool[Math.floor(r * pool.length)];
  return new Date(nextDayStartUtc + minute * MIN_MS);
}

export function isDue(now: Date, nextRunAt: string | null, quiet: QuietWindow): boolean {
  if (hourIsQuiet(localHour(now, quiet.tzOffsetMinutes), quiet)) return false;
  if (nextRunAt === null) return true;
  const t = Date.parse(nextRunAt);
  if (Number.isNaN(t)) return true;
  return t <= now.getTime();
}
