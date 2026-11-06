// file: src/matchRubric.ts
// The five-dimension match rubric (adapted from career-ops-hq/career-ops, MIT): role_fit (North Star), skills (match with the CV),
// seniority_comp (level and pay/employment type), location (verdict and language), flags (inverse red flags, 20 = clean).
// Each dimension is an integer 0..20, the score is their sum (0..100), summed in code. A job moves ahead only when EVERY dimension
// meets its minimum AND the sum reaches MATCH_THRESHOLD AND the location verdict is not FAIL AND there is no hard stop.

export const DIM_KEYS = ['role_fit', 'skills', 'seniority_comp', 'location', 'flags'] as const;
export type DimKey = (typeof DIM_KEYS)[number];
export type RubricDims = Record<DimKey, number>;
export const DIM_MAX = 20;

/** Per-dimension minimums used when MATCH_DIM_MINIMUMS is unset or invalid. */
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

/** MATCH_THRESHOLD as the loaders read it: a whole number 0..100, default 60. */
export function matchThresholdFromEnv(env: Record<string, string | undefined> = process.env): number {
  const t = env.MATCH_THRESHOLD?.trim();
  if (!t || !/^\d+$/.test(t)) return 60;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : 60;
}

/** The dimensions below their minimum, in rubric order. */
export function failedDims(dims: RubricDims, mins: Readonly<RubricDims> = DEFAULT_DIM_MINIMUMS): DimKey[] {
  return DIM_KEYS.filter((k) => dims[k] < mins[k]);
}

export const sumDims = (d: RubricDims): number => DIM_KEYS.reduce((a, k) => a + d[k], 0);

const LEGACY_KEYS = ['skills', 'seniority', 'domain', 'location'] as const;
export type DimsKind = 'rubric' | 'legacy' | 'none';

/** What shape a stored or incoming score_dims object has. Old rows (skills, seniority, domain, location, each 0..25) are `legacy`. */
export function dimsKind(d: unknown): DimsKind {
  if (!d || typeof d !== 'object') return 'none';
  const o = d as Record<string, unknown>;
  if ('role_fit' in o || 'seniority_comp' in o || 'flags' in o) return 'rubric';
  if (LEGACY_KEYS.some((k) => k in o)) return 'legacy';
  return 'none';
}

/** Parse the jobs.score_dims column. Corrupt JSON reads as `none`. */
export function parseStoredDims(text: string | null | undefined): { kind: DimsKind; dims: Record<string, number> | null } {
  if (!text) return { kind: 'none', dims: null };
  try {
    const v = JSON.parse(text);
    const kind = dimsKind(v);
    return { kind, dims: kind === 'none' ? null : (v as Record<string, number>) };
  } catch {
    return { kind: 'none', dims: null };
  }
}

/** Human label for reports and the dashboard: a legacy row keeps its stored score and is labelled `legacy`. */
export function dimsLabel(text: string | null | undefined): string {
  const { kind, dims } = parseStoredDims(text);
  if (kind === 'legacy' && dims) return `legacy: skills ${dims.skills}, seniority ${dims.seniority}, domain ${dims.domain}, location ${dims.location}`;
  if (kind === 'rubric' && dims) return DIM_KEYS.map((k) => `${k} ${dims[k]}`).join(', ');
  return 'no dimensions';
}

export interface PassInput {
  dims: RubricDims;
  sum: number;
  threshold: number;
  mins?: Readonly<RubricDims>;
  locationVerdict?: 'PASS' | 'FAIL' | 'FLAG';
  hardStops?: string[];
}
/** The pass rule. `ok` only when all of it holds; `why` lists every failure (`dim_min:<dim>`, `below_threshold`, `location_fail`, `hard_stop`). */
export function passRule(i: PassInput): { ok: boolean; why: string[] } {
  const why: string[] = [];
  for (const k of failedDims(i.dims, i.mins)) why.push(`dim_min:${k}`);
  if (i.sum < i.threshold) why.push('below_threshold');
  if (i.locationVerdict === 'FAIL') why.push('location_fail');
  if (i.hardStops?.length) why.push('hard_stop');
  return { ok: why.length === 0, why };
}
