// src/telegram/format.ts
// Markdown -> Telegram HTML, in code. Every piece of text is HTML-escaped FIRST; only tags this converter writes
// itself reach the output, so third-party text (job text, sender names, subjects) can never inject markup.
// Supported: bold, italic, inline code, code blocks, links, bullet and numbered lists, headings (as bold), blockquotes.
// Raw HTML typed in the input is shown literally (escaped), never passed through.

export const TELEGRAM_LIMIT = 4096;
const DEFAULT_CHUNK = 4000;
// A raw line longer than this is cut at a space before conversion, so one escaped line stays far below the limit.
const MAX_RAW_LINE = 700;

/** Escape the three characters Telegram HTML cares about. Call this on any third-party text sent without format conversion. */
export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const attrEscape = (s: string): string => htmlEscape(s).replace(/"/g, '&quot;');

const SAFE_URL = /^(https?:\/\/|mailto:|tg:\/\/)[^\s<>"]+$/i;

function inline(raw: string): string {
  const codes: string[] = [];
  // 1. Inline code first, so its content is never touched by the other rules.
  let s = raw.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(`<code>${htmlEscape(c)}</code>`);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  // 2. Links: the text and the url are taken out before escaping and put back as one anchor.
  const links: string[] = [];
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    if (!SAFE_URL.test(url)) return m; // an unsafe url stays literal text
    links.push(`<a href="${attrEscape(url)}">${inlineEmphasis(htmlEscape(text))}</a>`);
    return `\u0000L${links.length - 1}\u0000`;
  });
  // 3. Escape, then emphasis.
  s = inlineEmphasis(htmlEscape(s));
  return s
    .replace(/\u0000L(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? '')
    .replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
}

// Works on already escaped text. Bold before italic; underscores only count at word edges (snake_case stays plain).
function inlineEmphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?![\w])/g, '$1<b>$2</b>')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![\w*])/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?=[^\s_])([^\n_]*?[^\s_])_(?![\w])/g, '$1<i>$2</i>');
}

type Wrap = 'none' | 'pre' | 'quote';
interface Segment { wrap: Wrap; lines: string[] }

function render(wrap: Wrap, lines: string[]): string {
  const body = lines.join('\n');
  if (wrap === 'pre') return `<pre>${body}</pre>`;
  if (wrap === 'quote') return `<blockquote>${body}</blockquote>`;
  return body;
}

function splitLongRaw(line: string): string[] {
  if (line.length <= MAX_RAW_LINE) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > MAX_RAW_LINE) {
    let cut = rest.lastIndexOf(' ', MAX_RAW_LINE);
    if (cut < MAX_RAW_LINE / 2) cut = MAX_RAW_LINE;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  if (rest) out.push(rest);
  return out;
}

function toSegments(markdown: string): Segment[] {
  const segs: Segment[] = [];
  const push = (wrap: Wrap, line: string): void => {
    const last = segs[segs.length - 1];
    if (last && last.wrap === wrap) last.lines.push(line);
    else segs.push({ wrap, lines: [line] });
  };
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      // Code lines: escaped, never converted; long lines are cut so a chunk can always hold one.
      const esc = splitLongRaw(line).map(htmlEscape);
      for (const e of esc) push('pre', e);
      continue;
    }
    for (const part of splitLongRaw(line)) {
      const q = /^\s{0,3}>\s?(.*)$/.exec(part);
      if (q) {
        push('quote', inline(q[1] ?? ''));
        continue;
      }
      const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(part);
      if (h) {
        push('none', `<b>${inline(h[1] ?? '').replace(/<\/?b>/g, '')}</b>`);
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(part)) {
        push('none', '');
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(part)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(part)) continue; // table separator row
        const cells = part.trim().slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean);
        push('none', inline(cells.join(' | ')));
        continue;
      }
      const li = /^(\s*)[-*+]\s+(.*)$/.exec(part);
      if (li) {
        push('none', `${li[1] ?? ''}- ${inline(li[2] ?? '')}`);
        continue;
      }
      push('none', inline(part));
    }
  }
  return segs;
}

/**
 * Convert markdown to Telegram HTML chunks, each at most `limit` characters, cut on line boundaries. Every chunk
 * has balanced tags: a code block or quote that has to be split is closed and reopened in the next chunk.
 */
export function markdownToHtmlChunks(markdown: string, limit: number = DEFAULT_CHUNK): string[] {
  const max = Math.min(Math.max(200, limit), TELEGRAM_LIMIT);
  const chunks: string[] = [];
  let cur = '';
  const emit = (): void => {
    const t = cur.replace(/^\n+|\n+$/g, '');
    if (t) chunks.push(t);
    cur = '';
  };
  for (const seg of toSegments(markdown)) {
    let pending: string[] = [];
    const place = (): void => {
      if (!pending.length) return;
      cur += (cur ? '\n' : '') + render(seg.wrap, pending);
      pending = [];
    };
    for (const line of seg.lines) {
      const withLine = render(seg.wrap, [...pending, line]);
      if ((cur ? cur.length + 1 : 0) + withLine.length <= max) {
        pending.push(line);
        continue;
      }
      place();
      if (cur) emit();
      pending = [line];
      // A single line that alone does not fit cannot happen after splitLongRaw; guard anyway by hard truncation.
      if (render(seg.wrap, pending).length > max) pending = [line.slice(0, Math.max(0, max - 40))];
    }
    place();
  }
  emit();
  return chunks.length ? chunks : [''];
}

export function markdownToHtml(markdown: string): string {
  return markdownToHtmlChunks(markdown, TELEGRAM_LIMIT).join('\n');
}

/** Plain-text chunks for the fallback when Telegram rejects the HTML. No markup at all. */
export function plainChunks(text: string, limit: number = DEFAULT_CHUNK): string[] {
  const max = Math.min(Math.max(200, limit), TELEGRAM_LIMIT);
  const out: string[] = [];
  let cur = '';
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    for (const part of splitLongRaw(line)) {
      if ((cur ? cur.length + 1 : 0) + part.length > max) {
        if (cur) out.push(cur);
        cur = part;
      } else cur = cur ? `${cur}\n${part}` : part;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/** True when a Telegram error description is an HTML entity parse error (the cue for the plain-text fallback). */
export function isParseError(description: string | undefined): boolean {
  return /can't parse entities|can.t find end of the entity|unsupported start tag|unexpected end tag/i.test(description ?? '');
}
