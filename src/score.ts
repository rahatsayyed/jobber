// file: src/score.ts
// Matcher-row validation and invariants. Requirement table adapted from career-ops-hq/career-ops modes/_shared.md
// Block B (MIT, (c) 2026 Santiago Fernandez de Valderrama); write invariants adapted from MadsLorentzen/ai-job-search
// tools/rank_state.py (MIT, (c) 2026 Mads Lorentzen). See those repos' LICENSE files.
import type { MatchResultInput } from './db.js';
import { htmlToText } from './htmlText.js';
import { LANGUAGES } from './languages.js';
import { CO_DIMS, RED_FLAGS_FLOOR, RUBRIC_TAG, dimsKind, matchThresholdFromEnv, parseCareerOpsDims, scaleGlobal, type CareerOpsDims } from './matchRubric.js';

export type Importance = 'critical' | 'high' | 'meaningful' | 'preferred' | 'low_signal';
export type Evidence = 'stated' | 'structural' | 'inferred';
export type ReqMatch = 'strong' | 'partial' | 'missing';
export type ReqCategory = 'skill' | 'experience' | 'education' | 'location' | 'language' | 'other';
export interface Requirement { req: string; importance: Importance; evidence: Evidence; jd_quote: string | null; match: ReqMatch; category?: ReqCategory }
/** The career-ops rubric (src/matchRubric.ts): cv_match, north_star, comp, culture (1..5), red_flags (0 or negative) and the holistic global (1..5). */
export type ScoreDims = CareerOpsDims;
export interface MatchRowInput extends MatchResultInput {
  /** What the matcher sends (validated in normalizeMatchRow; `decision` is derived in code, never read). */
  score_dims?: Record<string, unknown>;
  requirements?: Requirement[];
  strengths?: string[];
  gaps?: string[];
  deadline?: string | null;
  language_note?: string;
  error?: string;
}
export interface NormalizedMatch extends MatchResultInput {
  score_dims: ScoreDims | null;
  requirements: Requirement[];
  strengths: string[];
  gaps: string[];
  hard_stops: string[];
  confidence: 'high' | 'medium' | 'low';
  deadline: string | null | undefined;
  language_note: string | null;
  // Which cap lowered the score (e.g. "evidence-ceiling:72", "empty-table:70"), or null when the dims sum stood.
  // Prefixed "injection-suspect" (";"-joined) whenever the posting contains an injection phrase, even if the score was already <= 89.
  score_cap_reason: string | null;
  // Injection phrases found in the posting (non-empty => score capped at 89 and score_cap_reason starts with "injection-suspect").
  injection_phrases: string[];
}

const IMPORTANCE: Importance[] = ['critical', 'high', 'meaningful', 'preferred', 'low_signal'];
const EVIDENCE: Evidence[] = ['stated', 'structural', 'inferred'];
const MATCHES: ReqMatch[] = ['missing', 'partial', 'strong'];
const CATEGORIES: ReqCategory[] = ['skill', 'experience', 'education', 'location', 'language', 'other'];
const VERDICTS = ['PASS', 'FAIL', 'FLAG'] as const;
const MAX_ROWS = 12;
const QUOTE_MIN = 12;
const QUOTE_MAX = 300;
const WEIGHT: Partial<Record<Importance, number>> = { critical: 3, high: 2, meaningful: 1 };
const TIER_FACTOR: Record<Evidence, number> = { stated: 1, structural: 0.75, inferred: 0.4 };
const MET: Record<ReqMatch, number> = { strong: 1, partial: 0.5, missing: 0 };
const EMPTY_TABLE_CEILING = 70;

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

export function normalizeRequirements(reqs: unknown, description?: string): Requirement[] {
  return normalizeRequirementsWith(reqs, description ? foldedPosting(description, htmlToText(description)) : null);
}

// The model quotes what it read, which may be raw HTML (remotive/remoteok) or page text: accept a quote found in either form.
const foldedPosting = (description: string, plain: string) => `${fold(description)} ${fold(plain)}`;

