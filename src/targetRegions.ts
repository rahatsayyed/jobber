// Target regions for the location gate (config/target-regions.json). The match-jobs skill judges location with the regions the caller passes;
// this module is the deterministic backstop used by applyVetoes: a matcher FAIL for a posting that names a target region becomes a visible FLAG,
// never a silent pass and never an exclusion on location grounds alone. Missing file = the built-in defaults; an invalid file = null (callers flag it).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TargetRegions {
  /** Regions where the candidate lives (on-site there passes): India. */
  home: string[];
  /** Regions the candidate would relocate to or already can work in: on-site there is a FLAG (visa, residency, relocation), not a FAIL. */
  targets: string[];
  /** Remote roles that accept the candidate are acceptable. */
  remote: boolean;
  /** Remote roles based in any other country are acceptable unless the posting restricts eligibility (see src/remotePolicy.ts). Default false. */
  remote_anywhere: boolean;
}

export const GULF_TERMS = [
  'United Arab Emirates', 'UAE', 'Dubai', 'Abu Dhabi', 'Sharjah', 'Saudi Arabia', 'KSA', 'Riyadh', 'Jeddah', 'Qatar', 'Doha',
  'Kuwait', 'Bahrain', 'Oman', 'Muscat', 'GCC', 'Middle East', 'MENA',
  'Manama', 'Kuwait City', 'Ajman', 'Ras Al Khaimah', 'Dammam', 'Al Khobar', 'Salalah',
  // Arabic script (exact substring match; the portals.json allow list carries the same names)
  'دبي', 'أبوظبي', 'الرياض', 'الدوحة', 'مسقط', 'الكويت', 'المنامة', 'الإمارات', 'السعودية', 'قطر', 'البحرين',
];
/** Region-wide words: they stay in the board allow list but never trigger the location downgrade ("we sell to the Middle East"). */
export const BROAD_TERMS = ['GCC', 'Middle East', 'MENA'];
export const DEFAULT_TARGET_REGIONS: TargetRegions = { home: ['India'], targets: GULF_TERMS, remote: true, remote_anywhere: false };

const defaultPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'config', 'target-regions.json');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const terms = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() && x.length <= 60) && v.length <= 100 ? (v as string[]).map((x) => x.trim()) : null;

export function loadTargetRegionsStatus(file: string = defaultPath): { config: TargetRegions | null; invalid?: string } {
  if (!existsSync(file)) return { config: DEFAULT_TARGET_REGIONS };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const home = terms(raw?.home);
    const targets = terms(raw?.targets);
    if (!home || !home.length) return { config: null, invalid: 'home must be a non-empty array of short strings' };
    if (!targets) return { config: null, invalid: 'targets must be an array of at most 100 short strings' };
    if (raw.remote !== undefined && typeof raw.remote !== 'boolean') return { config: null, invalid: 'remote must be true or false' };
    // remote_anywhere: only the boolean true switches it on; absent or invalid means false (fail safe).
    return { config: { home, targets, remote: raw.remote !== false, remote_anywhere: raw.remote_anywhere === true } };
  } catch (e: any) {
    return { config: null, invalid: String(e?.message ?? e).slice(0, 120) };
  }
}

/** First target region named in the text (whole words, case-insensitive, so "Doha" never matches inside another word), else null. */
export function mentionedTargetRegion(text: string, targets: string[]): string | null {
  const hay = fold(text);
  for (const t of targets) {
    const term = fold(t).trim();
    if (term && new RegExp(`(?<![a-z0-9])${esc(term)}(?![a-z0-9])`).test(hay)) return t;
  }
  return null;
}

const fold = (s: unknown) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const broad = new Set(BROAD_TERMS.map((t) => t.toLowerCase()));
/** Targets that may trigger the downgrade: every target except the region-wide words. */
export const specificTargets = (targets: string[]): string[] => targets.filter((t) => t.trim() && !broad.has(t.trim().toLowerCase()));

const ONSITE_WORD = /(?<![a-z0-9])(?:on-?site|onsite|located|based|office|relocat\w*|headquarter\w*)/g;
const NEAR_CHARS = 80;
// "alternatives" next to a hit ("London or Dubai", "London / Dubai"): the role may be in the other place, so the hit proves nothing.
const altNear = (s: string, at: number, len: number) => /(?<![a-z])or(?![a-z])|\//.test(s.slice(Math.max(0, at - 12), at) + ' ' + s.slice(at + len, at + len + 12));
// "onsite in Berlin", "located in the Netherlands", "Location: Austin": the place named right after on-site wording (original case: a place is capitalised).
const PLACE_AFTER = /(?:[Oo]n-?[Ss]ite|[Ll]ocated|[Bb]ased|[Oo]ffice|[Hh]ybrid|[Ll]ocation)(?:\s+(?:in|at)|\s*:)\s+(?:the\s+)?([A-Z][^\s,.;:()]*(?:\s+[A-Z][^\s,.;:()]*){0,2})/g;

/**
 * Evidence that a posting really sits in a target region, used only to downgrade a model location FAIL to a FLAG. Rules, in order
 * (the caller has already refused anything with a restriction marker):
 *  1. a specific target term in the job's LOCATION field: hit (even "London; Dubai": a multi-location listing is shown as a FLAG);
 *  2. on-site wording in the title or description that names a non-target place ("Onsite in Berlin"): no hit (the FAIL stays);
 *  3. a specific target term in the TITLE (not next to "or" or "/"): hit;
 *  4. a specific target term in the description within 80 characters of on-site/located/based/office/relocation/headquarter wording
 *     (not next to "or" or "/"): hit.
 * Region-wide words (GCC, Middle East, MENA) never count. A target name that merely appears ("Dubai Mall", "we sell to Dubai") is not a hit.
 * Returns the matched target term, or null.
 */
export function targetRegionEvidence(job: { title: string; description: string; location?: string | null }, targets: string[]): string | null {
  const specific = specificTargets(targets);
  if (!specific.length) return null;
  const res = specific.map((t) => ({ t, re: new RegExp(`(?<![a-z0-9])${esc(fold(t).trim())}(?![a-z0-9])`) }));
  const locHit = mentionedTargetRegion(String(job.location ?? ''), specific);
  if (locHit) return locHit;
  const rawTitle = String(job.title ?? '');
  const rawDesc = String(job.description ?? '').slice(0, 20000);
  const startsWithTarget = (p: string) =>
    res.some((x) => new RegExp(`^${esc(fold(x.t).trim())}(?![a-z0-9])`).test(fold(p)));
  for (const m of `${rawTitle}\n${rawDesc}`.matchAll(PLACE_AFTER)) if (!startsWithTarget(m[1])) return null;
  const title = fold(rawTitle);
  for (const x of res) { const m = x.re.exec(title); if (m && !altNear(title, m.index, m[0].length)) return x.t; }
  const d = fold(rawDesc);
  for (const w of d.matchAll(ONSITE_WORD)) {
    const at = w.index ?? 0;
    const lo = Math.max(0, at - NEAR_CHARS);
    const win = d.slice(lo, at + w[0].length + NEAR_CHARS);
    for (const x of res) { const m = x.re.exec(win); if (m && !altNear(win, m.index, m[0].length)) return x.t; }
  }
  return null;
}
