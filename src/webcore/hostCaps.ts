// Per-host daily apply cap (O-limits). Order: APPLY_MAX_PER_HOST_<ID> -> APPLY_MAX_PER_HOST -> 10.
// Empty or non-integer values are invalid and fall through; an integer outside 1..50 is clamped
// (with a warning the doctor shows) and does not fall through. The counter itself lives in the
// apply_host_day table; the applier (plan 8G task 18) consumes it.
export const APPLY_HOST_PLATFORM_IDS = [
  'greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'workday', 'recruitee', 'personio', 'browser',
] as const;

export const DEFAULT_HOST_CAP = 10;
export const MIN_HOST_CAP = 1;
export const MAX_HOST_CAP = 50;
export const TOP_LEVEL_KEY = 'APPLY_MAX_PER_HOST';

export type HostCapSource = 'specific' | 'top_level' | 'default';

export function hostCapKey(platformId: string): string {
  return `${TOP_LEVEL_KEY}_${platformId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

type Parsed = { cap: number; warning?: string } | null;

function parseCap(key: string, raw: string | undefined): Parsed {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_HOST_CAP) return { cap: MIN_HOST_CAP, warning: `${key}=${t} is below ${MIN_HOST_CAP}; using ${MIN_HOST_CAP}` };
  if (n > MAX_HOST_CAP) return { cap: MAX_HOST_CAP, warning: `${key}=${t} is above ${MAX_HOST_CAP}; using ${MAX_HOST_CAP}` };
  return { cap: n };
}

export function resolveHostCap(
  platformId: string, env: NodeJS.ProcessEnv = process.env,
): { cap: number; source: HostCapSource; warnings: string[] } {
  const specificKey = hostCapKey(platformId);
  const specific = parseCap(specificKey, env[specificKey]);
  if (specific) return { cap: specific.cap, source: 'specific', warnings: specific.warning ? [specific.warning] : [] };
  const top = parseCap(TOP_LEVEL_KEY, env[TOP_LEVEL_KEY]);
  if (top) return { cap: top.cap, source: 'top_level', warnings: top.warning ? [top.warning] : [] };
  return { cap: DEFAULT_HOST_CAP, source: 'default', warnings: [] };
}

/** Every clamp across the whole family, once each, for the doctor (task 24). */
export function hostCapWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  const top = parseCap(TOP_LEVEL_KEY, env[TOP_LEVEL_KEY]);
  if (top?.warning) out.add(top.warning);
  for (const id of APPLY_HOST_PLATFORM_IDS) {
    const k = hostCapKey(id);
    const s = parseCap(k, env[k]);
    if (s?.warning) out.add(s.warning);
  }
  return [...out];
}
