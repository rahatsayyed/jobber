// file: src/languageGate.ts
// Adapted from MadsLorentzen/ai-job-search 04-job-evaluation.md "Language Gate" (MIT, (c) 2026 Mads Lorentzen). See that repo's LICENSE.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { userDataPath } from './lib/userData.js';
import { htmlToLines } from './htmlText.js';
import { LANGUAGES } from './languages.js';

export type LangLevel = 'basic' | 'professional' | 'fluent' | 'native';
export interface DeclaredLanguage { language: string; level: LangLevel }
export interface LanguageConfig { declared: DeclaredLanguage[]; confirmed: boolean }
export interface LanguageRequirement { language: string; level: LangLevel; preferred: boolean; quote: string }
type Verdict = 'PASS' | 'FAIL' | 'FLAG';

// Canonical language per accepted spelling (diacritics are folded before lookup). Mandarin counts as Chinese; Cantonese stays separate.
const CANON = new Map<string, string>(LANGUAGES.map((l) => [l, l]));
CANON.set('Mandarin', 'Chinese');
for (const [alias, canon] of Object.entries({ Espanol: 'Spanish', Deutsch: 'German', Francais: 'French', Portugues: 'Portuguese',
  Italiano: 'Italian', Nederlands: 'Dutch', Polski: 'Polish' })) CANON.set(alias, canon);

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function canonLanguage(name: string): string {
  const f = fold(String(name).trim());
  return CANON.get(f) ?? CANON.get(f.charAt(0).toUpperCase() + f.slice(1).toLowerCase()) ?? f;
}

// A language name only counts when one of these words sits right next to it (skipping joiners and other language names).
// This is what separates "Fluent German is required" from "German customers must be served".
const CONTEXT = new Set(['fluent', 'fluency', 'native', 'proficient', 'proficiency', 'bilingual', 'multilingual', 'conversational',
  'speak', 'speaks', 'speaking', 'speaker', 'speakers', 'written', 'spoken', 'verbal', 'knowledge', 'command', 'language', 'languages',
  'level', 'skills', 'communication', 'c1', 'c2', 'b2', 'required', 'mandatory', 'essential', 'needed', 'necessary',
  'plus', 'bonus', 'advantage', 'advantageous', 'preferred', 'desirable']);
const JOINERS = new Set(['and', 'or', 'in', 'of', 'with', 'the', 'a', 'an', 'is', 'are', 'be', 'to', 'for', 'as', 'strong', 'big', 'real', 'definite', 'great', 'nice', 'huge']);
// "Hindi speaking customers" describes the audience, not a requirement on the candidate.
const AUDIENCE = new Set(['customer', 'customers', 'client', 'clients', 'user', 'users', 'market', 'markets', 'country', 'countries',
  'region', 'regions', 'population', 'audience', 'community', 'communities', 'team', 'teams', 'colleagues', 'candidates', 'candidate',
  'people', 'stakeholders', 'partners', 'area', 'areas', 'territory', 'territories', 'businesses', 'world']);
// "written in German", "available in English and German" describe the ad or the product, not the candidate.
const MEDIA = new Set(['written', 'available', 'translated', 'published', 'provided', 'posted', 'offered', 'presented', 'localized', 'localised']);
const NEG = new Set(['no', 'not', 'without', 'never']);
const REQ_RE = /\b(?:required|must|mandatory|needed|essential|necessary|requirement)\b/i;
const PREF_RE = /\b(?:nice to have|plus|bonus|preferred|preferable|advantage|advantageous|desirable|ideally)\b/i;
const CUE_TOKENS = new Set(['required', 'must', 'mandatory', 'needed', 'essential', 'necessary', 'requirement',
  'nice', 'plus', 'bonus', 'preferred', 'preferable', 'advantage', 'advantageous', 'desirable', 'ideally']);
const RANK: Record<LangLevel, number> = { basic: 0, professional: 1, fluent: 2, native: 3 };
const ORDER: Verdict[] = ['PASS', 'FLAG', 'FAIL'];
const MAX_QUOTE = 200;
const MAX_SKIPS = 6;
const NATIVE_RE = '(?:native|mother tongue|c2)';
const FLUENT_RE = '(?:fluent|fluency|excellent|business[\\s-]level|c1|advanced)';

function levelOf(sentence: string): LangLevel {
  // "native or fluent X" accepts the lower level.
  if (new RegExp(`\\b${NATIVE_RE}\\b\\s*(?:/|or)\\s*\\b${FLUENT_RE}\\b|\\b${FLUENT_RE}\\b\\s*(?:/|or)\\s*\\b${NATIVE_RE}\\b`, 'i').test(sentence)) return 'fluent';
  if (/\b(?:native|mother tongue|c2)\b/i.test(sentence)) return 'native';
  if (/\b(?:fluent|fluency|excellent|business[\s-]level|c1|advanced)\b/i.test(sentence)) return 'fluent';
  if (/\b(?:basic|conversational|a2|b1)\b/i.test(sentence)) return 'basic';
  return 'fluent';
}