// Prompt-injection phrases aimed at an AI screener. Kept narrow on purpose: ordinary job-ad uses of "rate", "ignore",
// "AI", "score" or "system prompt" (e.g. "competitive rate of pay", "write system prompts for our agents") must not match.
// Every pattern is linear (no nested quantifiers) and the scanned text is clamped, so a hostile posting cannot stall the scan.
const INJECTION_RES: RegExp[] = [
  /\bignore\s+(?:all|any)\s+(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:(?:previous|prior|above|earlier|other)\s+)?(?:instructions|prompts?|rules)\b/i,
  /\bignore\s+(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts?|rules)\b/i,
  /\bscore\s+(?:this|the)\s+(?:candidate|applicant|resume|cv|application|profile)\s+(?:at\s+|as\s+)?(?:a\s+)?\d{1,3}\b/i,
  /\bscore\s+(?:at\s+|of\s+)?\d{1,3}\s*(?:\/\s*100|out\s+of\s+100)\b/i,
  /\b(?:give|assign|award)\s+(?:(?:this|the)\s+(?:candidate|applicant|resume|cv|application|profile)\s+)?(?:a\s+)?(?:(?:match|fit)\s+)?(?:score|rating)\s+(?:of\s+)?\d{1,3}\b/i,
  /\brate\s+(?:this|the)\s+(?:candidate|applicant|resume|cv|application|profile)\b/i,
  /\bmark\s+(?:every|all|each)\s+(?:of\s+the\s+)?(?:requirements?\s+|skills?\s+|items?\s+)?(?:as\s+)?(?:strong|met|matched)\b/i,
  /\bAI\s+screen(?:ing|ers?)\b/i,
  /\bas\s+an\s+(?:AI|LLM)(?:\s+(?:language\s+model|model|assistant|system))?(?=\s*[,.:;!]|\s+(?:you|please|ignore|give|rate|score|mark|must)\b)/i,
  /\b(?:your|previous|original|hidden)\s+system\s+prompt\b|\bsystem\s+prompt\s*:/i,
  /\byou\s+must\s+(?:give|rate|score|assign)\s+(?:(?:this|the|a|an)\s+)?(?:candidate|applicant|resume|cv|application|profile|score|rating)\b/i,
  /\b(?:output|return|respond\s+with|reply\s+with)\s+a\s+(?:(?:match|fit)\s+)?(?:score|rating)\s+of\b/i,
];
const INJECTION_SCAN_MAX = 20000;
// 89 = Global 4.4 of 5: a posting aimed at an AI screener can never be a strong (4.5+) match, but it still passes the 4.0 cutoff when it earned it.
export const INJECTION_SCORE_CAP = 89;

/** The injection phrases found in a text (deduped, each cut to 80 chars), scanning at most the first 20000 chars of collapsed text. */
export function injectionPhrases(text: string | null | undefined): string[] {
  if (!text) return [];
  const t = text.slice(0, INJECTION_SCAN_MAX * 2).replace(/\s+/g, ' ').slice(0, INJECTION_SCAN_MAX);
  const hits: string[] = [];
  for (const re of INJECTION_RES) {
    const m = re.exec(t);
    if (m) hits.push(m[0].slice(0, 80));
  }
  return [...new Set(hits)];
}

function normalizeRequirementsWith(reqs: unknown, jd: string | null): Requirement[] {
  if (!Array.isArray(reqs)) return [];
  const out: Requirement[] = [];
  for (const r of reqs as any[]) {
    if (!r || typeof r.req !== 'string' || !r.req.trim()) continue;
    let evidence: Evidence = EVIDENCE.includes(r.evidence) ? r.evidence : 'inferred';
    let importance: Importance = IMPORTANCE.includes(r.importance) ? r.importance : 'meaningful';
    let jd_quote = typeof r.jd_quote === 'string' && r.jd_quote.trim() ? r.jd_quote.trim() : null;
    if (jd_quote && jd_quote.length > QUOTE_MAX) jd_quote = jd_quote.slice(0, QUOTE_MAX); // stored truncated, checked on its first 300 chars
    // "stated" means quoted from the posting: no quote, a too-short quote (a stray word proves nothing), or a quote not in the posting is at best structural.
    if (evidence === 'stated') {
      const q = jd_quote ? fold(jd_quote) : '';
      if (q.length < QUOTE_MIN || (jd != null && !jd.includes(q))) evidence = 'structural';
    }
    // A "requirement" quoted from an injected instruction is not a requirement: inferred, so never critical/high nor a hard stop.
    if (jd_quote && injectionPhrases(jd_quote).length) evidence = 'inferred';
    // Gate: inferred evidence can never be critical or high.
    if (evidence === 'inferred' && (importance === 'critical' || importance === 'high')) importance = 'meaningful';
    out.push({
      req: r.req.trim(), importance, evidence, jd_quote, match: MATCHES.includes(r.match) ? r.match : 'missing',
      ...(CATEGORIES.includes(r.category) ? { category: r.category as ReqCategory } : {}),
    });
  }
  out.sort((a, b) => IMPORTANCE.indexOf(a.importance) - IMPORTANCE.indexOf(b.importance) || MATCHES.indexOf(a.match) - MATCHES.indexOf(b.match));
  return out.filter((r, i) => i < MAX_ROWS || r.importance === 'critical' || r.importance === 'high');
}

