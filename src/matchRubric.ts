// file: src/matchRubric.ts
// The match rubric. Current rubric `career_ops_v1` is the scoring flow of career-ops (https://github.com/career-ops-hq/career-ops,
// MIT, (c) 2026 Santiago Fernandez de Valderrama; see docs/matching.md for the attribution and the exact source lines):
//   five scoring dimensions: CV match, North Star alignment, Comp, Cultural signals (each 1..5) and Red flags (a negative
//   adjustment, 0 or less), integrated into ONE holistic Global score of 1..5 ("no arithmetic formula").
//   Score interpretation (modes/_shared.md): 4.5+ strong, apply immediately; 4.0-4.4 good, worth applying; 3.5-3.9 decent but not
//   ideal, recommend against; below 3.5 recommend against. AGENTS.md "Ethical Use": below 4.0 is recommended against.
// Our stored `score` IS the Global score on the 1..5 scale (one decimal; 0 only for an expired posting), and MATCH_THRESHOLD is on the
// same scale (default 4.0). Since the 2026-11-06 scale migration (src/scoreScale.ts) every stored score of every rubric is on this scale.
// Two older shapes stay readable: `rubric_v2` (role_fit, skills, seniority_comp, location, flags, each an integer 0..20, summed) and
// `legacy` (skills, seniority, domain, location, each 0..25); their dimension values are NOT rescaled, only the stored score was.

export const RUBRIC_TAG = 'career_ops_v1';
/** The default MATCH_THRESHOLD: career-ops's "good match, worth applying" line, 4.0 of 5. */
export const DEFAULT_MATCH_THRESHOLD = 4.0;

/** The four positive dimensions, 1..5 each (career-ops modes/_shared.md "Scoring System"). Red flags is separate (0 or negative). */
export const CO_DIMS = ['cv_match', 'north_star', 'comp', 'culture'] as const;
export type CoDim = (typeof CO_DIMS)[number];
export const CO_EVIDENCE_KEYS = [...CO_DIMS, 'red_flags'] as const;
export type CoEvidenceKey = (typeof CO_EVIDENCE_KEYS)[number];
export const CO_MIN = 1;
export const CO_MAX = 5;
/** Red flags are "negative adjustments" ("Red flags | -X if any"): 0 for none, never below this. */
export const RED_FLAGS_FLOOR = -3;
export const EVIDENCE_TEXT_MAX = 240;

/** career-ops Score interpretation bands, applied to the Global score. */
export type Decision = 'apply_now' | 'apply' | 'consider' | 'skip';
export const BAND_APPLY_NOW = 4.5;
export const BAND_APPLY = 4.0;
export const BAND_CONSIDER = 3.5;

export interface CareerOpsDims {
  rubric: typeof RUBRIC_TAG;
  cv_match: number;
  north_star: number;
  comp: number;
  culture: number;
  red_flags: number;
  global: number;
  /** The detected archetype, or null when the role matches none of the owner's targets ("Not a target"). */
  archetype: string | null;
  /** One short quote or observation per dimension. */
  evidence: Partial<Record<CoEvidenceKey, string>>;
  /** Derived in code from `global`, never taken from the model. */
  decision: Decision;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const oneDecimal = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n * 10 - Math.round(n * 10)) < 1e-9;

/** Decision band of a Global score (career-ops "Score interpretation"). */
export function decisionOf(global: number): Decision {
  if (global >= BAND_APPLY_NOW) return 'apply_now';
  if (global >= BAND_APPLY) return 'apply';
  if (global >= BAND_CONSIDER) return 'consider';
  return 'skip';
}

/** The stored score of a Global score: the Global itself on the 1..5 scale, one decimal. 3.9 -> 3.9, 4.0 -> 4.0. */
export const storedScoreOf = (global: number): number => round1(global);
/** One decimal rounding, shared by the score code (3.45 -> 3.5). */
export const roundScore = round1;
/** An old 0..100 stored score on the 1..5 scale (the db migration and the old MATCH_THRESHOLD reading): 72 -> 3.6. */
export const legacyScoreTo5 = (score: number): number => round1(score / 20);