function sentences(text: string): string[] {
  return String(text ?? '').split(/\n+|(?<=[.!?;])\s+|\s*[•·]\s*/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

interface Clause { tokens: string[]; sep: string; hasReq: boolean; hasPref: boolean; hasLang: boolean; hasNeg: boolean }

/** Split on commas, semicolons, dashes, "and", "or", "but", "&"; "and"/"or"/"&" are remembered because they join list items. */
function splitClauses(s: string): Clause[] {
  const parts = s.split(/(,|;|\s[-–—]\s|—|–|\s&\s|\s(?:and|or|but)\s)/i);
  const out: Clause[] = [];
  let sep = '';
  parts.forEach((p, k) => {
    if (k % 2 === 1) { const t = p.trim().toLowerCase(); sep = t === 'and' || t === 'or' || t === '&' ? 'join' : 'hard'; return; }
    const tokens = p.match(/[A-Za-z0-9]+/g) ?? [];
    const low = tokens.map((t) => t.toLowerCase());
    out.push({ tokens, sep, hasReq: REQ_RE.test(p), hasPref: PREF_RE.test(p), hasLang: tokens.some((t) => CANON.has(t)), hasNeg: low.some((w) => NEG.has(w)) });
  });
  return out;
}

function negBefore(tokens: string[], idx: number, window: number): boolean {
  for (let j = Math.max(0, idx - window); j < idx; j++) if (NEG.has(tokens[j].toLowerCase())) return true;
  return false;
}

/** True when a context word is right next to token i in direction dir (+1 after, -1 before). */
function contextNear(tokens: string[], i: number, dir: 1 | -1): boolean {
  let skips = 0;
  for (let j = i + dir; j >= 0 && j < tokens.length && skips <= MAX_SKIPS; j += dir, skips++) {
    const raw = tokens[j];
    const w = raw.toLowerCase();
    if (CANON.has(raw) || JOINERS.has(w)) continue;
    if (dir === 1 && (w === 'speaking' || w === 'speaker' || w === 'speakers') && AUDIENCE.has((tokens[j + 1] ?? '').toLowerCase())) return false;
    return CONTEXT.has(w);
  }
  return false;
}

/** "written in German", "available in English and German": walk back over language names to find in/into + a media word. */
function describesMedium(tokens: string[], i: number): boolean {
  let j = i - 1;
  while (j >= 0 && CANON.has(tokens[j])) j--;
  const w = (tokens[j] ?? '').toLowerCase();
  return (w === 'in' || w === 'into') && MEDIA.has((tokens[j - 1] ?? '').toLowerCase());
}

/** Classify one language mention using only its own clause (and the next one when a list item has no cue of its own). */
function classify(clauses: Clause[], c: number, pos: number): 'requirement' | 'preferred' | 'negated' {
  const cl = clauses[c];
  const prev = clauses[c - 1];
  const next = clauses[c + 1];
  const own = cl.hasReq || cl.hasPref;
  if (negBefore(cl.tokens, pos, 3) || NEG.has((cl.tokens[pos + 1] ?? '').toLowerCase())) return 'negated';
  // "No German or French needed": the negation sits in the earlier list item that holds a language but no cue.
  if (prev && cl.sep === 'join' && prev.hasNeg && prev.hasLang && !prev.hasReq && !prev.hasPref) return 'negated';
  const cue = !own && next && next.sep === 'join' && (next.hasReq || next.hasPref) ? next : cl;
  if (cue.tokens.some((t, k) => CUE_TOKENS.has(t.toLowerCase()) && negBefore(cue.tokens, k, 4))) return 'negated';
  return cue.hasPref && !cue.hasReq ? 'preferred' : 'requirement';
}

// A line that is only one of these marks the lines after it as preferred ("Added bonus" followed by a list).
const PREF_HEADING_RE = /^(?:added\s+)?(?:bonus(?:\s+points)?|nice[\s-]to[\s-]haves?|preferred|plus(?:es)?)\s*:?$/i;
// Where a bonus block stops: a blank line, a line ending in ":" or "?" (short), or a plain known section name.
const SECTION_HEADING_RE = /^(?:requirements?|responsibilities|qualifications|benefits|perks|skills|experience|the role|about\b.*|what (?:you|we)\b.*|who (?:you|we)\b.*|must[\s-]haves?|key (?:skills|responsibilities)|how to apply|compensation|salary|why\b.*)\s*:?$/i;
const isSectionHeading = (line: string) => SECTION_HEADING_RE.test(line) || (/[:?]$/.test(line) && line.split(/\s+/).length <= 8);

/** HTML is stripped first; only language names with language-context wording next to them count.
 *  Everything under a bare "Added bonus" / "Bonus" / "Nice to have" / "Preferred" / "Plus" heading is preferred,
 *  until the next heading or blank line. */
export function detectLanguageRequirements(jd: string): LanguageRequirement[] {
  const out: LanguageRequirement[] = [];
  let bonusBlock = false;
  const items: { raw: string; bonus: boolean }[] = [];
  for (const line of String(htmlToLines(jd)).split('\n')) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (!t) { bonusBlock = false; continue; }
    if (PREF_HEADING_RE.test(t)) { bonusBlock = true; continue; }
    if (isSectionHeading(t)) bonusBlock = false;
    for (const raw of sentences(t)) items.push({ raw, bonus: bonusBlock });
  }
  for (const { raw, bonus } of items) {
    const s = fold(raw).replace(/n['’]t\b/gi, ' not');
    const clauses = splitClauses(s);
    const flat: { tok: string; c: number; pos: number }[] = [];
    clauses.forEach((cl, c) => cl.tokens.forEach((tok, pos) => flat.push({ tok, c, pos })));
    const tokens = flat.map((f) => f.tok);
    const found = new Map<string, boolean>();
    flat.forEach((f, i) => {
      const lang = CANON.get(f.tok);
      if (!lang || found.has(lang)) return;
      if (!(contextNear(tokens, i, -1) || contextNear(tokens, i, 1)) || describesMedium(tokens, i)) return;
      const kind = classify(clauses, f.c, f.pos);
      if (kind !== 'negated') found.set(lang, kind === 'preferred');
    });
    if (!found.size) continue;
    const quote = raw.length > MAX_QUOTE ? `${raw.slice(0, MAX_QUOTE - 3)}...` : raw;
    const level = levelOf(s);
    for (const [language, preferred] of found) out.push({ language, level, preferred: preferred || bonus, quote });
  }
  return out;
}

export function languageGate(
  jd: string,
  declared: DeclaredLanguage[],
  opts: { confirmed?: boolean } = {},
): { verdict: Verdict; note: string | null } {
  const confirmed = opts.confirmed ?? true;
  const have = new Map(declared.map((d) => [canonLanguage(d.language).toLowerCase(), d.level]));
  let verdict: Verdict = 'PASS';
  let note: string | null = null;
  for (const r of detectLanguageRequirements(jd)) {
    const mine = have.get(r.language.toLowerCase());
    let v: Verdict = 'PASS';
    let n: string | null = null;
    if (mine == null) {
      v = r.preferred ? 'FLAG' : 'FAIL';
      n = `${r.preferred ? 'prefers' : 'requires'} ${r.language} (${r.level}): "${r.quote}"`;
      // Until the user confirms user-data/languages.json the declared list is a guess: never exclude on it.
      if (v === 'FAIL' && !confirmed) { v = 'FLAG'; n = `unconfirmed languages.json: ${n}`; }
    } else if (RANK[mine] < RANK[r.level]) {
      v = 'FLAG';
      n = `asks ${r.language} (${r.level}), declared ${mine}: "${r.quote}"`;
    }
    if (ORDER.indexOf(v) > ORDER.indexOf(verdict)) { verdict = v; note = n; }
  }
  return { verdict, note };
}

const defaultPath = userDataPath('languages.json');

/** null = missing, unreadable, empty or containing ANY invalid entry: callers must surface a "language gate config missing" flag rather than skip silently. */
export function loadLanguageConfig(file: string = defaultPath): LanguageConfig | null {
  return loadLanguageConfigStatus(file).config;
}

/** Like loadLanguageConfig but says why it failed: `missing` (no file / unreadable / empty) vs `invalid` (file present, an entry is bad; `invalid` holds the entry). */
export function loadLanguageConfigStatus(file: string = defaultPath): { config: LanguageConfig | null; problem?: 'missing' | 'invalid'; invalid?: string } {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return { config: null, problem: 'missing' }; }
  try {
    const j = JSON.parse(raw);
    if (!Array.isArray(j?.declared) || !j.declared.length) return { config: null, problem: 'missing' };
    const declared: DeclaredLanguage[] = [];
    for (const d of j.declared) {
      const language = typeof d?.language === 'string' ? d.language.trim() : '';
      const level = typeof d?.level === 'string' ? d.level.trim().toLowerCase() : '';
      if (!language || language in Object.prototype || !Object.hasOwn(RANK, level)) {
        const entry = JSON.stringify(d).slice(0, 120);
        console.error(`[languageGate] invalid entry in ${path.basename(file)}: ${entry}`);
        return { config: null, problem: 'invalid', invalid: entry };
      }
      declared.push({ language, level: level as LangLevel });
    }
    return { config: { declared, confirmed: j.confirmed === true } };
  } catch {
    return { config: null, problem: 'missing' };
  }
}
