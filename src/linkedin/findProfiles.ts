// Typed, read-only people discovery. Never clicks, types or sends. Layered (LINKEDIN_PEOPLE_SEARCH_SOURCES,
// default engine,serper): a no-login search-engine query first, then Serper, and, only when the owner adds
// `linkedin` to the list, LinkedIn's own logged-in people-search page (the only layer that touches LinkedIn, under
// MAX_LINKEDIN_SEARCHES_PER_DAY and the LinkedIn active hours). The only write is the people rows (and their contact_state) for
// code-verified candidates, also in dry runs (decision D4). Search-engine and Serper text is untrusted,
// exactly like page text: same field gate, same classifier screen, same employer check.
import { haltReason } from '../outreach/limits.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { upsertPerson } from '../outreach/people.js';
import { gateField, MAX_FIELD_CHARS } from './state.js';
import { classifyUrl, isBlockedPath, isLinkedInUrl, isProfileUrl, profileKeyOf } from './urls.js';
import { layoutClassOf } from './layoutGuard.js';
import { linkedinActiveNow, OUTSIDE_ACTIVE_HOURS_CODE } from './activeHours.js';
import { classifyCategory, headlineMatchesCompany } from './employer.js';
import type { ToolDeps } from './toolDeps.js';
import { searchWithBudget, type SearchResult } from '../search/index.js';

export type FindProfilesCategory = 'recruiter' | 'hiring_manager' | 'peer';
export interface FindProfilesArgs { company: string; role_hint?: string; category: FindProfilesCategory }
export interface ProfileCandidateOut {
  profile_url: string; name: string; headline: string;
  /** Set by code from the headline (never the model's request alone). */
  category?: FindProfilesCategory | 'connection';
  /** true: headline names the company; false: it names another employer; null: no headline. */
  employer_match?: boolean | null;
}
export interface FindProfilesResult {
  status: 'ok' | 'rate_limited' | 'halted' | 'failed';
  code: string;
  candidates: ProfileCandidateOut[];
  injection_suspected?: boolean;
  /** Layout verdict class for the search page (advisory; never a refusal). */
  layout?: string;
  /** Which layer produced the candidates (telemetry): the search engine, Serper or the LinkedIn people-search page. */
  source?: 'search_engine' | 'google_pse' | 'tavily' | 'serper' | 'linkedin';
}

