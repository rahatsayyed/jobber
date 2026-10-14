// src/safety/styleGate.ts
// Deterministic AI-tells check. Runs on the raw draft BEFORE dash normalization.
import { readFileSync } from 'node:fs';

export interface StyleConfig {
  banned_phrases: string[];
  forbid_em_dash: boolean;
  forbid_en_dash: boolean;
  max_exclamations: number;
  forbid_markdown: boolean;
  max_words: Record<string, number>;
}

export interface StyleHit {
  rule: string;
  detail: string;
}

/** Hard cap on analysed characters; anything longer is flagged too_long and only the head is scanned. */
export const MAX_STYLE_INPUT_CHARS = 20000;

export const DEFAULT_STYLE_CONFIG: StyleConfig = {
  banned_phrases: [
    'i hope this finds you well',
    'just following up',
    'circling back',
    'touch base',
    "i'd love to",
    'i would love to',
    'reaching out because',
    'just wanted to',
    'wanted to reach out',
    'i am writing to',
    'no pressure',
    'no obligation',
    "in today's",
    'game-changer',
    'game changer',
    'revolutionary',
    'cutting-edge',
    'cutting edge',
    'delve',
    'tapestry',
    'leverage',
    'synergy',
    'passionate about',
    'thrilled',
  ],
  forbid_em_dash: true,
  forbid_en_dash: true,
  max_exclamations: 1,
  forbid_markdown: true,
  max_words: { connect: 55, role_ask: 110, rapport: 90, referral_ask: 110, followup: 70, feedback: 60 },
};

