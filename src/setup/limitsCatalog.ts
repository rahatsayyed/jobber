// src/setup/limitsCatalog.ts
// One catalog of every env-configurable limit. Defaults and ranges are copied from the code
// (src/outreach/config.ts, src/outreach/tuning.ts, src/outreach/cadence.ts and the direct
// process.env readers); tests/setup-limits-catalog.test.ts fails if they drift.
import { GAPS_DAYS } from '../outreach/cadence.js';

export type LimitGroup =
  | 'daily-caps'
  | 'weekly-caps'
  | 'per-company'
  | 'quiet-hours'
  | 'pacing'
  | 'cooldowns'
  | 'matching';

export interface LimitSpec {
  key: string; // env var name
  group: LimitGroup;
  default: number | string; // string only for CADENCE_GAPS_DAYS
  min: number;
  max: number;
  unit: string; // 'per day', 'per week', 'hour 0-23', 'seconds', 'minutes', 'days', 'percent', 'score'
  what: string;
  raiseNote?: string;
}

export const LIMITS: LimitSpec[] = [
  // matching and sending
  { key: 'MATCH_THRESHOLD', group: 'matching', default: 60, min: 0, max: 100, unit: 'score',
    what: 'Jobs scoring below this match score are skipped and never contacted.',
    raiseNote: 'Lowering it sends outreach for weaker matches.' },
  { key: 'SEND_LIMIT_PER_RUN', group: 'daily-caps', default: 1, min: 0, max: 100, unit: 'per day',
    what: 'Real cold emails sent per day (a daily counter shared by every run that day).',
    raiseNote: 'More email from one address raises spam-folder and bounce risk.' },
  { key: 'MAX_APPLIES_PER_DAY', group: 'daily-caps', default: 5, min: 0, max: 100000, unit: 'per day',
    what: 'Applications submitted per day across LinkedIn Easy Apply, external ATS and Naukri.',
    raiseNote: 'High volume on the burner account can trigger LinkedIn restrictions.' },
  { key: 'MAX_CONNECTS_PER_DAY', group: 'daily-caps', default: 10, min: 0, max: 100000, unit: 'per day',
    what: 'LinkedIn connection requests sent per day from the main account.',
    raiseNote: 'Your main account is at risk of a restriction if this is high.' },
  { key: 'MAX_LINKEDIN_SEARCHES_PER_DAY', group: 'daily-caps', default: 20, min: 0, max: 100000, unit: 'per day',
    what: 'LinkedIn people-search lookups per day from the main account.',
    raiseNote: 'Heavy searching is a common trigger for LinkedIn rate limits.' },
  { key: 'HUNTER_MONTHLY_CAP', group: 'daily-caps', default: 50, min: 0, max: 100000, unit: 'per month',
    what: 'Hunter.io credits spent per month on email lookups (last-resort source).',
    raiseNote: 'Hunter credits cost money beyond the plan.' },

  // outreach config
  { key: 'LINKEDIN_MAX_INVITES_PER_WEEK', group: 'weekly-caps', default: 100, min: 0, max: 100000, unit: 'per week',
    what: 'LinkedIn connection invitations sent per week.',
    raiseNote: 'LinkedIn itself limits weekly invitations; going above its limit risks a restriction.' },
  { key: 'LINKEDIN_MAX_MESSAGES_PER_WEEK', group: 'weekly-caps', default: 100, min: 0, max: 100000, unit: 'per week',
    what: 'LinkedIn direct messages sent per week.',
    raiseNote: 'Many messages to people you just met look like spam.' },
  { key: 'NAUKRI_MAX_APPLIES_PER_DAY', group: 'daily-caps', default: 30, min: 0, max: 100000, unit: 'per day',
    what: 'Naukri applications per day.' },
  { key: 'NAUKRI_MAX_MESSAGES_PER_DAY', group: 'daily-caps', default: 40, min: 0, max: 100000, unit: 'per day',
    what: 'Naukri recruiter messages per day.' },
  { key: 'COMPANY_CONTACT_LIMIT', group: 'per-company', default: 5, min: 0, max: 100000, unit: 'people',
    what: 'Most people contacted at one company, so a team is not flooded.' },
  { key: 'SPECULATIVE_COMPANY_LIMIT', group: 'per-company', default: 2, min: 0, max: 100000, unit: 'people',
    what: 'Most people contacted at one company when there is no open posting (speculative outreach).' },
  { key: 'QUIET_HOURS_START', group: 'quiet-hours', default: 1, min: 0, max: 23, unit: 'hour 0-23',
    what: 'Hour (local time) when quiet hours begin and no outreach is sent.' },
  { key: 'QUIET_HOURS_END', group: 'quiet-hours', default: 7, min: 0, max: 23, unit: 'hour 0-23',
    what: 'Hour (local time) when quiet hours end and outreach may resume.' },

  // pacing
  { key: 'PACING_MIN_BURST', group: 'pacing', default: 1, min: 1, max: 50, unit: 'actions',
    what: 'Fewest actions in one burst before a longer wait.' },
  { key: 'PACING_MAX_BURST', group: 'pacing', default: 4, min: 1, max: 50, unit: 'actions',
    what: 'Most actions in one burst before a longer wait.',
    raiseNote: 'Long bursts look automated.' },
  { key: 'PACING_MIN_ACTION_GAP_SEC', group: 'pacing', default: 120, min: 1, max: 86400, unit: 'seconds',
    what: 'Shortest pause between two actions in a burst.',
    raiseNote: 'Lowering it makes activity look robotic.' },
  { key: 'PACING_MAX_ACTION_GAP_SEC', group: 'pacing', default: 360, min: 1, max: 86400, unit: 'seconds',
    what: 'Longest pause between two actions in a burst.' },
  { key: 'PACING_MIN_WAIT_MIN', group: 'pacing', default: 8, min: 1, max: 1440, unit: 'minutes',
    what: 'Shortest wait between bursts.' },
  { key: 'PACING_MAX_WAIT_MIN', group: 'pacing', default: 40, min: 1, max: 1440, unit: 'minutes',
    what: 'Longest wait between bursts.' },
  { key: 'PACING_JITTER_PCT', group: 'pacing', default: 25, min: 0, max: 90, unit: 'percent',
    what: 'Random variation added to every pause so timing is not regular.' },

  // cooldowns and cadence
  { key: 'COOLDOWN_IGNORED_DAYS', group: 'cooldowns', default: 75, min: 1, max: 3650, unit: 'days',
    what: 'Days before contacting someone again after a sequence they ignored.' },
  { key: 'COOLDOWN_NOT_NOW_DAYS', group: 'cooldowns', default: 75, min: 1, max: 3650, unit: 'days',
    what: 'Days before contacting someone again after they said not now.' },
  { key: 'COOLDOWN_EXPLICIT_STOP_DAYS', group: 'cooldowns', default: 120, min: 1, max: 3650, unit: 'days',
    what: 'Days before contacting someone again after they asked you to stop.',
    raiseNote: 'Lowering it risks re-contacting people who asked to be left alone.' },
  { key: 'CADENCE_GAPS_DAYS', group: 'cooldowns', default: GAPS_DAYS.join(','), min: 1, max: 365, unit: 'days',
    what: 'Comma list of days between touches in a sequence, one number per follow-up gap (5 values, each 1 to 365).',
    raiseNote: 'Shorter gaps feel pushy.' },
];

