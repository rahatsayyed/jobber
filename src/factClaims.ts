// file: src/factClaims.ts
// Adapted from career-ops-hq/career-ops verify-cv-facts.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Pure claim extractors for the resume/outreach fact gate. No I/O.

export const METRIC_NOUNS = [
  'users', 'customers', 'clients', 'employees', 'engineers', 'developers', 'teams', 'companies',
  'partners', 'organizations', 'organisations', 'brands', 'countries', 'members', 'reports',
  'hours', 'days', 'weeks', 'months', 'years', 'minutes', 'seconds',
  'requests', 'tokens', 'documents', 'workflows', 'pipelines', 'agents',
  'interviews', 'applications', 'offers', 'cvs', 'resumes',
  'sessions', 'responses', 'surveys', 'commits', 'contributions', 'repositories', 'repos',
  'modules', 'tools', 'servers', 'guides', 'articles', 'datasets', 'examples', 'deployments',
  'services', 'downloads', 'stars', 'lines', 'projects', 'integrations', 'tests',
  'staff', 'personnel', 'people', 'contractors', 'vendors', 'students',
  'sites', 'devices', 'locations', 'audits', 'incidents', 'tickets',
  'candidates', 'participants', 'workshops',
  // Added for this codebase: counts the base resume actually states.
  'policies', 'contracts', 'calls', 'capabilities', 'vulnerabilities', 'dashboards', 'apis', 'endpoints',
];
const MODIFIER_WINDOW = 4;
// Job-posting text is untrusted: cap what every extractor scans and bound digit runs so no regex goes quadratic.
export const MAX_SCAN_CHARS = 20000;
/** True when the extractors would silently truncate this text; gates must block (fail closed) instead of trusting a partial scan. */
export const exceedsScanCap = (text: string): boolean => String(text ?? '').length > MAX_SCAN_CHARS;
const cap = (text: string): string => String(text ?? '').slice(0, MAX_SCAN_CHARS);
const COUNT_CLAIM_RE = new RegExp(
  String.raw`(?<![A-Za-z]-)\b(\d[\d,.]{0,14}(?:[kKmMbB]\b)?)\s*\+?\s*(?:[A-Za-z][A-Za-z-]*\s+){0,${MODIFIER_WINDOW}}?(${METRIC_NOUNS.join('|')})\b`,
  'gi',
);
const NOUN_SYNONYMS = new Map([
  ['repos', 'repositories'], ['organisations', 'organizations'], ['cvs', 'resumes'],
  ['articles', 'guides'], ['personnel', 'staff'], ['developers', 'engineers'],
]);
const SIMPLE_CLAIM_PATTERNS = [
  /\b\d{1,15}(?:\.\d{1,15})?\s?%/g,
  /(?<![\w$€£₹])[$€£₹]\s?\d[\d,.]{0,14}(?:\s?[kKmMbB])?/g,
  /\b\d{1,15}(?:\.\d{1,15})?\s?x\b/gi,
];
const TIME_NOUNS = new Set(['days', 'weeks', 'months', 'years', 'hours', 'minutes', 'seconds']);
const HORIZON_LEAD_RE = /\b(?:the|my|our|your)?\s*(?:first|next)\s+$/i;
const FORWARD_MARKER_RE = /\b(?:would|will|shall|should)\b|['’]d\b(?!\s+[A-Za-z]+ed\b)|['’]ll\b|\b(?:plan|plans|planning|intend|intends)\s+to\b|\bgoing to\b|\blooking forward\b/i;
const REQUIREMENT_CITATION_RE = /\b(?:role|posting|position|job)\b[^.,;:!?\n]{0,30}\b(?:calls?\s+for|requires?|asks?\s+for|wants?)\b/gi;
const NEGATION_LEAD_RE = /\b(?:without(?:\s+the)?|lack(?:ing)?(?:\s+the)?|don['’]?t\s+have(?:\s+the)?|doesn['’]?t\s+have(?:\s+the)?|do\s+not\s+have(?:\s+the)?)\s*$/i;
// Negation words for "this sentence discloses a gap, it does not claim the tool" (P4). The n't forms cover haven't/don't/can't/...
// "no" and "without" negate what FOLLOWS them ("with no downtime"), so NEGATION_AFTER_RE (words after a term) leaves them out.
const NEGATION_CORE = String.raw`not|never|lack(?:s|ed|ing)?|learning|new to|yet to|\w+n['’]t`;
export const NEGATION_RE = new RegExp(String.raw`\b(?:${NEGATION_CORE}|no|without)\b`, 'i');
export const NEGATION_AFTER_RE = new RegExp(String.raw`\b(?:${NEGATION_CORE})\b`, 'i');

