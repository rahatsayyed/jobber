// src/safety/redact.ts
// Secret redaction shared by the web server and the dashboard text cleaner. Pure, no I/O.
import { SECRET_SHAPES } from './outputGate.js';
import { siteAccountLiterals } from './siteSecrets.js';

const REDACTED = '[redacted]';
// Lines naming a web credential variable (token or secret) are dropped whole.
const WEB_SECRET_LINE = /WEB_(?:[A-Z_]*_)?(?:TOKEN|SECRET)/;

/** Replace secret shapes (shared with the outbound gate) and any web-secret line; `extra` literals are also masked. */
export function redactSecrets(text: string, extra: string[] = [], opts: { tokenLines?: boolean } = {}): string {
  // Matching runs over the whole text with line breaks removed, so a secret wrapped across lines is still found.
  const map: number[] = []; // stripped index -> original index
  let stripped = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n' || text[i] === '\r') continue;
    map.push(i);
    stripped += text[i];
  }
  const ranges: [number, number][] = []; // original [start, endExclusive)
  const add = (s: number, e: number) => ranges.push([map[s], map[e - 1] + 1]);
  for (const re of SECRET_SHAPES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of stripped.matchAll(g)) if (m[0].length > 0) add(m.index, m.index + m[0].length);
    // also per line: joining lines can destroy a word boundary that a secret needs at its start
    let off = 0;
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(g)) {
        if (m[0].length > 0) ranges.push([off + m.index, off + m.index + m[0].length]);
      }
      off += line.length + 1;
    }
  }
  // Site account emails and passwords are literal secrets (plan 8G task 6).
  const site = siteAccountLiterals();
  for (const lit of [...extra, ...site.passwords, ...site.emails]) {
    if (lit.length < 8) continue;
    for (let i = stripped.indexOf(lit); i >= 0; i = stripped.indexOf(lit, i + lit.length)) add(i, i + lit.length);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  let out = '';
  let pos = 0;
  for (const [s, e] of ranges) {
    if (e <= pos) continue;
    const start = Math.max(s, pos);
    out += text.slice(pos, start) + REDACTED;
    out += text.slice(start, e).replace(/[^\n]/g, ''); // keep line breaks so the line count is stable
    pos = e;
  }
  out += text.slice(pos);
  return out
    .split('\n')
    .map((l) => (opts.tokenLines !== false && WEB_SECRET_LINE.test(l) ? REDACTED : l))
    .join('\n');
}
