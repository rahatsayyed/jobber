// src/setup/profile.ts
// The user-data/profile.json shape, its validator and the money parser used by the setup step.
// Pure (no node imports): src/platform/checksSetup.ts delegates profileProblems to validateProfile,
// so the doctor check and the wizard cannot drift. Problems are field paths, never values.

export interface SalaryBand {
  floor: number;
  target: number;
}

export interface Profile {
  version: 1;
  roles: string[];
  locations: string[];
  remote_ok: boolean;
  remote_anywhere: boolean;
  /** Key: ISO 4217 code, annual amounts in the currency's major unit. */
  salary: Record<string, SalaryBand>;
  notice_period_days: number;
  work_authorization: { india: boolean; other: 'needs_sponsorship' | 'authorized' | 'unknown' };
  /** Mirror of languages.json declared names, informational. */
  languages: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const posNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export const WORK_AUTH_OTHER = ['needs_sponsorship', 'authorized', 'unknown'] as const;

/** Field paths (never values) that break the shape; [] when valid. */
export function validateProfile(p: unknown): string[] {
  if (!isObj(p)) return ['(root)'];
  const bad: string[] = [];
  if (p.version !== 1) bad.push('version');
  if (!isStrArr(p.roles)) bad.push('roles');
  if (!isStrArr(p.locations)) bad.push('locations');
  if (typeof p.remote_ok !== 'boolean') bad.push('remote_ok');
  if (typeof p.remote_anywhere !== 'boolean') bad.push('remote_anywhere');
  if (!isObj(p.salary)) {
    bad.push('salary');
  } else {
    for (const [cur, v] of Object.entries(p.salary)) {
      if (!/^[A-Z]{3}$/.test(cur)) {
        bad.push('salary.(currency key)');
      } else if (!isObj(v) || !posNum(v.floor) || !posNum(v.target) || v.target < v.floor) {
        bad.push(`salary.${cur}`);
      }
    }
  }
  if (!(typeof p.notice_period_days === 'number' && Number.isInteger(p.notice_period_days) && p.notice_period_days >= 0)) {
    bad.push('notice_period_days');
  }
  const wa = p.work_authorization;
  if (!isObj(wa)) {
    bad.push('work_authorization');
  } else {
    if (typeof wa.india !== 'boolean') bad.push('work_authorization.india');
    if (!(WORK_AUTH_OTHER as readonly string[]).includes(wa.other as string)) bad.push('work_authorization.other');
  }
  if (p.languages !== undefined && !isStrArr(p.languages)) bad.push('languages');
  return bad;
}

const MONEY_RE = /^(\d[\d,]*(?:\.\d+)?)\s*(k|m|lpa|lakhs?|lacs?)?$/i;

/** "18,00,000", "1800000", "25k", "1.5m"; "18 LPA" / "18 lakh" only when currency is INR.
 *  Returns a positive whole number or null. */
export function parseMoney(raw: string, currency?: string): number | null {
  const m = MONEY_RE.exec(raw.trim());
  if (!m) return null;
  const digits = m[1];
  if (digits.endsWith(',') || digits.includes(',,')) return null;
  let n = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === 'k') n *= 1_000;
  else if (unit === 'm') n *= 1_000_000;
  else if (unit !== '') {
    if (currency !== 'INR') return null;
    n *= 100_000;
  }
  n = Math.round(n);
  return n > 0 ? n : null;
}
