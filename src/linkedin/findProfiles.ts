// Typed, read-only people search. Never clicks, types or sends. The only write is the people
// rows (and their contact_state) for code-verified candidates, also in dry runs (decision D4).
import { haltReason } from '../outreach/limits.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { upsertPerson } from '../outreach/people.js';
import { gateField, MAX_FIELD_CHARS } from './state.js';
import { classifyUrl, isBlockedPath, isLinkedInUrl, isProfileUrl, profileKeyOf } from './urls.js';
import { layoutClassOf } from './layoutGuard.js';
import type { ToolDeps } from './toolDeps.js';

export type FindProfilesCategory = 'recruiter' | 'hiring_manager' | 'peer';
export interface FindProfilesArgs { company: string; role_hint?: string; category: FindProfilesCategory }
export interface ProfileCandidateOut { profile_url: string; name: string; headline: string }
export interface FindProfilesResult {
  status: 'ok' | 'rate_limited' | 'halted' | 'failed';
  code: string;
  candidates: ProfileCandidateOut[];
  injection_suspected?: boolean;
  /** Layout verdict class for the search page (advisory; never a refusal). */
  layout?: string;
}

const CATEGORIES: readonly string[] = ['recruiter', 'hiring_manager', 'peer'];
const clean = (s: unknown): string =>
  String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
const fail = (code: string): FindProfilesResult => ({ status: 'failed', code, candidates: [] });

/** Canonical https://www.linkedin.com/in/<slug>, or null when the href is not a clean profile link. */
export function canonicalProfile(href: string): string | null {
  const abs = href.startsWith('/') && !href.startsWith('//') ? `https://www.linkedin.com${href}` : href;
  if (!isLinkedInUrl(abs) || !isProfileUrl(abs) || isBlockedPath(abs).blocked) return null;
  let path: string;
  try { path = new URL(abs).pathname; } catch { return null; }
  const m = /^\/in\/([^/]+)/.exec(path);
  if (!m) return null;
  const url = `https://www.linkedin.com/in/${m[1]}`;
  return isProfileUrl(url) ? url : null;
}

export async function findProfiles(a: FindProfilesArgs, deps: ToolDeps): Promise<FindProfilesResult> {
  if (haltReason(deps.db, 'linkedin')) return { status: 'halted', code: 'halted', candidates: [] };
  const company = clean(a.company);
  const hint = clean(a.role_hint);
  if (!company) return fail('bad_input');
  if (!CATEGORIES.includes(a.category)) return fail('bad_input');
  const keywords = `${company} ${hint || 'recruiter hiring manager talent acquisition'}`;
  const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;

  if (!checkAndIncrement(deps.db, 'linkedin_search', deps.cfg.maxSearchesPerDay)) {
    return { status: 'rate_limited', code: 'search_limit', candidates: [] };
  }
  const r = await deps.rt.open(url);
  if (!r.ok) return r.code === 'halted' ? { status: 'halted', code: 'halted', candidates: [] } : fail(r.code);
  const snap = r.snapshot;
  if (classifyUrl(snap.url) !== 'search') return fail('not_search_page');
  // The runtime's open() already showed the search page to the layout observer; report its verdict only.
  const layout = layoutClassOf(deps.rt, 'find_profiles');

  let injection = false;
  const seen = new Set<string>();
  const cands: ProfileCandidateOut[] = [];
  for (const card of snap.results.slice(0, 3)) {
    const profile_url = canonicalProfile(String(card.href ?? '').trim());
    if (!profile_url) continue;
    const name = gateField(String(card.name ?? ''), MAX_FIELD_CHARS.name);
    if (name.blocked) { injection = true; continue; }
    if (!name.text) continue;
    const head = gateField(String(card.headline ?? ''), MAX_FIELD_CHARS.headline);
    if (head.blocked) injection = true;
    const key = profileKeyOf(profile_url);
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push({ profile_url, name: name.text, headline: head.blocked ? '' : head.text });
  }

  if (cands.length === 0) {
    return { status: 'ok', code: 'no_candidates', candidates: [], ...(injection ? { injection_suspected: true } : {}), ...layout };
  }
  const verdict = await deps.screen(cands.map((c) => `${c.name}\n${c.headline}`).join('\n'), 'read');
  if (verdict.blocked) return { status: 'failed', code: verdict.code, candidates: [], injection_suspected: true };

  for (const c of cands) {
    upsertPerson(deps.db, {
      platform: 'linkedin',
      profileKey: profileKeyOf(c.profile_url),
      name: c.name,
      headline: c.headline,
      company,
      category: a.category,
    });
  }
  return { status: 'ok', code: cands.length ? 'found' : 'no_candidates', candidates: cands, ...(injection ? { injection_suspected: true } : {}), ...layout };
}
