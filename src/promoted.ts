// Promoted jobs (employers paying for visibility on Naukri and Wellfound are usually hiring now): the shared marker matcher,
// the lane and tie-break rules. Pure, no I/O. The per-platform marker lists live in src/naukri/promoted.ts and
// src/wellfound/promoted.ts. Promotion only changes the ORDER work is taken in: it never changes a stored score, never lowers
// the match threshold and never bypasses a veto, hard stop or the threshold.

/** Share of one page (and of the match batch overall) the promoted-first lane may take, so the round-robin by source still runs. */
export const PROMOTED_LANE_FRACTION = 0.4;
/** Added to the stored score ONLY to order the prepare pool; never stored, never compared with the threshold. */
export const PROMOTED_TIEBREAK_BONUS = 3;

/** Largest promoted-first lane for a page of `size` rows (40 percent, rounded down). */
export function promotedLaneSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.floor(Math.trunc(size) * PROMOTED_LANE_FRACTION + 1e-9);
}

export interface PromotedSignals {
  /** Short badge or label texts read from the card (never the description or snippet). */
  badges?: unknown;
  /** class names, aria-labels and data attributes of the card and its badge elements. */
  attrs?: unknown;
}

/** A badge text longer than this is not a badge (it is body text), so it is ignored. */
const BADGE_MAX_CHARS = 40;

/** Lowercase word tokens of a string: camelCase, digits, `-`, `_` and punctuation all separate words. */
export function wordTokens(s: string): string[] {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

/**
 * True when any badge text or attribute carries one of `words` (single words) or `phrases` (adjacent words, such as "hot job").
 * Case-insensitive word match, never a substring ("unsponsored" is not "sponsored").
 * Only the badge and attribute channels are read: a caller must not pass description text.
 */
export function matchPromotedSignals(sig: PromotedSignals | null | undefined, words: readonly string[], phrases: readonly (readonly string[])[]): boolean {
  if (!sig || typeof sig !== 'object') return false;
  const strings: string[] = [];
  const add = (v: unknown, max: number): void => {
    if (typeof v === 'string' && v.length > 0 && v.length <= max) strings.push(v);
  };
  if (Array.isArray(sig.badges)) for (const b of sig.badges.slice(0, 20)) add(b, BADGE_MAX_CHARS);
  else add(sig.badges, BADGE_MAX_CHARS);
  if (Array.isArray(sig.attrs)) for (const a of sig.attrs.slice(0, 40)) add(a, 200);
  else add(sig.attrs, 200);
  for (const s of strings) {
    const toks = wordTokens(s);
    if (toks.some((t) => words.includes(t))) return true;
    for (const p of phrases) {
      for (let i = 0; i + p.length <= toks.length; i++) {
        if (p.every((w, k) => toks[i + k] === w || toks[i + k] === `${w}s`)) return true;
      }
    }
  }
  return false;
}

/** Order for the P4 prepare pool: stored score (+3 for a promoted job, ordering only), then promoted, then already matched. Stable. */
export function sortPreparePool<T extends { score: number; promoted?: boolean; already_matched?: boolean }>(pool: readonly T[]): T[] {
  const eff = (j: T): number => j.score + (j.promoted ? PROMOTED_TIEBREAK_BONUS : 0);
  return pool
    .map((j, i) => ({ j, i }))
    .sort((a, b) =>
      eff(b.j) - eff(a.j)
      || Number(!!b.j.promoted) - Number(!!a.j.promoted)
      || Number(!!b.j.already_matched) - Number(!!a.j.already_matched)
      || a.i - b.i)
    .map((x) => x.j);
}

/**
 * Orders `items` (already in the normal order) into pages of `pageSize`: each page takes up to promotedLaneSize(pageSize) promoted items
 * first (in their normal order), then fills the page from the remaining NON-promoted items in the normal order (a promoted item past the
 * lane waits for a later page unless nothing else is left), so no promoted backlog can crowd out the round-robin.
 */
export function laneOrder<T extends { promoted?: boolean }>(items: readonly T[], pageSize: number): T[] {
  const size = Math.max(1, Math.trunc(pageSize));
  const lane = promotedLaneSize(size);
  const rest = [...items];
  const out: T[] = [];
  while (rest.length) {
    const page: T[] = [];
    for (let i = 0; i < rest.length && page.length < lane;) {
      if (rest[i].promoted) page.push(...rest.splice(i, 1)); else i++;
    }
    // Fill from the non-promoted items first (strict cap); promoted items only fill a page when nothing else is left.
    while (page.length < size && rest.length) {
      const k = rest.findIndex((x) => !x.promoted);
      page.push(...rest.splice(k === -1 ? 0 : k, 1));
    }
    out.push(...page);
  }
  return out;
}
