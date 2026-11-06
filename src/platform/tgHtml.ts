// src/platform/tgHtml.ts
// Small HTML builders for code-sent Telegram notices (zero LLM). One look for every notice: a bold headline with a status emoji, then
// label/value lines, short lists and code for ids, paths and commands.
//
// Safety: every builder takes either an `Html` value (already built here) or a plain string, and a plain string is ALWAYS escaped.
// So third-party text (subjects, names, company names, reply text) can never add a tag. Free text should go through `clean()` first: it
// removes control and invisible characters, redacts secret-shaped text, and cuts to a length BEFORE escaping (so an entity is never cut).
// Plain-text fallback and chunk sending live in src/telegram/send.ts (Telegram rejecting the HTML resends the same text as plain text).
import { redactSecrets } from '../safety/redact.js';
import { attrEscape, htmlEscape, SAFE_URL, TELEGRAM_LIMIT } from '../telegram/format.js';

/** Text that is already safe Telegram HTML. Only the builders below make one; `String(h)` or `html(h)` gives the HTML text. */
export class Html {
  constructor(readonly s: string) {}
  toString(): string { return this.s; }
}
export type Part = Html | string;
type Opt = Part | null | undefined | false;

const mk = (s: string): Html => new Html(s);

/** A plain string is escaped; an Html value passes through. */
export function esc(p: Part | null | undefined): Html {
  if (p === null || p === undefined) return mk('');
  return p instanceof Html ? p : mk(htmlEscape(p));
}

/** The HTML text to hand to the sender. */
export const html = (p: Part): string => esc(p).s;

const present = (x: Opt): x is Part => x !== null && x !== undefined && x !== false && esc(x).s !== '';

export const b = (p: Part): Html => mk(`<b>${esc(p)}</b>`);
export const i = (p: Part): Html => mk(`<i>${esc(p)}</i>`);
export const code = (p: Part): Html => mk(`<code>${esc(p)}</code>`);
export const pre = (p: Part): Html => mk(`<pre>${esc(p)}</pre>`);

/** A real link when the URL is safe (https, http, mailto, tg); otherwise just the escaped label. */
export function link(label: Part, url: string | null | undefined): Html {
  const u = String(url ?? '').trim();
  if (!u || !SAFE_URL.test(u)) return esc(label);
  return mk(`<a href="${attrEscape(u)}">${esc(label)}</a>`);
}

/** Join parts with a separator (parts are escaped when plain; empty parts are dropped). */
export function join(parts: Opt[], sep: Part = ' '): Html {
  return mk(parts.filter(present).map((p) => esc(p).s).join(esc(sep).s));
}

/** `Label: value` with a bold label. An empty value gives an empty result (nothing to show). */
export function line(label: string, value: Opt): Html {
  if (!present(value)) return mk('');
  return mk(`${b(`${label}:`)} ${esc(value)}`);
}

export const bullets = (items: Opt[]): Html => mk(items.filter(present).map((x) => `• ${esc(x)}`).join('\n'));

/** A bold title and the rows under it. Empty rows are dropped; no rows at all gives an empty result. */
export function section(title: string, rows: Opt[]): Html {
  const body = rows.filter(present).map((x) => esc(x).s);
  if (!body.length) return mk('');
  return mk([b(title).s, ...body].join('\n'));
}

/** An explicit blank line between groups for `lines` (empty parts are dropped, so a spacer must be this). */
export const BLANK: Html = new Html('\n');

/** Lines joined by newline; empty parts dropped, at most one blank line in a row (use BLANK for one). */
export function lines(parts: Array<Part | null | undefined | false>): Html {
  const out = parts.filter((x): x is Part => x !== null && x !== undefined && x !== false && esc(x).s !== '').map((x) => esc(x).s).join('\n');
  return mk(out.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, ''));
}

/** Status emojis: a small fixed set so every notice reads the same way. */
export const E = { ok: '✅', warn: '⚠️', fail: '❌', paused: '⏸', you: '🔔' } as const;

/** One-line bold headline with a status emoji. */
export function headline(emoji: string, text: Part, tail?: Part): Html {
  return mk(`${htmlEscape(emoji)} ${b(text)}${tail ? ` ${esc(tail)}` : ''}`);
}

/** Third-party text for one value: one line, no control or invisible characters, secret shapes redacted, bounded. Plain (unescaped) text. */
export function clean(v: unknown, max = 80): string {
  let s = String(v ?? '')
    .replace(/[\u0000-\u001f\u007f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s) {
    try { s = redactSecrets(s); } catch { /* best effort */ }
  }
  if (s.length <= max) return s;
  const cut = Array.from(s).slice(0, Math.max(1, max - 1)).join('').trimEnd();
  return `${cut}…`;
}

/** A short excerpt of third-party text (reply text etc.): cleaned and bounded to 200 characters at most. */
export const excerpt = (v: unknown, max = 160): string => clean(v, Math.min(max, 200));

const TAG = /<\/?([a-z][a-z0-9]*)(\s[^>]*)?>/gi;

function openTags(h: string): Array<{ name: string; open: string }> {
  const stack: Array<{ name: string; open: string }> = [];
  for (const m of h.matchAll(TAG)) {
    const name = (m[1] ?? '').toLowerCase();
    if (m[0].startsWith('</')) {
      const at = stack.map((s) => s.name).lastIndexOf(name);
      if (at >= 0) stack.length = at;
    } else stack.push({ name, open: m[0] });
  }
  return stack;
}
const closer = (h: string): string => openTags(h).map((x) => `</${x.name}>`).reverse().join('');

/**
 * Cut HTML to at most `max` characters without cutting inside a tag or an entity, then close every tag still open.
 * An ellipsis is added when something was cut.
 */
export function truncateHtml(h: string, max: number): string {
  if (h.length <= max) return h;
  const tokens = h.match(/<[^>]*>|&[#a-zA-Z0-9]+;|[\s\S]/g) ?? [];
  let out = '';
  for (const t of tokens) {
    const probe = out + t;
    if (probe.length + 1 + closer(probe).length > max) break;
    out = probe;
  }
  return `${out}…${closer(out)}`;
}

/**
 * Split HTML into chunks of at most `limit` characters, cut on line boundaries. A tag that is open at a cut (a `<pre>` block, for
 * example) is closed at the end of the chunk and reopened at the start of the next. A single line that is too long is truncated.
 */
export function splitHtml(h: string, limit: number = 4000): string[] {
  const max = Math.min(Math.max(200, limit), TELEGRAM_LIMIT);
  const chunks: string[] = [];
  let cur = '';
  let n = 0;
  for (const rawLine of h.replace(/\r\n?/g, '\n').split('\n')) {
    const text = rawLine.length > max - 60 ? truncateHtml(rawLine, max - 60) : rawLine;
    const cand = n ? `${cur}\n${text}` : text;
    if (cand.length + closer(cand).length <= max) {
      cur = cand;
      n += 1;
      continue;
    }
    const open = openTags(cur);
    chunks.push(cur + closer(cur));
    cur = open.map((x) => x.open).join('') + text;
    n = 1;
  }
  if (n) chunks.push(cur + closer(cur));
  return chunks.length ? chunks : [''];
}

/** Plain text of an HTML notice (the fallback when Telegram rejects the markup): tags removed, entities decoded, links as `text (url)`. */
export function htmlToPlain(h: string): string {
  return h
    .replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, url: string, text: string) => {
      const u = url.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const t = text.replace(/<\/?[a-z][^>]*>/gi, '');
      const tt = t.replace(/&amp;/g, '&');
      return tt === u || `mailto:${tt}` === u ? t : `${t} (${u})`;
    })
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