/** NFKC, Indic/Arabic digits to ASCII, and join space-grouped thousands ("16 181" -> "16181"). */
export function foldDigits(text: string): string {
  let out = String(text ?? '').normalize('NFKC');
  out = out.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x30 && cp <= 0x39) return ch;
    for (const zero of [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66]) {
      const v = cp - zero;
      if (v >= 0 && v <= 9) return String(v);
    }
    return ch;
  });
  return out.replace(/(?<!\d)(\d{1,3})[\s  ](?=\d{3}(?!\d))/g, '$1');
}

/** Lowercase, drop thousands separators (only before exactly 3 digits), collapse whitespace. */
export function normalizeClaim(claim: string): string {
  return String(claim)
    .toLowerCase()
    .replace(/(\d)[,.\s  ](?=\d{3}(?!\d))/g, '$1')
    .replace(/[,\s]+/g, ' ')
    .trim();
}

export function normalizeFact(value: string): string {
  return normalizeClaim(value).replace(/[.;:,]+$/g, '').trim();
}

/** Join strings so a capture can never run from one resume string into the next. */
export function joinStatements(parts: string[]): string {
  return parts
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .map((s) => (/[.!?;]$/.test(s) ? s : `${s}.`))
    .join('\n');
}

const CLAUSE_SCAN_WINDOW = 1500;
function clauseBounds(text: string, index: number): { start: number; end: number } {
  const isBoundary = (i: number) => {
    const c = text[i];
    if (c === '\n') return true;
    if (!'.!?,;:'.includes(c)) return false;
    return !(/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? ''));
  };
  const isSentenceEnd = (i: number) => {
    const c = text[i];
    if (c === '\n') return true;
    if (!'.!?'.includes(c)) return false;
    return !(/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? ''));
  };
  // Scans are windowed so a long boundary-free run cannot make every match rescan the whole text.
  const lo = Math.max(0, index - CLAUSE_SCAN_WINDOW), hi = Math.min(text.length, index + CLAUSE_SCAN_WINDOW);
  let start = lo;
  for (let i = index - 1; i >= lo; i--) if (isBoundary(i)) { start = i + 1; break; }
  let end = hi;
  for (let i = index; i < hi; i++) if (isBoundary(i)) { end = i; break; }
  if (/^\s*(?:and|or|then|plus)\b/i.test(text.slice(start, end))) {
    let sentenceStart = lo;
    for (let i = start - 1; i >= lo; i--) if (isSentenceEnd(i)) { sentenceStart = i + 1; break; }
    return { start: sentenceStart, end };
  }
  return { start, end };
}

function isDisclosedRequirement(clean: string, match: RegExpMatchArray, all: RegExpMatchArray[]): boolean {
  const idx = match.index ?? 0;
  if (NEGATION_LEAD_RE.test(clean.slice(Math.max(0, idx - 40), idx))) return true;
  const { start, end } = clauseBounds(clean, idx);
  const clause = clean.slice(start, end);
  REQUIREMENT_CITATION_RE.lastIndex = 0;
  const citations = [...clause.matchAll(REQUIREMENT_CITATION_RE)];
  if (!citations.length) return false;
  const inClause = all.filter((m) => (m.index ?? 0) >= start && (m.index ?? 0) < end);
  if (!inClause.length) return false;
  return citations.some((c) => {
    const cStart = start + (c.index ?? 0);
    const cEnd = cStart + c[0].length;
    const preceding = inClause.filter((m) => (m.index ?? 0) < cStart).at(-1);
    const precedingEnd = preceding ? (preceding.index ?? 0) + preceding[0].length : cStart;
    const gap = clean.slice(precedingEnd, cStart);
    const precedes = !!preceding && (/^\s*(?:this|that|the)?\s*$/i.test(gap) || (/\b(?:this|that)\s*$/i.test(gap) && !/[,;:]|\b(?:and|but)\b/i.test(gap)));
    const following = inClause.find((m) => (m.index ?? 0) >= cEnd);
    const cited = precedes ? preceding : (following ?? preceding);
    return cited?.index === idx;
  });
}