// Location and language conditions belong to the dedicated gates (location_verdict, the language gate), never to hard stops.
// The matcher sets `category`; the wording check is the backstop when it forgets.
const LOCATION_OR_LANGUAGE_RE = new RegExp(
  `\\b(?:on-?site|onsite|hybrid|remote|relocat\\w*|locat(?:ion|ed)|based in|reside\\w*|time ?zone|visa|work (?:permit|authori[sz]ation)|right to work|iqama|emirates id|currently in|already in|fluent|fluency|bilingual|native speaker|language|${LANGUAGES.join('|')})\\b`, 'i');
const isLocationOrLanguage = (r: Requirement) => r.category === 'location' || r.category === 'language' || LOCATION_OR_LANGUAGE_RE.test(r.req);

/** Hard stop = an explicit non-negotiable the candidate does not meet: critical + missing, `stated` evidence (callers pass
 *  requirements already through the quote check, so `stated` means verified), and not a location/language row.
 *  Structural rows (including stated rows downgraded because their quote was too short or not found) and inferred rows never
 *  create a hard stop: a fabricated or unverifiable critical requirement must not remove a job from the pipeline. */
export function hardStops(reqs: Requirement[]): string[] {
  const names = reqs.filter((r) => r.importance === 'critical' && r.match === 'missing' && r.evidence === 'stated' && !isLocationOrLanguage(r)).map((r) => r.req);
  return [...new Set(names)];
}

// The requirement table can only LOWER the score: ceiling = 59 + round(41 * F), F = evidence-weighted share of the
// critical/high/meaningful rows that are met. No weighted rows (empty table) => 70. All-stated-and-met => 100; all-inferred-and-met => 75.
export function evidenceCeiling(reqs: Requirement[]): { ceiling: number; reason: string } {
  let num = 0;
  let den = 0;
  for (const r of reqs) {
    const w = WEIGHT[r.importance];
    if (!w) continue;
    num += w * TIER_FACTOR[r.evidence] * MET[r.match];
    den += w;
  }
  if (den === 0) return { ceiling: EMPTY_TABLE_CEILING, reason: `${reqs.length ? 'no-weighted-rows' : 'empty-table'}:${EMPTY_TABLE_CEILING}` };
  const ceiling = 59 + Math.round(41 * (num / den));
  return { ceiling, reason: `evidence-ceiling:${ceiling}` };
}

function confidenceOf(reqs: Requirement[], plainLength?: number): 'high' | 'medium' | 'low' {
  if (!reqs.length || (plainLength != null && plainLength < 300)) return 'low';
  return reqs.some((r) => r.evidence === 'inferred') ? 'medium' : 'high';
}

const cap3 = (xs: unknown): string[] =>
  (Array.isArray(xs) ? xs : []).filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim()).slice(0, 3);

export interface NormalizeOpts {
  /** MATCH_THRESHOLD (default: the env value, 80 = 4.0 of 5). A job held back by the pass rule is stored one point under it. */
  threshold?: number;
}