export type CoParse = { ok: true; dims: CareerOpsDims; clamped: number } | { ok: false; error: string };

/**
 * Validate an incoming career_ops_v1 score_dims object. Each of cv_match, north_star, comp, culture and global is a number from 1 to 5 with
 * at most one decimal; red_flags is a number from -3 to 0 with at most one decimal. The Global score is the model's holistic call (career-ops
 * has no formula), but it may not be higher than the best positive dimension (the one code guard; the clamp is reported through `clamped`).
 * `decision` is always derived here from `global`.
 */
export function parseCareerOpsDims(raw: unknown): CoParse {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'score_dims must be an object' };
  const o = raw as Record<string, unknown>;
  if (o.rubric !== undefined && o.rubric !== RUBRIC_TAG) return { ok: false, error: `score_dims.rubric must be "${RUBRIC_TAG}"` };
  const num: Record<string, number> = {};
  for (const k of [...CO_DIMS, 'global'] as const) {
    const v = o[k];
    if (!oneDecimal(v) || v < CO_MIN || v > CO_MAX) return { ok: false, error: `invalid score_dims.${k}: ${String(v)} (a number from ${CO_MIN} to ${CO_MAX}, one decimal)` };
    num[k] = round1(v);
  }
  const rf = o.red_flags;
  if (!oneDecimal(rf) || rf > 0 || rf < RED_FLAGS_FLOOR) return { ok: false, error: `invalid score_dims.red_flags: ${String(rf)} (0 for none, else a negative number down to ${RED_FLAGS_FLOOR}, one decimal)` };
  const best = Math.max(...CO_DIMS.map((k) => num[k]!));
  const clamped = num.global! > best ? num.global! : 0;
  const global = Math.min(num.global!, best);
  const evidence: Partial<Record<CoEvidenceKey, string>> = {};
  const ev = o.evidence;
  if (ev && typeof ev === 'object' && !Array.isArray(ev)) {
    for (const k of CO_EVIDENCE_KEYS) {
      const t = (ev as Record<string, unknown>)[k];
      if (typeof t === 'string' && t.trim()) evidence[k] = t.replace(/\s+/g, ' ').trim().slice(0, EVIDENCE_TEXT_MAX);
    }
  }
  const archetype = typeof o.archetype === 'string' && o.archetype.trim() ? o.archetype.replace(/\s+/g, ' ').trim().slice(0, 120) : null;
  return {
    ok: true, clamped,
    dims: {
      rubric: RUBRIC_TAG, cv_match: num.cv_match!, north_star: num.north_star!, comp: num.comp!, culture: num.culture!,
      red_flags: round1(rf === 0 ? 0 : rf), global, archetype, evidence, decision: decisionOf(global),
    },
  };
}

// --- rubric_v2 (the rubric before career_ops_v1). Kept so old rows, the settings key and the re-check script keep working. ---

export const DIM_KEYS = ['role_fit', 'skills', 'seniority_comp', 'location', 'flags'] as const;
export type DimKey = (typeof DIM_KEYS)[number];
export type RubricDims = Record<DimKey, number>;
export const DIM_MAX = 20;

/** Per-dimension minimums of rubric_v2 (MATCH_DIM_MINIMUMS). Used only for rows saved under rubric_v2; career_ops_v1 has no per-dimension minimums. */
export const DEFAULT_DIM_MINIMUMS: Readonly<RubricDims> = Object.freeze({ role_fit: 12, skills: 10, seniority_comp: 8, location: 8, flags: 10 });

export interface DimMinimums { mins: RubricDims; invalid?: string }

/**
 * MATCH_DIM_MINIMUMS: a comma list `role_fit=12,skills=10,seniority_comp=8,location=8,flags=10`. Keys not listed keep their default.
 * Blank or unset = defaults. Anything invalid (unknown key, duplicate, not a whole number 0..20, bad shape) = ALL defaults plus `invalid`
 * (the doctor shows it as a warning); a half-read list is never used.
 */
