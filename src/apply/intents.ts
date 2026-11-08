// Semantic intent classes for plain factual screening questions. The literal QUESTION_PATTERNS of answers.ts only catch a few
// phrasings; this module recognizes the INTENT of a question in several phrasings (English, a little Hinglish) and computes the
// answer from the owner's own facts (resume + answer file). Pure, no I/O, no logging of values.
// Rules: an intent answers only when every fact it needs exists; an empty fact is never guessed; a question that does not clearly
// fit an intent returns null (the caller parks it as before). Select/radio options are never invented: when the page lists options
// and none cleanly matches, the result is null.

export type IntentName =
  | 'years_threshold'
  | 'visa_sponsorship'
  | 'country_of_residence'
  | 'city'
  | 'region_residence'
  | 'prior_employer';

export const INTENT_NAMES: readonly IntentName[] = [
  'years_threshold', 'visa_sponsorship', 'country_of_residence', 'city', 'region_residence', 'prior_employer',
];

export interface OwnerFacts {
  /** Whole months of work from the resume (union of date ranges), or null. */
  experienceMonths: number | null;
  /** Owner-stated whole years (answer file); an integer means "at least this many, fewer than one more". */
  statedYears: number | null;
  /** The resume/answer-file location string, e.g. "Pune, India". */
  location: string | null;
  /** requires_sponsorship from the answer file (boolean or {india, other}). */
  requiresSponsorship: boolean | { india: boolean; other: boolean } | null;
  employers: string[];
}

export interface IntentCtx {
  question: string;
  options?: string[];
  /** Company of the job being applied to (from SQLite), used for "this company" wording. */
  company?: string | null;
}

export type IntentValue = string | number | boolean;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- places ----------

/** Canonical country -> aliases (lowercase). Small on purpose; an unknown place makes the question park. */
const COUNTRIES: Record<string, string[]> = {
  india: ['india', 'in', 'ind', 'bharat', 'republic of india'],
  'united states': ['united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.', 'america'],
  canada: ['canada', 'ca'],
  'united kingdom': ['united kingdom', 'uk', 'u.k.', 'great britain', 'britain', 'england', 'gb'],
  germany: ['germany', 'deutschland', 'de'],
  france: ['france'],
  netherlands: ['netherlands', 'holland'],
  spain: ['spain'],
  italy: ['italy'],
  ireland: ['ireland'],
  portugal: ['portugal'],
  poland: ['poland'],
  sweden: ['sweden'],
  australia: ['australia'],
  'new zealand': ['new zealand'],
  singapore: ['singapore'],
  'united arab emirates': ['united arab emirates', 'uae', 'dubai', 'abu dhabi'],
  'saudi arabia': ['saudi arabia', 'ksa'],
  qatar: ['qatar'],
  brazil: ['brazil'],
  mexico: ['mexico'],
  japan: ['japan'],
  pakistan: ['pakistan'],
  bangladesh: ['bangladesh'],
  'sri lanka': ['sri lanka'],
  nepal: ['nepal'],
  philippines: ['philippines'],
  indonesia: ['indonesia'],
};

/** Region word -> member canonical countries (only the countries this module knows). */
const REGIONS: Record<string, string[]> = {
  europe: ['united kingdom', 'germany', 'france', 'netherlands', 'spain', 'italy', 'ireland', 'portugal', 'poland', 'sweden'],
  eu: ['germany', 'france', 'netherlands', 'spain', 'italy', 'ireland', 'portugal', 'poland', 'sweden'],
  emea: ['united kingdom', 'germany', 'france', 'netherlands', 'spain', 'italy', 'ireland', 'portugal', 'poland', 'sweden', 'united arab emirates', 'saudi arabia', 'qatar'],
  apac: ['india', 'australia', 'new zealand', 'singapore', 'japan', 'pakistan', 'bangladesh', 'sri lanka', 'nepal', 'philippines', 'indonesia'],
  asia: ['india', 'singapore', 'japan', 'pakistan', 'bangladesh', 'sri lanka', 'nepal', 'philippines', 'indonesia', 'united arab emirates', 'saudi arabia', 'qatar'],
  'north america': ['united states', 'canada', 'mexico'],
  latam: ['brazil', 'mexico'],
  gulf: ['united arab emirates', 'saudi arabia', 'qatar'],
};

