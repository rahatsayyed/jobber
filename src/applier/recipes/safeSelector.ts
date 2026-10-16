// Minimal CSS selector validator (plan 8G-2 task 19, ruling R2). A recipe selector is data that code may
// later hand to a page locator, so only plain id, class, attribute and tag selectors pass. Everything
// else fails closed: pseudo-classes, script-ish text, braces, angle brackets, semicolons, url(),
// expression, escapes, backticks, at-rules, long input and long lists.
// Apply-recipe selectors only. The stricter declarative-provider validator lives in src/lib/safeSelector.ts (8G-1 Task 8).
// The two grammars differ on purpose: recipes keep selectors such as input[name="urls[LinkedIn]"] taken from the old FieldMaps.

const MAX_LEN = 200;
const MAX_ALTERNATIVES = 3;   // comma list entries
const MAX_COMPOUNDS = 4;      // parts joined by a descendant or child combinator
const IDENT = '-?[A-Za-z_][A-Za-z0-9_-]{0,63}';
// Quoted attribute values keep to a conservative alphabet; brackets are fine inside the quotes.
const QUOTED = '"[A-Za-z0-9_ .:#@\\[\\]()/+=,-]{0,80}"|\'[A-Za-z0-9_ .:#@\\[\\]()/+=,-]{0,80}\'';
const ATTR = `\\[\\s*${IDENT}(?:\\s*[~|^$*]?=\\s*(?:${QUOTED}|${IDENT}))?\\s*\\]`;
const COMPOUND = `(?:(?:${IDENT}|\\*)(?:#${IDENT}|\\.${IDENT}|${ATTR})*|(?:#${IDENT}|\\.${IDENT}|${ATTR})+)`;
const COMPOUND_RE = new RegExp(`^${COMPOUND}$`);

// Words that must never appear anywhere, even inside a quoted value.
const FORBIDDEN = /javascript:|vbscript:|data:|expression\s*\(|url\s*\(|@import|<|>\s*\/|[{};`\\]|\/\*|--\s*>/i;

/** Splits on top-level separators (outside quotes and attribute brackets). */
function splitTop(sel: string, sep: (ch: string) => boolean): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  let depth = 0;
  for (const ch of sel) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === '\'') { quote = ch; cur += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') { depth--; if (depth < 0) return null; }
    if (depth === 0 && sep(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (quote || depth !== 0) return null;
  out.push(cur);
  return out;
}

function compoundOk(part: string): boolean {
  return part.length > 0 && COMPOUND_RE.test(part);
}

function alternativeOk(alt: string): boolean {
  const trimmed = alt.trim();
  if (!trimmed) return false;
  // Child combinators are written with spaces around them; normalise them to plain spaces first.
  const flat = splitTop(trimmed, (ch) => ch === '>');
  if (!flat) return false;
  let count = 0;
  for (const seg of flat) {
    const parts = splitTop(seg.trim(), (ch) => /\s/.test(ch));
    if (!parts) return false;
    for (const p of parts) {
      if (p === '') continue;
      if (!compoundOk(p)) return false;
      count++;
    }
  }
  if (flat.length > 1 && flat.some((s) => s.trim() === '')) return false;
  return count >= 1 && count <= MAX_COMPOUNDS;
}

export function isSafeSelector(sel: string): boolean {
  if (typeof sel !== 'string') return false;
  if (sel.length === 0 || sel.length > MAX_LEN) return false;
  if (sel !== sel.trim()) return false;
  if (/[\u0000-\u001f\u007f]/.test(sel)) return false;
  if (FORBIDDEN.test(sel)) return false;
  const alts = splitTop(sel, (ch) => ch === ',');
  if (!alts || alts.length > MAX_ALTERNATIVES) return false;
  return alts.every(alternativeOk);
}