export function parseDimMinimums(raw: string | undefined | null): DimMinimums {
  const defaults = { ...DEFAULT_DIM_MINIMUMS };
  if (raw === undefined || raw === null || raw.trim() === '') return { mins: defaults };
  const mins = { ...DEFAULT_DIM_MINIMUMS };
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const m = /^\s*([a-z_]+)\s*=\s*(\d+)\s*$/.exec(part);
    if (!m) return { mins: defaults, invalid: `"${part.trim().slice(0, 40)}" is not key=number` };
    const key = m[1] as DimKey;
    if (!(DIM_KEYS as readonly string[]).includes(key)) return { mins: defaults, invalid: `unknown dimension "${m[1]}" (use ${DIM_KEYS.join(', ')})` };
    if (seen.has(key)) return { mins: defaults, invalid: `${key} is listed twice` };
    seen.add(key);
    const n = Number(m[2]);
    if (n > DIM_MAX) return { mins: defaults, invalid: `${key}=${n} is above ${DIM_MAX}` };
    mins[key] = n;
  }
  return { mins };
}

export const dimMinimumsFromEnv = (env: Record<string, string | undefined> = process.env): DimMinimums => parseDimMinimums(env.MATCH_DIM_MINIMUMS);

/**
 * Parse a MATCH_THRESHOLD value, on the 1..5 scale of the stored score (default 4.0, career-ops "worth applying"). A number from 0 to 5 is
 * used as is (3.5, 4, 4.5). For backward compatibility a number above 5 and up to 100 is read as an old 0..100 value and divided by 20
 * (60 -> 3.0, 80 -> 4.0) with a `warning` (the doctor shows it). Plain decimal digits only (no sign, no exponent). Blank = the default,
 * no error. Anything else, or above 100 = the default plus `invalid` (the doctor shows it).
 */
export function parseMatchThreshold(raw: string | undefined | null): { value: number; invalid?: string; warning?: string } {
  const t = (raw ?? '').trim();
  if (t === '') return { value: DEFAULT_MATCH_THRESHOLD };
  if (!/^\d+(\.\d+)?$/.test(t)) return { value: DEFAULT_MATCH_THRESHOLD, invalid: `"${t.slice(0, 40)}" is not a number (use 4.0 on the 1 to 5 scale)` };
  const n = Number(t);
  if (!Number.isFinite(n) || n > 100) return { value: DEFAULT_MATCH_THRESHOLD, invalid: `${t.slice(0, 40)} is above 5 (use a number from 1 to 5, for example 4.0)` };
  if (n <= 5) return { value: n };
  const value = legacyScoreTo5(n);
  return { value, warning: `MATCH_THRESHOLD=${t} is an old 0 to 100 value, read as ${value.toFixed(1)} on the 1 to 5 scale; write MATCH_THRESHOLD=${value.toFixed(1)} instead` };
}

/** MATCH_THRESHOLD as the loaders read it: the 1..5 scale, default 4.0 (an old 0..100 value is converted, see parseMatchThreshold). */
export function matchThresholdFromEnv(env: Record<string, string | undefined> = process.env): number {
  return parseMatchThreshold(env.MATCH_THRESHOLD).value;
}

/** The rubric_v2 dimensions below their minimum, in rubric order. */
export function failedDims(dims: RubricDims, mins: Readonly<RubricDims> = DEFAULT_DIM_MINIMUMS): DimKey[] {
  return DIM_KEYS.filter((k) => dims[k] < mins[k]);
}

export const sumDims = (d: RubricDims): number => DIM_KEYS.reduce((a, k) => a + d[k], 0);

const LEGACY_KEYS = ['skills', 'seniority', 'domain', 'location'] as const;
/** `career_ops` = career_ops_v1; `rubric_v2` = the five 0..20 keys; `legacy` = the old four 0..25 keys; `none` = no dimensions. */
export type DimsKind = 'career_ops' | 'rubric_v2' | 'legacy' | 'none';