export function specFor(key: string): LimitSpec | undefined {
  return LIMITS.find((l) => l.key === key);
}

function intIn(raw: string, min: number, max: number): string | null {
  const t = raw.trim();
  if (t === '') return 'value is empty';
  if (!/^\d+$/.test(t)) return `"${t}" is not a whole number`;
  const n = Number(t);
  if (n < min || n > max) return `${n} is outside ${min}..${max}`;
  return null;
}

// null = ok, else the reason. Mirrors the loaders: whole numbers only, inside min..max.
export function validateLimit(spec: LimitSpec, raw: string): string | null {
  if (spec.key === 'CADENCE_GAPS_DAYS') {
    if (raw.trim() === '') return 'value is empty';
    const want = String(spec.default).split(',').length;
    const parts = raw.split(',');
    if (parts.length !== want) return `needs exactly ${want} comma-separated numbers`;
    for (const p of parts) {
      const r = intIn(p, spec.min, spec.max);
      if (r) return r;
    }
    return null;
  }
  return intIn(raw, spec.min, spec.max);
}

const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['PACING_MIN_BURST', 'PACING_MAX_BURST'],
  ['PACING_MIN_ACTION_GAP_SEC', 'PACING_MAX_ACTION_GAP_SEC'],
  ['PACING_MIN_WAIT_MIN', 'PACING_MAX_WAIT_MIN'],
];

// The loaders silently reset a pair to defaults when min > max, so say it out loud.
export function validatePairs(values: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [lo, hi] of PAIRS) {
    const a = values[lo];
    const b = values[hi];
    if (a === undefined || b === undefined) continue;
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y) && x > y) {
      out.push(`${lo} (${x}) is above ${hi} (${y}); the loader would ignore both and use defaults`);
    }
  }
  return out;
}