const INDIAN_CITIES = new Set([
  'mumbai', 'delhi', 'new delhi', 'bengaluru', 'bangalore', 'hyderabad', 'chennai', 'kolkata', 'pune', 'ahmedabad', 'jaipur',
  'surat', 'lucknow', 'noida', 'gurgaon', 'gurugram', 'indore', 'nagpur', 'bhopal', 'chandigarh', 'kochi', 'coimbatore', 'vadodara',
  'thane', 'navi mumbai', 'nashik', 'patna', 'ranchi', 'raipur', 'bhubaneswar', 'thiruvananthapuram', 'visakhapatnam', 'mysuru', 'mysore',
]);

const canonOfWord = (w: string): string | null => {
  const t = norm(w).replace(/[.,;:!?()]+$/g, '').replace(/^[(]+/, '');
  for (const [canon, aliases] of Object.entries(COUNTRIES)) if (aliases.includes(t)) return canon;
  return null;
};

/** The owner's country from a location string: the last comma part (or a known Indian city). Null when it cannot be said. */
export function ownerCountry(location: string | null): string | null {
  if (!location) return null;
  const parts = location.split(',').map((x) => norm(x)).filter(Boolean);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  const c = canonOfWord(last);
  if (c) return c;
  if (parts.length === 1 && INDIAN_CITIES.has(last)) return 'india';
  if (parts.length === 2 && INDIAN_CITIES.has(parts[0]) && !canonOfWord(parts[1]) && /^[a-z .]+$/.test(parts[1]) && parts[1].length <= 25) {
    // "Pune, Maharashtra": a known Indian city first, a state-like second part.
    return 'india';
  }
  return null;
}

export function ownerCity(location: string | null): string | null {
  if (!location) return null;
  const first = location.split(',')[0]?.trim();
  if (!first) return null;
  // A lone country ("India") is not a city.
  if (canonOfWord(first)) return null;
  return first;
}

/** Countries named in a question, in order, with regions expanded. `unknownPlaceWords` is a hint that the question names places this module does not know. */
export function placesInQuestion(q: string): { countries: Set<string>; found: boolean } {
  const countries = new Set<string>();
  const lower = ` ${q.toLowerCase().replace(/[()/,;.!?]/g, ' ')} `;
  // Short aliases collide with ordinary words ("in", "us", "uk"): "us/uk/uae/usa/ksa" count only in capitals, "in/ca/de/ind/gb" never.
  const CAPS_ONLY = new Set(['us', 'uk', 'uae', 'usa', 'ksa']);
  const SKIP = new Set(['in', 'ca', 'de', 'ind', 'gb', 'u.s.', 'u.k.', 'u.s.a.']);
  const stripped = q.replace(/\./g, '');
  for (const [canon, aliases] of Object.entries(COUNTRIES)) {
    for (const al of aliases) {
      if (SKIP.has(al)) continue;
      if (CAPS_ONLY.has(al)) {
        if (new RegExp(`(?<![A-Za-z])${al.toUpperCase()}(?![A-Za-z])`).test(stripped)) countries.add(canon);
      } else if (new RegExp(`(?<![a-z])${al.replace(/ /g, '\\s+')}(?![a-z])`).test(lower)) countries.add(canon);
    }
  }
  for (const [region, members] of Object.entries(REGIONS)) {
    if (new RegExp(`(?<![a-z])${region.replace(/ /g, '\\s+')}(?![a-z])`).test(lower)) for (const m of members) countries.add(m);
  }
  return { countries, found: countries.size > 0 };
}

// ---------- classification ----------

const PREFIX_EMPLOY_VERB = String.raw`(?:worked|work|employed|consulted|interned|contracted|been employed)`;

// Groups: 1 lead word + 2 N | 3 N ("3+ years") | 4 N ("3 years or more") | 5 N (Hinglish "3 saal se zyada"). Only "over/more than/greater than/exceed" and the Hinglish form are strict.
const RE_YEARS_THRESHOLD = /\b(over|more than|greater than|at least|atleast|minimum(?: of)?|min\.?|exceed(?:s|ing)?)\s+(?:of\s+)?(\d{1,2})\s*(?:\+\s*)?(?:years?|yrs?)\b|\b(\d{1,2})\s*\+\s*(?:years?|yrs?)\b|\b(\d{1,2})\s*(?:years?|yrs?)\s*(?:or more|and above|plus)|\b(\d{1,2})\s*(?:saal|sal|varsh)\s*(?:se|ya)\s*(?:zyada|jyada|adhik|upar)/i;
const RE_EXPERIENCE = /\bexperience\b|\banubhav\b/i;
// Words allowed between the number of years and "experience" (generic experience only; a named technology makes the question skill-specific and parks it).
const GENERIC_WORDS = new Set([
  'of', 'in', 'as', 'a', 'an', 'the', 'and', 'or', 'over', 'professional', 'professionally', 'software', 'engineering', 'development', 'developer',
  'engineer', 'work', 'working', 'relevant', 'industry', 'total', 'overall', 'full-time', 'fulltime', 'full', 'time', 'hands-on', 'hands', 'on',
  'real-world', 'paid', 'commercial', 'years', 'year', 'yrs', 'yr', 'it', 'tech', 'technical', 'experience', 'to', 'your', 'have', 'you', 'do',
  'ka', 'ki', 'ke', 'hai', 'kya', 'aapke', 'paas', 'with', 'building', 'web', 'applications', 'application', 'product', 'products', 'production', 'role', 'roles', 'field', 'job',
]);

// "require sponsorship" / "need a visa" only. "Do you hold a valid visa?" is the opposite question and is not matched.
const isSponsorQuestion = (q: string): boolean => /\bsponsor/i.test(q) || (/\b(?:visa|work permit|h-?1b)\b/i.test(q) && /\b(?:requir|need)/i.test(q));
/** "without sponsorship", "do not need a visa": the polarity flips, so such a question is never answered. */
export const sponsorNegated = (q: string): boolean => /\b(?:without|not|no|never|n't)\b.{0,25}\b(?:sponsor|visa|work permit)/i.test(q);
const RE_COUNTRY_RES = /\bcountry\b.{0,30}\b(?:residen|reside|live|living|located|based|stay|staying)\b|\b(?:residen\w*|live|living|located|based|stay)\b.{0,25}\bcountry\b|\bcountry of (?:residence|domicile)\b|\bcountry you (?:live|reside|are based)\b|\bkis desh\b|\bcurrent country\b/i;
const RE_CITY = /\b(?:which|what|enter|your|current|present)\b.{0,25}\bcity\b|\bcity\b.{0,12}\b(?:you|of residence)\b|^\s*city\b|\bcity (?:name)?\s*\*?$|\bkaun ?se shehar\b/i;
const RE_LIVE_VERB = /\b(?:live|living|reside|residing|resident|located|based|stay|staying|rehte|rehta|rahte|rahta)\b/i;
// The verb must be followed by at/for/with/by/or ("worked at", "consulted for"), so "authorized to work in this country" never matches.
const RE_PRIOR_EMP = new RegExp(String.raw`\b(?:have you|did you|had you|were you|ever)\b.{0,40}\b${PREFIX_EMPLOY_VERB}\s+(?:at|for|with|by|or)\b`, 'i');
const RE_NOT_SELF = /\b(?:relative|family|friend|spouse|partner|referr|someone|anyone|employee referral|know anyone)\b/i;

export function classifyIntent(question: string): IntentName | null {
  const q = question.replace(/\s+/g, ' ').trim();
  if (!q) return null;
  // Consent-like or attestation text is handled before this point by the book; skip anything with a salary/ctc word.
  if (/\b(?:salary|ctc|compensation|rating|rate yourself|scale of|notice period|percent|%)\b/i.test(q)) return null;

  if (isSponsorQuestion(q) && !/\bauthori[sz]ed to work\b/i.test(q)) return 'visa_sponsorship';

  if (RE_PRIOR_EMP.test(q) && !RE_NOT_SELF.test(q)) return 'prior_employer';

  if (RE_COUNTRY_RES.test(q)) return 'country_of_residence';

  // The asking sentence (the last one) must be about where the owner lives and must not mix in relocation, work authorization or willingness.
  const asking = q.split(/(?<=[.!?])\s+/).filter(Boolean).slice(-1).join(' ');
  if (RE_LIVE_VERB.test(asking) && !/relocat|willing|open to|sponsor|authori[sz]ed|work (?:in|from)|commute|hybrid|office/i.test(asking) && placesInQuestion(q).found) {
    return 'region_residence';
  }

  if (RE_CITY.test(q) && !/\bcountry\b/i.test(q)) return 'city';

  if (RE_EXPERIENCE.test(q)) {
    const m = RE_YEARS_THRESHOLD.exec(q);
    if (m) return 'years_threshold';
  }
  return null;
}

// ---------- answers ----------

const YES_NO = (v: boolean, options?: string[]): IntentValue | null => {
  if (!options || options.length === 0) return v;
  const want = v ? 'yes' : 'no';
  return options.find((o) => norm(o) === want) ?? null;
};

function thresholdOf(q: string): { n: number; strict: boolean } | null {
  const m = RE_YEARS_THRESHOLD.exec(q);
  if (!m) return null;
  const n = Number(m[2] ?? m[3] ?? m[4] ?? m[5]);
  if (!Number.isFinite(n) || n < 0 || n > 40) return null;
  // "over N" / "more than N" / "greater than N" / "exceed" and the Hinglish "N saal se zyada" are strict; "at least N", "N+", "N or more", "minimum N" are inclusive.
  const strict = m[5] !== undefined || (m[1] !== undefined && /^(?:over|more than|greater than|exceed)/i.test(m[1]));
  return { n, strict };
}

function genericExperienceText(q: string): boolean {
  // Everything between the matched threshold and the word "experience" must be generic wording.
  const m = RE_YEARS_THRESHOLD.exec(q);
  if (!m) return false;
  const after = q.slice(m.index + m[0].length);
  const expIdx = after.search(RE_EXPERIENCE);
  if (expIdx < 0) return false;
  const words = (t: string): string[] => t.toLowerCase().replace(/[^a-z\- ]+/g, ' ').split(/\s+/).filter(Boolean);
  // Both what comes before "experience" and what trails it ("experience with Kubernetes") must be generic wording.
  const tail = after.slice(expIdx).replace(/experience/i, '');
  return words(after.slice(0, expIdx)).every((w) => GENERIC_WORDS.has(w)) && words(tail).every((w) => GENERIC_WORDS.has(w));
}

function yearsThreshold(q: string, facts: OwnerFacts): boolean | null {
  const t = thresholdOf(q);
  if (!t || !genericExperienceText(q)) return null;
  // A question that asks about a specific named skill (anything the check above did not allow) was already rejected.
  let lo: number; let hi: number;
  if (facts.experienceMonths !== null) { lo = facts.experienceMonths / 12; hi = lo; }
  else if (facts.statedYears !== null) { lo = facts.statedYears; hi = facts.statedYears + 1 - 1e-9; }
  else return null;
  if (t.strict) {
    if (lo > t.n) return true;
    if (hi <= t.n) return false;
    return null;
  }
  if (lo >= t.n) return true;
  if (hi < t.n) return false;
  return null;
}

function sponsorship(q: string, facts: OwnerFacts): boolean | null {
  if (sponsorNegated(q)) return null;
  const country = ownerCountry(facts.location);
  const mentioned = placesInQuestion(q);
  const aboutCurrent = /\b(?:remain|stay|continue|work)\b.{0,25}\b(?:in|at)\b.{0,12}\b(?:your )?(?:current|present) (?:location|country|residence|place)\b|\bin your (?:current|present) (?:location|country|residence)\b|\bto remain in\b/i.test(q);
  const rs = facts.requiresSponsorship;
  if (aboutCurrent && country) {
    // The owner already lives and works there; the answer file may still say otherwise for the owner's own country.
    if (typeof rs === 'boolean') return rs;
    if (rs && typeof rs === 'object' && country === 'india') return rs.india;
    if (rs && typeof rs === 'object') return rs.other;
    return false;
  }
  if (typeof rs === 'boolean') return rs;
  if (rs && typeof rs === 'object' && mentioned.found && country) {
    // Sponsorship needed in a named place: owner's own country -> the india/other split only applies to India.
    const named = [...mentioned.countries];
    if (country === 'india' && named.length > 0) {
      if (named.every((c) => c === 'india')) return rs.india;
      if (named.every((c) => c !== 'india')) return rs.other;
    }
  }
  return null;
}

function countryAnswer(facts: OwnerFacts, options?: string[]): IntentValue | null {
  const c = ownerCountry(facts.location);
  if (!c) return null;
  const aliases = COUNTRIES[c] ?? [c];
  const display = c.replace(/\b\w/g, (m) => m.toUpperCase());
  if (!options || options.length === 0) return display;
  // Pick the page's own spelling; an exact country-name option only (the two-letter alias is accepted only as an exact option).
  const hit = options.find((o) => aliases.includes(norm(o)));
  return hit ?? null;
}

function regionResidence(q: string, facts: OwnerFacts, options?: string[]): IntentValue | null {
  const c = ownerCountry(facts.location);
  if (!c) return null;
  const { countries, found } = placesInQuestion(q);
  if (!found || countries.size === 0) return null;
  return YES_NO(countries.has(c), options);
}

const CORP_SUFFIX = /\b(?:inc|incorporated|ltd|limited|llc|llp|pvt|private|plc|corp|corporation|co|gmbh|ag|sa|technologies|technology|labs|software|solutions|systems|the)\b\.?/g;
export const normCompany = (s: string): string => norm(s).replace(/[.,'’"()]/g, ' ').replace(CORP_SUFFIX, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

export function companyFromQuestion(q: string, jobCompany?: string | null): string | null {
  const m = new RegExp(String.raw`\b${PREFIX_EMPLOY_VERB}\b(?:\s+(?:at|for|with|by|in|or|and|as)\b|\s+\w+\s+(?:at|for|with)\b)*\s+(?:the\s+)?(.+?)\s*(?:\?|\(|,|\.|$)`, 'i').exec(q);
  let c = (m?.[1] ?? '').trim();
  // "worked at or consulted for GitLab": the first verb group is followed by "or <verb> for"; step over it.
  const again = /^(?:or|and)\s+\w+\s+(?:at|for|with)\s+(.+)$/i.exec(c);
  if (again) c = again[1].trim();
  c = c.replace(/^(?:at|for|with|by)\s+/i, '').replace(/\s+(?:before|previously|already|ever|earlier|in the past|prior to this)$/i, '').trim();
  if (!c || /^(?:us|our company|this company|the company|here|our team|this organi[sz]ation|us before)$/i.test(c)) return jobCompany?.trim() || null;
  if (c.split(/\s+/).length > 5) return null;
  return c;
}

function priorEmployer(q: string, facts: OwnerFacts, ctx: IntentCtx): boolean | null {
  if (facts.employers.length === 0) return null;
  const company = companyFromQuestion(q, ctx.company);
  if (!company) return null;
  const want = normCompany(company);
  if (!want) return null;
  const hit = facts.employers.some((e) => {
    const have = normCompany(e);
    return have !== '' && (have === want || have.split(' ').join('') === want.split(' ').join(''));
  });
  return hit;
}

/** The answer for one intent, or null when a needed fact is missing or the question does not cleanly fit. */
export function answerIntent(intent: IntentName, facts: OwnerFacts, ctx: IntentCtx): IntentValue | null {
  const q = ctx.question;
  switch (intent) {
    case 'years_threshold': {
      const v = yearsThreshold(q, facts);
      return v === null ? null : YES_NO(v, ctx.options);
    }
    case 'visa_sponsorship': {
      const v = sponsorship(q, facts);
      return v === null ? null : YES_NO(v, ctx.options);
    }
    case 'country_of_residence': return countryAnswer(facts, ctx.options);
    case 'city': {
      const c = ownerCity(facts.location);
      if (!c) return null;
      if (!ctx.options || ctx.options.length === 0) return c;
      return ctx.options.find((o) => norm(o) === norm(c)) ?? null;
    }
    case 'region_residence': return regionResidence(q, facts, ctx.options);
    case 'prior_employer': {
      const v = priorEmployer(q, facts, ctx);
      return v === null ? null : YES_NO(v, ctx.options);
    }
    default: return null;
  }
}

/** True when the facts the intent needs exist at all (question-independent), used by `has()` without a question. */
export function intentHasFacts(intent: IntentName, facts: OwnerFacts): boolean {
  switch (intent) {
    case 'years_threshold': return facts.experienceMonths !== null || facts.statedYears !== null;
    case 'visa_sponsorship': return ownerCountry(facts.location) !== null || facts.requiresSponsorship !== null;
    case 'country_of_residence': case 'region_residence': return ownerCountry(facts.location) !== null;
    case 'city': return ownerCity(facts.location) !== null;
    case 'prior_employer': return facts.employers.length > 0;
    default: return false;
  }
}
