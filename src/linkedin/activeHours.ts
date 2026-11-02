// LinkedIn active hours (LINKEDIN_ACTIVE_HOURS, "HH:MM-HH:MM", IST like the mail send window): outside this window the
// planner plans no LinkedIn task at all and the linkedin tools refuse with `outside_active_hours`. A real person is not
// on LinkedIn around the clock; the quiet hours alone (01:00-07:00) left 18 hours a day of traffic.
export const DEFAULT_ACTIVE_HOURS = '09:30-20:30';
const IST_OFFSET_MIN = 330;

export interface ActiveHours {
  startMin: number;
  endMin: number;
  /** Set when the env value was invalid (the default is then used); the doctor shows it. */
  problem: string | null;
}

function parseRange(v: string): { startMin: number; endMin: number } | null {
  const m = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(v);
  if (!m) return null;
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]);
  return startMin < endMin ? { startMin, endMin } : null;
}

/** Blank or unset is the default; an invalid value is the default AND a problem. */
export function loadActiveHours(env: NodeJS.ProcessEnv = process.env): ActiveHours {
  const raw = env.LINKEDIN_ACTIVE_HOURS;
  const dflt = parseRange(DEFAULT_ACTIVE_HOURS) as { startMin: number; endMin: number };
  if (raw === undefined || raw.trim() === '') return { ...dflt, problem: null };
  const r = parseRange(raw);
  if (r) return { ...r, problem: null };
  return { ...dflt, problem: `LINKEDIN_ACTIVE_HOURS=${JSON.stringify(raw.slice(0, 20))} is not HH:MM-HH:MM with start before end; using ${DEFAULT_ACTIVE_HOURS}` };
}

/** True when `at` (read as IST) is inside [start, end). */
export function inActiveHours(at: Date, cfg: Pick<ActiveHours, 'startMin' | 'endMin'>): boolean {
  const local = (Math.floor(at.getTime() / 60000) + IST_OFFSET_MIN) % 1440;
  return local >= cfg.startMin && local < cfg.endMin;
}

export function linkedinActiveNow(env: NodeJS.ProcessEnv, at: Date): boolean {
  return inActiveHours(at, loadActiveHours(env));
}

export const OUTSIDE_ACTIVE_HOURS_CODE = 'outside_active_hours';
