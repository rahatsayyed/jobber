// file: src/htmlText.ts
// Shared markup stripping for the language gate, quote checks and the liveness snapshot.
const BLOCK_TAGS = /<\/?(?:p|div|li|ul|ol|br|h[1-6]|tr|td|section|article|header|footer|main|table|blockquote|hr)\b[^>]*>/gi;

function decodeNumeric(_m: string, body: string): string {
  const cp = body[0] === 'x' || body[0] === 'X' ? parseInt(body.slice(1), 16) : parseInt(body, 10);
  return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : _m;
}

/** Markup stripped; block-level tags become newlines so callers can split on list items and breaks. */
export function htmlToLines(html: string): string {
  const s = String(html ?? '');
  const looksLikeHtml = /<\/?[a-z!][^>]*>|&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s);
  if (!looksLikeHtml) return s.replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
  return s
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<\/?[a-z!][^>]*>/gi, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, decodeNumeric)
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&[lr]squo;/g, "'").replace(/&[lr]dquo;/g, '"').replace(/&hellip;/g, '...')
    .replace(/&amp;/g, '&')
    .replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n')
    .trim();
}

/** Same as htmlToLines with all whitespace collapsed to single spaces. */
export function htmlToText(html: string): string {
  return htmlToLines(html).replace(/\s+/g, ' ').trim();
}
