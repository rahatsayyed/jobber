// Rotation of the named discovery searches: the least recently TRIED search goes first, so a small per-wake quota
// cycles through all of them instead of always repeating the first names of the config file.
import { getState, setState } from '../scheduler/runLog.js';

type Db = Parameters<typeof getState>[0];
type Tool = 'search_jobs' | 'search_posts';

export const searchAttemptKey = (tool: Tool, name: string): string => `linkedin_discover_try:${tool}:${name}`;

/** Marks one search as tried now (called when a search starts, so a failing search does not block the rotation). */
export function markSearchTried(db: Db, tool: Tool, name: string, now: Date): void {
  setState(db, searchAttemptKey(tool, name), now.toISOString(), now);
}

/** Names never tried first (config order), then the oldest attempt first (ties keep config order). */
export function rotateNames(db: Db, tool: Tool, names: string[]): string[] {
  const at = (n: string): number => {
    const v = getState(db, searchAttemptKey(tool, n));
    const t = v ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  return names
    .map((n, i) => ({ n, i, t: at(n) }))
    .sort((a, b) => (a.t === b.t ? a.i - b.i : a.t < b.t ? -1 : 1))
    .map((x) => x.n);
}
