// file: src/atsText.ts
// ATS-safe text normalization, shared by the fact gate and the renderer so the gate always checks exactly the text
// that is rendered or sent. Pure, no I/O.

// Cf: soft hyphen, zero-width chars, bidi controls, word joiners, BOM, ... Plus invisible non-Cf characters: combining grapheme
// joiner U+034F, Hangul fillers U+115F/1160/3164/FFA0, braille blank U+2800, Mongolian vowel separator U+180E, Khmer inherent
// vowels U+17B4/17B5, and the variation selectors U+FE00-FE0F and U+E0100-E01EF.
const FORMAT_CHARS = /[\p{Cf}͏ᅟᅠㅤﾠ⠀᠎឴឵︀-️\u{E0100}-\u{E01EF}]/gu;

/** ATS-safe text: some importers drop non-ASCII dashes in date ranges (ai-job-search verify_pdf origin story).
 *  Invisible format characters are stripped so "Kuber​netes" cannot slip past the fact gate and render as "Kubernetes". */
export function normalizeText(s: string): string {
  return s
    .replace(FORMAT_CHARS, '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/\s*→\s*/g, ' to ');
}

const NON_LATIN_SCRIPTS: Array<[string, RegExp]> = [
  ['Cyrillic', /\p{Script=Cyrillic}/u], ['Greek', /\p{Script=Greek}/u], ['Armenian', /\p{Script=Armenian}/u],
  ['Georgian', /\p{Script=Georgian}/u], ['Hangul', /\p{Script=Hangul}/u], ['Hiragana', /\p{Script=Hiragana}/u],
  ['Katakana', /\p{Script=Katakana}/u], ['Han', /\p{Script=Han}/u], ['Arabic', /\p{Script=Arabic}/u], ['Hebrew', /\p{Script=Hebrew}/u],
];
const LATIN = /\p{Script=Latin}/u;
const LETTER_RUN = /[\p{L}\p{M}]+/gu; // digits, apostrophes, hyphens and dots end a word

/** Words (maximal letter runs) that mix Latin letters with letters of another script: the homoglyph bypass ("wrоte").
 *  A word wholly in one script (Cyrillic, Han, Hebrew, ...) or Latin with diacritics is fine. Call on normalized text. */
export function mixedScriptWords(text: string): Array<{ word: string; scripts: string[] }> {
  const out: Array<{ word: string; scripts: string[] }> = [];
  for (const m of text.matchAll(LETTER_RUN)) {
    const chars = [...m[0]];
    if (!chars.some((c) => LATIN.test(c))) continue;
    const scripts = NON_LATIN_SCRIPTS.filter(([, re]) => chars.some((c) => re.test(c))).map(([n]) => n);
    if (scripts.length) out.push({ word: m[0], scripts });
  }
  return out;
}

/** normalizeText applied to every string in a JSON value (returns a new value; the input is not mutated). */
export function normalizeForAts<T>(v: T): T {
  const walk = (x: any): any => (typeof x === 'string' ? normalizeText(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)])) : x);
  return walk(v);
}
