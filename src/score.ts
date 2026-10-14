// file: src/score.ts
// Matcher-row validation and invariants. Requirement table adapted from career-ops-hq/career-ops modes/_shared.md
// Block B (MIT, (c) 2026 Santiago Fernandez de Valderrama); write invariants adapted from MadsLorentzen/ai-job-search
// tools/rank_state.py (MIT, (c) 2026 Mads Lorentzen). See those repos' LICENSE files.
import type { MatchResultInput } from './db.js';
import { htmlToText } from './htmlText.js';
import { LANGUAGES } from './languages.js';

export type Importance = 'critical' | 'high' | 'meaningful' | 'preferred' | 'low_signal';
export type Evidence = 'stated' | 'structural' | 'inferred';
export type ReqMatch = 'strong' | 'partial' | 'missing';
export type ReqCategory = 'skill' | 'experience' | 'education' | 'location' | 'language' | 'other';
export interface Requirement { req: string; importance: Importance; evidence: Evidence; jd_quote: string | null; match: ReqMatch; category?: ReqCategory }
export interface ScoreDims { skills: number; seniority: number; domain: number; location: number }
export interface MatchRowInput extends MatchResultInput {
  score_dims?: ScoreDims;
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
  // Prefixed "injection-suspect" (";"-joined) whenever the posting contains an injection phrase, even if the score was already <= 75.
  score_cap_reason: string | null;
  // Injection phrases found in the posting (non-empty => score capped at 75 and score_cap_reason starts with "injection-suspect").
  injection_phrases: string[];
}

const IMPORTANCE: Importance[] = ['critical', 'high', 'meaningful', 'preferred', 'low_signal'];
const EVIDENCE: Evidence[] = ['stated', 'structural', 'inferred'];
const MATCHES: ReqMatch[] = ['missing', 'partial', 'strong'];
const CATEGORIES: ReqCategory[] = ['skill', 'experience', 'education', 'location', 'language', 'other'];
const VERDICTS = ['PASS', 'FAIL', 'FLAG'] as const;
const DIMS: Array<keyof ScoreDims> = ['skills', 'seniority', 'domain', 'location'];
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
export const INJECTION_SCORE_CAP = 75;

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

export function normalizeMatchRow(r: MatchRowInput, description?: string): { ok: true; row: NormalizedMatch } | { ok: false; error: string } {
  let score: number;
  let capReason: string | null = null;
  let dims: ScoreDims | null = null;
  if (r.score_dims != null) {
    for (const k of DIMS) {
      const v = (r.score_dims as any)[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 25) return { ok: false, error: `invalid score_dims.${k}: ${String(v)}` };
    }
    dims = { skills: r.score_dims.skills, seniority: r.score_dims.seniority, domain: r.score_dims.domain, location: r.score_dims.location };
    score = dims.skills + dims.seniority + dims.domain + dims.location;
  } else {
    // Without score_dims only an expired row (score 0, reasons "expired") is acceptable; anything else would bypass the evidence ceiling.
    const expired = r.score === 0 && typeof r.reasons === 'string' && r.reasons.trim().toLowerCase() === 'expired';
    if (!expired) return { ok: false, error: 'missing score_dims' };
    score = 0;
  }
  const plain = description != null ? htmlToText(description) : undefined;
  const requirements = normalizeRequirementsWith(r.requirements, description ? foldedPosting(description, plain ?? '') : null);
  if (dims) {
    const cap = evidenceCeiling(requirements);
    if (score > cap.ceiling) { score = cap.ceiling; capReason = cap.reason; }
  }
  // Injection defence: a posting that talks to the AI screener cannot score above 75, whatever the model was talked into.
  // Raw text is scanned too, so an instruction hidden in an HTML comment or attribute still counts.
  const injection = [...new Set([...injectionPhrases(plain), ...injectionPhrases(description)])];
  if (injection.length) {
    // Keep the evidence-cap reason only when it is the binding one (it took the score to 75 or below).
    if (score > INJECTION_SCORE_CAP) { score = INJECTION_SCORE_CAP; capReason = null; }
    capReason = capReason ? `injection-suspect;${capReason}` : 'injection-suspect';
  }
  // Loosely typed fields are sanitized here, never allowed to fail the call: only the score/dims decide rejection.
  const verdict = (v: unknown) => ((VERDICTS as readonly unknown[]).includes(v) ? (v as 'PASS' | 'FAIL' | 'FLAG') : undefined);
  return {
    ok: true,
    row: {
      ...r,
      reasons: typeof r.reasons === 'string' ? r.reasons : '',
      missing_keywords: Array.isArray(r.missing_keywords) ? r.missing_keywords.filter((k): k is string => typeof k === 'string') : [],
      location_verdict: verdict(r.location_verdict),
      language_gate: verdict(r.language_gate),
      score,
      score_dims: dims,
      requirements,
      strengths: cap3(r.strengths),
      gaps: cap3(r.gaps),
      // Without the posting text no quote was verified, so no row can create a hard stop.
      hard_stops: description ? hardStops(requirements) : [],
      injection_phrases: injection,
      confidence: confidenceOf(requirements, plain?.length),
      deadline: r.deadline === undefined ? undefined : typeof r.deadline === 'string' && r.deadline.trim() ? r.deadline.trim() : null,
      language_note: typeof r.language_note === 'string' && r.language_note.trim() ? r.language_note.trim() : null,
      score_cap_reason: capReason,
    },
  };
}