function countMatches(clean: string): RegExpMatchArray[] {
  COUNT_CLAIM_RE.lastIndex = 0;
  const all = [...clean.matchAll(COUNT_CLAIM_RE)];
  return all.filter((m) => {
    if (isDisclosedRequirement(clean, m, all)) return false;
    if (!TIME_NOUNS.has(m[2].toLowerCase())) return true;
    const idx = m.index ?? 0;
    if (!HORIZON_LEAD_RE.test(clean.slice(Math.max(0, idx - 40), idx))) return true;
    const { start, end } = clauseBounds(clean, idx);
    return !FORWARD_MARKER_RE.test(clean.slice(start, end));
  });
}

/** Percentages, currency, multipliers, and noun-bound counts ("50k users"), normalized. */
export function metricClaims(text: string): Set<string> {
  const clean = foldDigits(cap(text));
  const claims = new Set<string>();
  for (const p of SIMPLE_CLAIM_PATTERNS) for (const m of clean.matchAll(p)) claims.add(normalizeClaim(m[0]));
  for (const m of countMatches(clean)) {
    const noun = m[2].toLowerCase();
    claims.add(normalizeClaim(`${m[1]} ${NOUN_SYNONYMS.get(noun) ?? noun}`));
  }
  return claims;
}

const GENERIC_COUNT_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(\d[\d,.]{0,14})\s*\+?\s*(?:[\p{L}][\p{L}\p{M}-]*\s+){0,${MODIFIER_WINDOW}}([\p{L}][\p{L}\p{M}]{2,})`, 'giu');

/** Non-null when >=2 count-shaped spans exist but the noun list recognised none of them. */
export function diagnoseCoverage(text: string): string | null {
  const clean = foldDigits(cap(text));
  const covered: Array<[number, number]> = [];
  for (const p of SIMPLE_CLAIM_PATTERNS) for (const m of clean.matchAll(p)) covered.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const hit = (i: number) => covered.some(([a, b]) => i >= a && i < b);
  const spans: string[] = [];
  for (const m of clean.matchAll(GENERIC_COUNT_RE)) {
    if (/^(?:19|20)\d{2}$/.test(m[1].replace(/[,.]/g, ''))) continue;
    if (hit(m.index ?? 0)) continue;
    spans.push(m[0].trim());
  }
  if (spans.length < 2) return null;
  COUNT_CLAIM_RE.lastIndex = 0;
  if ([...clean.matchAll(COUNT_CLAIM_RE)].length > 0) return null;
  return `counts not checked: ${spans.length} count-like spans matched no known noun (${spans.slice(0, 3).join('; ')})`;
}

// ---------- employer / title / tool claims ----------
const TOOL_PROSE_WORDS = new Set(['a', 'an', 'and', 'at', 'built', 'by', 'containerized', 'deployment', 'deployments', 'delivery', 'diagnosing', 'efficiency', 'feedback', 'for', 'from', 'improve', 'improving', 'in', 'of', 'on', 'on-time', 'operations', 'production', 'project', 'recurring', 'resolving', 'submission', 'team', 'the', 'to', 'using', 'with']);
const DETERMINER_LEAD_RE = /^(?:the|that|this|these|those|our|your|their|its|his|her|my)(?:\s+|$)/i;
const DECLARED_TOOL_TRIGGER_RE = /^(?:technologies?|tech stack)\s*:/i;
const TOOL_PHRASE_PATTERN = /^(?=.{1,80}$)[\p{L}\p{N}.][\p{L}\p{N}+#./-]*(?:\s+[\p{L}\p{N}.][\p{L}\p{N}+#./-]*){0,2}$/u;

/** Whole-token/phrase containment ("go" does not match inside "google"). */
export function sourceContainsFact(sourceNormalized: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}+#/-])${escaped}(?=$|[^\\p{L}\\p{N}+#/-])`, 'iu').test(sourceNormalized);
}