/** What shape a stored or incoming score_dims object has. */
export function dimsKind(d: unknown): DimsKind {
  if (!d || typeof d !== 'object') return 'none';
  const o = d as Record<string, unknown>;
  if (o.rubric === RUBRIC_TAG || 'cv_match' in o || 'north_star' in o) return 'career_ops';
  if ('role_fit' in o || 'seniority_comp' in o || 'flags' in o) return 'rubric_v2';
  if (LEGACY_KEYS.some((k) => k in o)) return 'legacy';
  return 'none';
}

/** Parse the jobs.score_dims column. Corrupt JSON reads as `none`. */
export function parseStoredDims(text: string | null | undefined): { kind: DimsKind; dims: Record<string, any> | null } {
  if (!text) return { kind: 'none', dims: null };
  try {
    const v = JSON.parse(text);
    const kind = dimsKind(v);
    return { kind, dims: kind === 'none' ? null : (v as Record<string, any>) };
  } catch {
    return { kind: 'none', dims: null };
  }
}

/**
 * SQL for "this job counts as matched": the stored score (1..5) reaches the threshold, OR the row was grandfathered by the scale migration
 * (`jobs.grandfathered = 1`: an older-rubric row that was matched, or any row that was already queued or prepared, when the scores moved
 * to the 1..5 scale; a fresh match save clears the flag). Two binds: (threshold, threshold). The flag counts only while the threshold is a
 * real 1..5 value (callers pass 101 for "no threshold"), so "no threshold" still matches nothing. Pass an alias for a joined table.
 */
export const matchedSql = (alias = ''): string => {
  const a = alias ? `${alias}.` : '';
  return `(${a}score >= ? OR (COALESCE(${a}grandfathered, 0) = 1 AND ? <= 5))`;
};
export const MATCHED_SQL = matchedSql();
export const matchedBinds = (threshold: number): [number, number] => [threshold, threshold];

/** Human label for reports and the dashboard. Older shapes are labelled and keep their stored score. */
export function dimsLabel(text: string | null | undefined): string {
  const { kind, dims } = parseStoredDims(text);
  if (kind === 'career_ops' && dims) {
    return `career-ops: CV match ${dims.cv_match}, North Star ${dims.north_star}, Comp ${dims.comp}, Culture ${dims.culture}, Red flags ${dims.red_flags}, Global ${dims.global}`;
  }
  if (kind === 'rubric_v2' && dims) return `rubric_v2: ${DIM_KEYS.map((k) => `${k} ${dims[k]}`).join(', ')}`;
  if (kind === 'legacy' && dims) return `legacy: skills ${dims.skills}, seniority ${dims.seniority}, domain ${dims.domain}, location ${dims.location}`;
  return 'no dimensions';
}

export interface PassInput {
  /** The stored 1..5 score (the Global, after the evidence ceiling and the injection cap). */
  score: number;
  threshold: number;
  locationVerdict?: 'PASS' | 'FAIL' | 'FLAG';
  hardStops?: string[];
}
/**
 * The pass rule of career_ops_v1: the Global score reaches the cutoff (MATCH_THRESHOLD, default 4.0 of 5, career-ops "worth applying"),
 * plus the two code gates career-ops does not have and we keep: no location FAIL and no hard stop. `why` lists every failure.
 */
export function passRule(i: PassInput): { ok: boolean; why: string[] } {
  const why: string[] = [];
  if (i.score < i.threshold) why.push('below_threshold');
  if (i.locationVerdict === 'FAIL') why.push('location_fail');
  if (i.hardStops?.length) why.push('hard_stop');
  return { ok: why.length === 0, why };
}

/** The rubric tag of a stored row for reports: `career_ops_v1`, `rubric_v2`, `legacy` or `none`. */
export function rubricOfStored(text: string | null | undefined): 'career_ops_v1' | 'rubric_v2' | 'legacy' | 'none' {
  const k = parseStoredDims(text).kind;
  return k === 'career_ops' ? RUBRIC_TAG : k;
}