/** Same rule as the MCP wrapper: under the test runner the window applies only when the env names LINKEDIN_ACTIVE_HOURS. */
function activeHoursOk(deps: ToolDeps): boolean {
  if (process.env.VITEST !== undefined && deps.env.LINKEDIN_ACTIVE_HOURS === undefined) return true;
  return linkedinActiveNow(deps.env, deps.now());
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

interface RawCard { href: string; name: string; headline: string }
type Source = NonNullable<FindProfilesResult['source']>;

const SUFFIX_RE = /\s*[|\-–—]\s*LinkedIn\s*$/i;
const SEP_RE = /\s+[-–—|]\s+/;

/** One search result to a raw card, or null when it is not a /in/ profile link. Title and snippet stay untrusted text. */
export function cardFromSearchResult(r: SearchResult): RawCard | null {
  const href = canonicalProfile(String(r.url ?? '').trim());
  if (!href) return null;
  const title = clean(r.title).replace(SUFFIX_RE, '').trim();
  const parts = title.split(SEP_RE).map((x) => x.trim()).filter(Boolean);
  const name = parts[0] ?? '';
  let headline = parts.slice(1).join(' - ');
  if (!headline) headline = clean(r.snippet).replace(SUFFIX_RE, '').slice(0, 200);
  return { href, name, headline };
}

/** Gate, dedupe and cap (3) raw cards into candidates. The same injection gating for every layer. */
function buildCandidates(cards: RawCard[]): { cands: ProfileCandidateOut[]; injection: boolean } {
  let injection = false;
  const seen = new Set<string>();
  const cands: ProfileCandidateOut[] = [];
  for (const card of cards) {
    if (cands.length >= 3) break;
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
    // Snapshot text can run the name straight into the headline ("Priya DemoTalent Partner ..."):
    // drop the leading name so word-based matching on the headline works.
    const headText = head.blocked ? '' : head.text.startsWith(name.text) ? head.text.slice(name.text.length).trim() : head.text;
    cands.push({ profile_url, name: name.text, headline: headText });
  }
  return { cands, injection };
}

/** Letters, digits, space and . & ' - only (the search layer's token rule); anything else becomes a space. */
const dorkCompany = (company: string): string =>
  company.replace(/[^\p{L}\p{N} .&'\-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

export async function findProfiles(a: FindProfilesArgs, deps: ToolDeps): Promise<FindProfilesResult> {
  if (haltReason(deps.db, 'linkedin')) return { status: 'halted', code: 'halted', candidates: [] };
  const company = clean(a.company);
  const hint = clean(a.role_hint);
  if (!company) return fail('bad_input');
  if (!CATEGORIES.includes(a.category)) return fail('bad_input');

  let injection = false;
  let cands: ProfileCandidateOut[] = [];
  let source: Source | undefined;
  let layout: { layout?: string } = {};
  let limited = false;
  let lastFail: FindProfilesResult | null = null;

  // Layered discovery, order from LINKEDIN_PEOPLE_SEARCH_SOURCES. The first layer that yields a usable
  // candidate wins; an empty, blocked, over-budget or failed layer falls through to the next one.
  for (const layer of deps.cfg.peopleSearchSources ?? ['linkedin']) {
    if (layer !== 'linkedin') {
      const params = { company: dorkCompany(company), role: hint || undefined, category: a.category };
      let out;
      try {
        out = await searchWithBudget(deps.db, 'linkedin_people', params, {
          env: deps.env, now: deps.now, dork: deps.dork, serper: deps.serper,
          skip: { dork: layer !== 'engine', google_pse: layer !== 'google_pse', tavily: layer !== 'tavily', serper: layer !== 'serper' },
        });
      } catch {
        continue;
      }
      const cards = out.results.map(cardFromSearchResult).filter((c): c is RawCard => c !== null);
      const built = buildCandidates(cards);
      if (built.injection) injection = true;
      if (built.cands.length > 0) {
        cands = built.cands;
        source = out.provider === 'serper' || out.provider === 'google_pse' || out.provider === 'tavily' ? out.provider : 'search_engine';
        break;
      }
      continue;
    }

    // LinkedIn's own logged-in people-search page: the last resort, under maxSearchesPerDay and the active hours.
    if (!activeHoursOk(deps)) { lastFail = fail(OUTSIDE_ACTIVE_HOURS_CODE); continue; }
    const keywords = `${company} ${hint || 'recruiter hiring manager talent acquisition'}`;
    const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
    if (!checkAndIncrement(deps.db, 'linkedin_search', deps.cfg.maxSearchesPerDay)) { limited = true; continue; }
    const r = await deps.rt.open(url);
    if (!r.ok) {
      if (r.code === 'halted') return { status: 'halted', code: 'halted', candidates: [] };
      lastFail = fail(r.code);
      continue;
    }
    const snap = r.snapshot;
    if (classifyUrl(snap.url) !== 'search') { lastFail = fail('not_search_page'); continue; }
    // The runtime's open() already showed the search page to the layout observer; report its verdict only.
    layout = layoutClassOf(deps.rt, 'find_profiles');
    const built = buildCandidates(snap.results.slice(0, 3) as unknown as RawCard[]);
    if (built.injection) injection = true;
    cands = built.cands;
    source = 'linkedin';
    break;
  }

  if (cands.length === 0) {
    if (source === undefined && lastFail) return lastFail;
    if (source === undefined && limited) return { status: 'rate_limited', code: 'search_limit', candidates: [] };
    return { status: 'ok', code: 'no_candidates', candidates: [], ...(injection ? { injection_suspected: true } : {}), ...layout, ...(source ? { source } : {}) };
  }
  const verdict = await deps.screen(cands.map((c) => `${c.name}\n${c.headline}`).join('\n'), 'read');
  if (verdict.blocked) return { status: 'failed', code: verdict.code, candidates: [], injection_suspected: true };

  for (const c of cands) {
    // Finding 20: the category comes from the headline in code, and the headline-versus-company
    // match is stored, so a send can later be refused for the wrong employer.
    const m = headlineMatchesCompany(c.headline, company);
    c.category = classifyCategory(c.headline, a.category);
    c.employer_match = m === null ? null : m;
    upsertPerson(deps.db, {
      platform: 'linkedin',
      profileKey: profileKeyOf(c.profile_url),
      name: c.name,
      headline: c.headline,
      company,
      category: c.category,
      employerMatch: m === null ? null : m ? 1 : 0,
    });
  }
  return { status: 'ok', code: 'found', candidates: cands, ...(injection ? { injection_suspected: true } : {}), ...layout, ...(source ? { source } : {}) };
}