function validLimit(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function cleanPhrases(list: string[]): string[] {
  return list.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseConfig(raw: unknown, path: string): StyleConfig {
  const r = raw as Partial<StyleConfig> | null;
  const ok =
    typeof r === 'object' &&
    r !== null &&
    Array.isArray(r.banned_phrases) &&
    r.banned_phrases.every((p) => typeof p === 'string') &&
    typeof r.forbid_em_dash === 'boolean' &&
    typeof r.forbid_en_dash === 'boolean' &&
    validLimit(r.max_exclamations) &&
    typeof r.forbid_markdown === 'boolean' &&
    typeof r.max_words === 'object' &&
    r.max_words !== null &&
    Object.values(r.max_words).every(validLimit);
  if (!ok) throw new Error(`${path} is not a valid style config`);
  const c = r as StyleConfig;
  return { ...c, banned_phrases: cleanPhrases(c.banned_phrases) };
}

export function loadStyleConfig(path: string): StyleConfig {
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')), path);
}

/** Never throws: a bad value falls back to the built-in default for that value, with a note to surface. */
export function loadStyleConfigSafe(path: string): { cfg: StyleConfig; note: string | null } {
  const d = DEFAULT_STYLE_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { cfg: d, note: `style config invalid, using built-in defaults: ${why}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { cfg: d, note: `style config invalid, using built-in defaults: ${path} is not an object` };
  }
  const r = raw as Record<string, unknown>;
  const bad: string[] = [];
  const bool = (k: 'forbid_em_dash' | 'forbid_en_dash' | 'forbid_markdown'): boolean => {
    if (typeof r[k] === 'boolean') return r[k] as boolean;
    bad.push(k);
    return d[k];
  };
  let phrases = d.banned_phrases;
  if (Array.isArray(r.banned_phrases) && r.banned_phrases.every((p) => typeof p === 'string')) {
    phrases = cleanPhrases(r.banned_phrases as string[]);
  } else bad.push('banned_phrases');
  let maxExcl = d.max_exclamations;
  if (validLimit(r.max_exclamations)) maxExcl = r.max_exclamations;
  else bad.push('max_exclamations');
  const maxWords: Record<string, number> = {};
  if (typeof r.max_words === 'object' && r.max_words !== null && !Array.isArray(r.max_words)) {
    for (const [k, v] of Object.entries(r.max_words as Record<string, unknown>)) {
      if (validLimit(v)) maxWords[k] = v;
      else {
        bad.push(`max_words.${k}`);
        if (d.max_words[k] !== undefined) maxWords[k] = d.max_words[k];
      }
    }
  } else {
    bad.push('max_words');
    Object.assign(maxWords, d.max_words);
  }
  for (const [k, v] of Object.entries(d.max_words)) {
    if (maxWords[k] === undefined) maxWords[k] = v;
  }
  const cfg: StyleConfig = {
    banned_phrases: phrases,
    forbid_em_dash: bool('forbid_em_dash'),
    forbid_en_dash: bool('forbid_en_dash'),
    max_exclamations: maxExcl,
    forbid_markdown: bool('forbid_markdown'),
    max_words: maxWords,
  };
  return { cfg, note: bad.length ? `style config invalid, defaults used for: ${bad.join(', ')}` : null };
}

/** Lowercase, unify curly apostrophes, collapse whitespace runs to one space. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ');
}

// Line-anchored, every pattern is linear: no nested or overlapping quantifiers.
const MARKDOWN_LINE: RegExp[] = [
  /^[ \t]*[-*•][ \t]+\S/,
  /^[ \t]*\d{1,3}\.[ \t]+\S/,
  /^#{1,6}[ \t]+\S/,
];
const MARKDOWN_INLINE: RegExp[] = [/\*\*[^*\n]{1,200}\*\*/, /__[^_\n]{1,200}__/, /`[^`\n]{1,200}`/];

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && c >= 'a' && c <= 'z';
}

/** Whole-word (letter-bounded) substring search without regex. */
function hasPhrase(lower: string, phrase: string): boolean {
  if (phrase.length === 0) return false;
  let from = 0;
  for (;;) {
    const i = lower.indexOf(phrase, from);
    if (i === -1) return false;
    if (!isWordChar(lower[i - 1]) && !isWordChar(lower[i + phrase.length])) return true;
    from = i + 1;
  }
}

function hasMarkdown(text: string): boolean {
  for (const line of text.split('\n')) {
    if (MARKDOWN_LINE.some((re) => re.test(line))) return true;
    if (MARKDOWN_INLINE.some((re) => re.test(line))) return true;
  }
  return false;
}

function countWords(text: string): number {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const space = c === 32 || (c >= 9 && c <= 13) || c === 160;
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

export function checkStyle(text: string, kind: string, cfg: StyleConfig): { ok: boolean; hits: StyleHit[] } {
  const hits: StyleHit[] = [];
  const truncated = text.length > MAX_STYLE_INPUT_CHARS;
  const body = truncated ? text.slice(0, MAX_STYLE_INPUT_CHARS) : text;
  const lower = normalizeForMatch(body);

  if (truncated) hits.push({ rule: 'too_long', detail: `input over ${MAX_STYLE_INPUT_CHARS} characters` });

  if (cfg.forbid_em_dash && /[—―]/.test(body)) hits.push({ rule: 'em_dash', detail: 'em dash found' });
  if (cfg.forbid_en_dash && body.includes('–')) hits.push({ rule: 'en_dash', detail: 'en dash found' });
  if (cfg.forbid_em_dash && /\s--\s/.test(body)) {
    hits.push({ rule: 'double_hyphen_dash', detail: 'spaced double hyphen used as a dash' });
  }

  for (const phrase of cfg.banned_phrases) {
    if (hasPhrase(lower, normalizeForMatch(phrase).trim())) hits.push({ rule: 'banned_phrase', detail: phrase });
  }

  let bangs = 0;
  for (let i = 0; i < body.length; i++) if (body[i] === '!') bangs++;
  if (bangs > cfg.max_exclamations) hits.push({ rule: 'exclamations', detail: `${bangs} exclamation marks` });

  if (cfg.forbid_markdown && hasMarkdown(body)) hits.push({ rule: 'markdown', detail: 'markdown formatting found' });

  const rawCap = cfg.max_words[kind];
  const strictest = Math.min(...Object.values(DEFAULT_STYLE_CONFIG.max_words));
  const cap = validLimit(rawCap) ? rawCap : DEFAULT_STYLE_CONFIG.max_words[kind] ?? strictest;
  if (!truncated) {
    const words = countWords(body);
    if (words > cap) hits.push({ rule: 'too_long', detail: `${words} words, cap ${cap}` });
  }
  return { ok: hits.length === 0, hits };
}
