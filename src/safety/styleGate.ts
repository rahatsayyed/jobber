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

function parseConfig(raw: unknown, path: string): StyleConfig {
  const r = raw as Partial<StyleConfig> | null;
  const ok =
    typeof r === 'object' &&
    r !== null &&
    Array.isArray(r.banned_phrases) &&
    r.banned_phrases.every((p) => typeof p === 'string') &&
    typeof r.forbid_em_dash === 'boolean' &&
    typeof r.forbid_en_dash === 'boolean' &&
    typeof r.max_exclamations === 'number' &&
    typeof r.forbid_markdown === 'boolean' &&
    typeof r.max_words === 'object' &&
    r.max_words !== null &&
    Object.values(r.max_words).every((n) => typeof n === 'number');
  if (!ok) throw new Error(`${path} is not a valid style config`);
  return r as StyleConfig;
}

export function loadStyleConfig(path: string): StyleConfig {
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')), path);
}

/** Never throws: on a missing or invalid file, returns built-in defaults plus a note to surface. */
export function loadStyleConfigSafe(path: string): { cfg: StyleConfig; note: string | null } {
  try {
    return { cfg: loadStyleConfig(path), note: null };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { cfg: DEFAULT_STYLE_CONFIG, note: `style config invalid, using built-in defaults: ${why}` };
  }
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
  const lower = body.toLowerCase();

  if (truncated) hits.push({ rule: 'too_long', detail: `input over ${MAX_STYLE_INPUT_CHARS} characters` });

  if (cfg.forbid_em_dash && /[—―]/.test(body)) hits.push({ rule: 'em_dash', detail: 'em dash found' });
  if (cfg.forbid_en_dash && body.includes('–')) hits.push({ rule: 'en_dash', detail: 'en dash found' });
  if (cfg.forbid_em_dash && /\s--\s/.test(body)) {
    hits.push({ rule: 'double_hyphen_dash', detail: 'spaced double hyphen used as a dash' });
  }

  for (const phrase of cfg.banned_phrases) {
    if (hasPhrase(lower, phrase.toLowerCase())) hits.push({ rule: 'banned_phrase', detail: phrase });
  }

  let bangs = 0;
  for (let i = 0; i < body.length; i++) if (body[i] === '!') bangs++;
  if (bangs > cfg.max_exclamations) hits.push({ rule: 'exclamations', detail: `${bangs} exclamation marks` });

  if (cfg.forbid_markdown && hasMarkdown(body)) hits.push({ rule: 'markdown', detail: 'markdown formatting found' });

  const cap = cfg.max_words[kind];
  if (cap !== undefined && !truncated) {
    const words = countWords(body);
    if (words > cap) hits.push({ rule: 'too_long', detail: `${words} words, cap ${cap}` });
  }
  return { ok: hits.length === 0, hits };
}