function looksToolShaped(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (/\d/.test(t)) return true;
  return t.split(/\s+/).every((w) => /^\p{Lu}/u.test(w));
}

function isLikelyTool(raw: string, sourceNormalized: string | null): boolean {
  const n = normalizeFact(raw);
  const ws = n.split(' ');
  if (!n || ws.length > 3) return false;
  if (!TOOL_PHRASE_PATTERN.test(raw.trim())) return false;
  if (looksToolShaped(raw)) return true;
  if (sourceNormalized != null && sourceContainsFact(sourceNormalized, n)) return true;
  if (sourceNormalized != null && ws.every((w) => sourceContainsFact(sourceNormalized, w))) return false;
  return !ws.some((w) => TOOL_PROSE_WORDS.has(w));
}

export interface FactClaim { kind: 'employer' | 'title' | 'tool' | 'authorship'; value: string }

function sentenceBoundaries(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n' || ('.!?'.includes(text[i]) && !(/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')))) out.push(i);
  }
  return out;
}

/** Sentence containing `index`, from boundaries precomputed once per text (binary search, no rescans). */
function sentenceAt(text: string, bounds: number[], index: number): string {
  let lo = 0, hi = bounds.length; // first boundary >= index
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bounds[mid] >= index) hi = mid; else lo = mid + 1; }
  const start = lo > 0 ? bounds[lo - 1] + 1 : 0;
  const end = lo < bounds.length ? bounds[lo] : text.length;
  return text.slice(start, end);
}

export function factClaims(text: string, sourceNormalized: string | null = null): FactClaim[] {
  const clean = foldDigits(cap(text));
  const sentenceBounds = sentenceBoundaries(clean);
  const out: FactClaim[] = [];
  const patterns: Array<[FactClaim['kind'], RegExp]> = [
    ['employer', /\b(?:[Ww]orked [Aa]t|[Jj]oined|[Ee]mployer\s*:\s*|[Cc]ompany\s*:\s*)\s*([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/g],
    ['title', /\b(?:[Ss]erved [Aa]s|[Ww]orked [Aa]s|[Tt]itle\s*:\s*|[Rr]ole\s*:\s*)\s*(?:an?\s+|the\s+)?([A-Z][\w/-]+(?:\s+(?:of|for|and|the)\s+[A-Z][\w/-]*|\s+[A-Z][\w/-]*){0,4})|\b(?:[Ww]orked [Aa]t|[Jj]oined)\s+[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4}\s+[Aa]s\s+(?:an?\s+|the\s+)?([A-Z][\w/-]+(?:\s+(?:of|for|and|the)\s+[A-Z][\w/-]*|\s+[A-Z][\w/-]*){0,4})/g],
    ['tool', /\b(?:using|built with|worked with|technologies?\s*:\s*|tech stack\s*:\s*)([^;\n]+?)(?=\s+\bfor\b|\.(?=\s|$)|[;\n]|$)/gi],
  ];
  for (const [kind, re] of patterns) {
    for (const m of clean.matchAll(re)) {
      if (kind === 'tool' && NEGATION_RE.test(sentenceAt(clean, sentenceBounds, m.index ?? 0))) continue; // "I haven't worked with X yet" is a disclosure
      const rawText = kind === 'tool' ? m[1].trim() : '';
      const declared = kind === 'tool' && DECLARED_TOOL_TRIGGER_RE.test(m[0]);
      const raws = kind === 'tool'
        ? (!declared && DETERMINER_LEAD_RE.test(rawText) ? [] : rawText.split(/,|\band\b|\bwith\b|\bin\b/i).filter((r) => !DETERMINER_LEAD_RE.test(r.trim())))
        : [m[1] || m[2]];
      for (const raw of raws) {
        if (!raw) continue;
        const value = normalizeFact(raw);
        if (value && (kind !== 'tool' || isLikelyTool(raw, sourceNormalized))) out.push({ kind, value });
      }
    }
  }
  return out;
}

// ---------- delegated authorship ----------
const DELEGATED_PARTY_RE = /\b(?:vendors?|agenc(?:y|ies)|contractors?|consultanc(?:y|ies)|consultants?|external teams?|outsourc(?:ed|ing)|implementation partners?)\b/i;
const DELEGATION_RE = /\b(?:commissioned|coordinated|directed|engaged|hired|managed|oversaw|partnered with|supervised)\b/i;
const DIRECT_AUTHORSHIP_SIGNAL_RE = /\b(?:authored|built|coded|developed|engineered|implemented|programmed|wrote)\b/i;
const THIRD_PARTY_EXECUTION_RE = /\b(?:vendors?|agenc(?:y|ies)|contractors?|consultanc(?:y|ies)|consultants?|external teams?|outsourc(?:ed|ing)|implementation partners?)\b[^.;!?]{0,120}\b(?:which|who|that)\b[^.;!?]{0,120}\b(?:authored|built|coded|developed|engineered|implemented|programmed|wrote)\b/i;
const DIRECT_AUTHORSHIP_CLAIM_RE = /\b(authored|built|coded|developed|engineered|implemented|programmed|wrote)\b\s+(?:the\s+|an?\s+|my\s+|our\s+)?([^.;!?]{1,160})/giu;
const ATTRIBUTION_STOP_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'authored', 'build', 'built', 'by', 'coded', 'commissioned', 'coordinated', 'created', 'developed', 'directed', 'engineered', 'engaged', 'for', 'from', 'hired', 'implemented', 'in', 'managed', 'my', 'of', 'on', 'our', 'oversaw', 'partnered', 'programmed', 'supervised', 'the', 'through', 'to', 'vendor', 'vendors', 'with', 'wrote']);