export function normalizeMatchRow(r: MatchRowInput, description?: string, opts: NormalizeOpts = {}): { ok: true; row: NormalizedMatch } | { ok: false; error: string } {
  let score: number;
  let dims: ScoreDims | null = null;
  const reasonsOfCap: string[] = [];
  let heldNote = '';
  if (r.score_dims != null) {
    // Only the career-ops shape is accepted for a NEW save. The older shapes (rubric_v2: role_fit, skills, ...; legacy: skills, seniority,
    // domain, location) stay readable in the db (src/matchRubric.ts dimsKind) but a fresh row in them is refused.
    const kind = dimsKind(r.score_dims);
    if (kind === 'legacy' || kind === 'rubric_v2') {
      return { ok: false, error: `${kind} score_dims is no longer accepted: use the career-ops rubric ${RUBRIC_TAG}: ${CO_DIMS.join(', ')} (1 to 5), red_flags (${RED_FLAGS_FLOOR} to 0) and global (1 to 5), one decimal each` };
    }
    const parsed = parseCareerOpsDims(r.score_dims);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    dims = parsed.dims;
    // The stored score is the Global score scaled to 0..100. career-ops has no formula: the Global is the model's holistic call
    // (code only keeps it from exceeding the best dimension, reported as a cap reason).
    score = scaleGlobal(dims.global);
    if (parsed.clamped) reasonsOfCap.push(`global-above-dimensions:${parsed.clamped}`);
  } else {
    // Without score_dims only an expired row (score 0, reasons "expired") is acceptable; anything else would bypass the evidence ceiling.
    const expired = r.score === 0 && typeof r.reasons === 'string' && r.reasons.trim().toLowerCase() === 'expired';
    if (!expired) return { ok: false, error: 'missing score_dims' };
    score = 0;
  }
  const plain = description != null ? htmlToText(description) : undefined;
  const requirements = normalizeRequirementsWith(r.requirements, description ? foldedPosting(description, plain ?? '') : null);
  // Without the posting text no quote was verified, so no row can create a hard stop.
  const hard_stops = description ? hardStops(requirements) : [];
  const verdict = (v: unknown) => ((VERDICTS as readonly unknown[]).includes(v) ? (v as 'PASS' | 'FAIL' | 'FLAG') : undefined);
  const locationVerdict = verdict(r.location_verdict);
  if (dims) {
    const globalScore = score;
    const cap = evidenceCeiling(requirements);
    if (score > cap.ceiling) { score = cap.ceiling; reasonsOfCap.push(cap.reason); }
    // PASS RULE (career-ops cutoff): the stored score (Global x 20) must reach MATCH_THRESHOLD (default 80 = 4.0 of 5; every consumer checks the
    // stored score). On top of that the two gates we keep: the location verdict is not FAIL and there is no hard stop. A job that fails one of
    // those is stored with its dimensions but one point under the threshold, so every existing consumer (P2c and the rest read
    // "stored score >= threshold") rejects it with no further change. The caps combine as a minimum.
    const threshold = opts.threshold ?? matchThresholdFromEnv();
    const held: string[] = [];
    if (locationVerdict === 'FAIL') held.push('location_fail');
    if (hard_stops.length) held.push('hard_stop');
    if (held.length) {
      const ceiling = Math.max(0, threshold - 1);
      if (score > ceiling) score = ceiling;
      reasonsOfCap.push(held.join(','));
      const why = [...(locationVerdict === 'FAIL' ? ['location FAIL'] : []), ...(hard_stops.length ? ['hard stop'] : [])];
      heldNote = ` [held back: ${why.join('; ')}; global score was ${dims.global} (${globalScore})]`;
    }
    // career-ops: "A role scoring 4.5+ overall but 2 or below on Cultural signals must carry an explicit warning in the report".
    if (dims.global >= 4.5 && dims.culture <= 2) heldNote += ' [High technical fit, unconfirmed/poor culture fit - verify before applying.]';
  }
  // Injection defence: a posting that talks to the AI screener cannot score above 89, whatever the model was talked into.
  // Raw text is scanned too, so an instruction hidden in an HTML comment or attribute still counts.
  const injection = [...new Set([...injectionPhrases(plain), ...injectionPhrases(description)])];
  let capReason: string | null = reasonsOfCap.length ? reasonsOfCap.join(';') : null;
  if (injection.length) {
    // Keep the other cap reasons only when they are the binding ones (they took the score to 89 or below).
    if (score > INJECTION_SCORE_CAP) { score = INJECTION_SCORE_CAP; capReason = null; }
    capReason = capReason ? `injection-suspect;${capReason}` : 'injection-suspect';
  }
  // Loosely typed fields are sanitized here, never allowed to fail the call: only the score/dims decide rejection.
  return {
    ok: true,
    row: {
      ...r,
      reasons: (typeof r.reasons === 'string' ? r.reasons : '') + heldNote,
      missing_keywords: Array.isArray(r.missing_keywords) ? r.missing_keywords.filter((k): k is string => typeof k === 'string') : [],
      location_verdict: locationVerdict,
      language_gate: verdict(r.language_gate),
      score,
      score_dims: dims,
      requirements,
      strengths: cap3(r.strengths),
      gaps: cap3(r.gaps),
      hard_stops,
      injection_phrases: injection,
      confidence: confidenceOf(requirements, plain?.length),
      deadline: r.deadline === undefined ? undefined : typeof r.deadline === 'string' && r.deadline.trim() ? r.deadline.trim() : null,
      language_note: typeof r.language_note === 'string' && r.language_note.trim() ? r.language_note.trim() : null,
      score_cap_reason: capReason,
    },
  };
}
