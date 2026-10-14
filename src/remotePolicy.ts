// Restriction markers: wording that limits who may take a role (residency, citizenship, right to work, "US only", exclusions).
// ONE list, imported by the board location filter (src/sources/boards/filters.ts) and by the veto backstops (src/vetoes.ts), so a posting
// cannot pass one gate and be refused by the other for different reasons. The text checked is untrusted posting text: it is capped at
// MAX_POLICY_TEXT characters and every pattern is linear (no nested quantifiers, bounded gaps).
//
// scope 'location': only checked in a location string ("Remote, US only", "US-based"); the same words in a long description are too noisy.
// scope 'any': also checked in the posting text (title + first MAX_POLICY_TEXT characters of the description).
// dir: where a target-region name cancels the marker ("must be located in the UAE", "UAE citizens only" are not restrictions for a target
// region): 'after' = the 30 characters after, 'before' = the 30 before, 'around' = both, 'none' = never cancelled ("excl. UAE" stays a restriction).

export const MAX_POLICY_TEXT = 20000;
const NEAR = 30;

type Dir = 'after' | 'before' | 'around' | 'none';
interface Marker { name: string; re: RegExp; scope: 'location' | 'any'; dir: Dir }

const W = '(?<![a-z0-9])';
const REGION = 'us|usa|u\\.s\\.a?|uk|eu|emea|canada|latam|europe|americas|north america|united states|united kingdom|germany|france|spain|poland|brazil|australia|singapore';
export const RESTRICTION_MARKERS: Marker[] = [
  { name: 'only', re: new RegExp(`${W}only(?![a-z0-9])`, 'g'), scope: 'location', dir: 'before' },
  { name: 'eligibility only', re: new RegExp(`${W}(?:residents?|citizens?|nationals?|candidates|applicants|hires?|time ?zones?)\\s+only(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'region only', re: new RegExp(`${W}(?:${REGION})\\s+only(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'must reside', re: new RegExp(`${W}must\\s+(?:reside|be\\s+located|live|be\\s+based|be\\s+(?:a\\s+)?resident)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'after' },
  { name: 'based in', re: new RegExp(`${W}based\\s+in(?![a-z0-9])`, 'g'), scope: 'location', dir: 'after' },
  { name: '-based', re: /[a-z0-9]-based(?![a-z0-9])/g, scope: 'location', dir: 'before' },
  { name: 'residents of', re: new RegExp(`${W}residents?\\s+of(?![a-z0-9])`, 'g'), scope: 'any', dir: 'after' },
  { name: 'citizens', re: new RegExp(`${W}citizens?(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'right to work', re: new RegExp(`${W}right\\s+to\\s+work(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'work authorization', re: new RegExp(`${W}work\\s+authori[sz]ation(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'authorized to work', re: new RegExp(`${W}authori[sz]ed\\s+to\\s+work(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'eligible to work', re: new RegExp(`${W}eligible\\s+to\\s+work(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'visa required', re: new RegExp(`${W}visa\\s+required(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'no visa', re: new RegExp(`${W}no\\s+visa(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'relocation not', re: new RegExp(`${W}relocation\\s+(?:is\\s+)?not(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'excluding', re: new RegExp(`${W}(?:excl|excluding|except)(?![a-z])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'not open to', re: new RegExp(`${W}not\\s+(?:open|available)\\s+(?:to|in)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'outside india', re: new RegExp(`${W}(?:outside|other\\s+than)\\s+india(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  // Added in the final review: hiring-scope wording that names who is refused or who is wanted.
  { name: 'does not hire', re: new RegExp(`${W}(?:do|does|will)\\s+not\\s+(?:hire|consider|accept)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'will not be considered', re: new RegExp(`${W}will\\s+not\\s+be\\s+(?:considered|accepted)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'no candidates', re: new RegExp(`${W}no\\s+(?:candidates|applicants)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'not supported', re: new RegExp(`${W}not\\s+supported(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'candidates in', re: new RegExp(`${W}(?:candidates|applicants|contractors|employees)\\s+(?:(?:located|based|residing|living)\\s+)?(?:in|from)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'after' },
  { name: 'open to candidates in', re: new RegExp(`${W}open\\s+to\\s+(?:candidates|applicants|residents|people)\\s+(?:(?:located|based|residing|living)\\s+)?(?:in|from)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'after' },
  { name: 'within region', re: new RegExp(`${W}within\\s+(?:the\\s+)?(?:${REGION})(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'residency', re: new RegExp(`${W}residen(?:cy|t|ts)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'work permit', re: new RegExp(`${W}work\\s+permit(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'no india', re: new RegExp(`${W}(?:no|not)\\s+india(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'us person', re: new RegExp(`${W}u\\.?s\\.?\\s+person(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'eea', re: new RegExp(`${W}eea(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'nationals', re: new RegExp(`${W}(?:eu|uk|us|european|british|american)\\s+(?:nationals?|citizens?)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'must time zone', re: new RegExp(`${W}must[^.\\n]{0,40}?time\\s?zones?(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'can only hire', re: new RegExp(`${W}(?:can|will|may)\\s+only\\s+(?:hire|consider|accept)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
];

const fold = (s: string) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Name of the first restriction marker in `text`, or null. `scope: 'location'` checks every marker (for a location string),
 * `'posting'` only the scope-'any' ones (for title + description). `targets` (specific target-region names) cancel a marker whose
 * subject is a target region (see `dir`), so "must be located in the UAE" is not a restriction but "must be located in London" is.
 */
export function findRestriction(text: string, opts: { scope: 'location' | 'posting'; targets?: string[] } = { scope: 'location' }): string | null {
  const hay = fold(String(text ?? '').slice(0, MAX_POLICY_TEXT));
  const terms = (opts.targets ?? []).filter((t) => t.trim()).map((t) => esc(fold(t).trim()));
  // The subject must be the very next words ("in the UAE") or the very previous ones ("UAE citizens"): a target name further away
  // ("must be located in London (Dubai office closed)") does not cancel the marker.
  const startsWithTarget = (s: string) => {
    const rest = s.replace(/^[\s,:;-]*(?:(?:in|within|of|at|to|the)\s+)*/, '');
    // an open-ended object ("candidates from all backgrounds", "candidates from anywhere") is not a restriction either
    if (/^(?:any|all|anywhere|around|across|worldwide|the world|many|multiple|diverse|different|various)(?![a-z0-9])/.test(rest)) return true;
    return terms.some((t) => new RegExp(`^${t}(?![a-z0-9])`).test(rest));
  };
  const endsWithTarget = (s: string) => terms.some((t) => new RegExp(`(?<![a-z0-9])${t}[\\s-]*(?:residents?|citizens?|nationals?|candidates|applicants|based)?[\\s-]*$`).test(s));
  for (const m of RESTRICTION_MARKERS) {
    if (opts.scope === 'posting' && m.scope === 'location') continue;
    for (const x of hay.matchAll(m.re)) {
      const at = x.index ?? 0;
      const after = hay.slice(at + x[0].length, at + x[0].length + NEAR);
      const before = hay.slice(Math.max(0, at - NEAR), at);
      const cancelled = ((m.dir === 'after' || m.dir === 'around') && startsWithTarget(after)) || ((m.dir === 'before' || m.dir === 'around') && endsWithTarget(before));
      if (!cancelled) return m.name;
    }
  }
  return null;
}

// A clear remote word in a location string ("Remote - Brazil", "Work from home", "Distributed", "Anywhere in Europe").
export const REMOTE_WORD = /(?<![a-z0-9])(?:remote(?:ly)?|work from home|wfh|distributed|anywhere)(?![a-z0-9])/;
const ONSITE_WORD = /(?<![a-z0-9])(?:on-?site|on site|in-?person|in person|on-?premises?|in-?office|in office|in the office|office[- ]based|hybrid|relocat\w*|no remote|not remote|remote (?:work )?(?:is )?not)(?![a-z0-9])/;
const DESC_HEAD = 2000;
// In a location string any office, HQ or on-site/hybrid word means the job is not purely remote ("Remote-first, Berlin HQ", "Berlin (Hybrid/Remote)").
export const LOCATION_ONSITE = /(?<![a-z0-9])(?:on-?site|on site|hybrid|in-?office|in office|in person|in-?person|on-?premises?|office|hq|headquarters?)(?![a-z0-9])/;
// Region words that are not a country: a remote role "in Europe" or "in the Americas" is restricted to that region.
export const REGION_WORD = /(?<![a-z0-9])(?:europe|european union|eu|emea|americas|north america|south america|latin america|latam|africa|oceania|asia)(?![a-z0-9])/;

// Is this posting remote? Yes when the job's remote flag is set or a remote word is in the location, title or the first 2000 characters
// of the description, AND nothing in the location, title or the whole capped description (MAX_POLICY_TEXT) says on-site, hybrid, in-person,
// in-office, relocation or "no remote" (an on-site mention anywhere wins: fail safe, so a remote posting that mentions "in-person
// interviews" is not downgraded and keeps its FAIL). Linear and capped; the text is untrusted.
export function isRemotePosting(job: { title: string; description: string; location?: string | null; remote?: boolean | null }): boolean {
  const loc = fold(String(job.location ?? '').slice(0, 500));
  const title = fold(String(job.title ?? '').slice(0, 500));
  const all = fold(String(job.description ?? '').slice(0, MAX_POLICY_TEXT));
  if (LOCATION_ONSITE.test(loc) || ONSITE_WORD.test(loc) || ONSITE_WORD.test(title) || ONSITE_WORD.test(all)) return false;
  const head = all.slice(0, DESC_HEAD);
  return job.remote === true || REMOTE_WORD.test(loc) || REMOTE_WORD.test(title) || REMOTE_WORD.test(head);
}