function factStatements(text: string): string[] {
  return foldDigits(String(text ?? '').replace(/\r?\n+/g, '. ')).split(/(?:[.!?]\s+|[.!?]$)/u).map((s) => s.trim()).filter(Boolean);
}
function attributionTokens(text: string): string[] {
  return normalizeFact(text).split(/[^\p{L}\p{N}+#./-]+/u).filter((t) => t.length >= 3 && !ATTRIBUTION_STOP_WORDS.has(t));
}

/** Base says a vendor/agency did the work; tailored text claims the candidate built it. */
export function delegatedAuthorshipClaims(targetText: string, sourceText: string): FactClaim[] {
  const src = factStatements(cap(sourceText));
  const direct = src.filter((s) => DIRECT_AUTHORSHIP_SIGNAL_RE.test(s) && !THIRD_PARTY_EXECUTION_RE.test(s)).map((s) => new Set(attributionTokens(s)));
  const delegated = src
    .filter((s) => DELEGATED_PARTY_RE.test(s) && DELEGATION_RE.test(s))
    .filter((s) => !DIRECT_AUTHORSHIP_SIGNAL_RE.test(s) || THIRD_PARTY_EXECUTION_RE.test(s))
    .map((s) => new Set(attributionTokens(s)));
  if (!delegated.length) return [];
  const out: FactClaim[] = [];
  for (const st of factStatements(cap(targetText))) {
    if (DELEGATED_PARTY_RE.test(st)) continue;
    DIRECT_AUTHORSHIP_CLAIM_RE.lastIndex = 0;
    for (const m of st.matchAll(DIRECT_AUTHORSHIP_CLAIM_RE)) {
      const tokens = [...new Set(attributionTokens(m[2]))];
      if (tokens.length < 2) continue;
      if (direct.some((d) => tokens.filter((t) => d.has(t)).length >= 2)) continue;
      if (delegated.some((d) => tokens.filter((t) => d.has(t)).length >= 2)) out.push({ kind: 'authorship', value: normalizeFact(`${m[1]} ${m[2]}`) });
    }
  }
  return out.filter((c, i, all) => all.findIndex((o) => o.value === c.value) === i);
}
