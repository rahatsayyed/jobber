// Cold-email and follow-up HTML part, built in code from the stored text. The model never writes HTML: it may only wrap at most
// MAX_MARKERS short phrases in **...**. The plain part is the same text with the markers removed (that is the text the fact gate saw);
// the HTML part escapes everything, turns markers into <strong>, makes the owner's own links clickable and keeps "- " lines as a list.
import { existsSync, readFileSync } from 'node:fs';
import { userDataPath } from './lib/userData.js';

export const MAX_MARKERS = 3;
const MARK = /\*\*([^*\n]{1,80})\*\*/g;
const OPEN = '\u0001';
const CLOSE = '\u0002';

export interface EmailLink { url: string; key: string; label: string; host: string; handle: string }
export interface EmailParts { plain: string; html: string }

export function stripMarkers(text: string): string {
  return String(text ?? '').replace(/[\u0001\u0002]/g, '').replace(MARK, '$1').replace(/\*\*/g, '');
}

/** Lowercase, no scheme, no leading @ or www., no trailing slash or sentence punctuation. */
function ref(s: string): string {
  return s.trim().replace(/^@/, '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[.,;:)]+$/, '').replace(/\/+$/, '').toLowerCase();
}

/** The owner's own links from the base resume (website and social entries with an https URL). Nothing else is ever linked. */
export function linksFromResume(base: Record<string, any> | null | undefined): EmailLink[] {
  const out: EmailLink[] = [];
  const add = (e: unknown): void => {
    const o = e as { url?: unknown; label?: unknown } | null;
    if (!o || typeof o.url !== 'string' || !/^https:\/\//i.test(o.url)) return;
    let u: URL;
    try { u = new URL(o.url); } catch { return; }
    const key = ref(o.url);
    out.push({ url: o.url, key, label: typeof o.label === 'string' ? ref(o.label) : key, host: u.hostname.replace(/^www\./, '').toLowerCase(), handle: u.pathname.split('/').filter(Boolean).pop()?.toLowerCase() ?? '' });
  };
  add(base?.website);
  for (const v of Object.values((base?.social ?? {}) as Record<string, unknown>)) add(v);
  return out;
}

export function loadEmailLinks(): EmailLink[] {
  try {
    const p = userDataPath('resume.json');
    return existsSync(p) ? linksFromResume(JSON.parse(readFileSync(p, 'utf8'))) : [];
  } catch { return []; }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const a = (url: string, text: string): string => `<a href="${esc(url)}" style="text-decoration:underline">${esc(text)}</a>`;

const FOOTER = /^(Portfolio|Website|GitHub|LinkedIn|Resume|CV):[ \t]*(\S+)[ \t]*$/i;
const PLATFORM_HOST: Record<string, string> = { github: 'github.com', linkedin: 'linkedin.com' };
const TOKEN = /(?<![@\w/.-])(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s<>"')]*)?/gi;

function linkFor(value: string, label: string, links: EmailLink[]): EmailLink | undefined {
  const r = ref(value);
  const exact = links.find((l) => l.key === r || l.label === r);
  if (exact) return exact;
  const host = PLATFORM_HOST[label.toLowerCase()];
  if (host && /^@?[\w.-]+$/.test(value.trim())) return links.find((l) => l.host === host && l.handle === r && l.handle !== '');
  return undefined;
}

function linkify(text: string, links: EmailLink[]): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const hit = links.find((l) => l.key === ref(m[0]));
    if (!hit) continue;
    const trimmed = m[0].replace(/[.,;:)]+$/, '');
    out += esc(text.slice(last, m.index)) + a(hit.url, trimmed);
    last = (m.index ?? 0) + trimmed.length;
  }
  return out + esc(text.slice(last));
}

function inline(line: string, links: EmailLink[]): string {
  return line.split(OPEN).map((chunk, i) => {
    if (i === 0) return linkify(chunk, links);
    const [bold, ...rest] = chunk.split(CLOSE);
    return `<strong>${linkify(bold, links)}</strong>${linkify(rest.join(CLOSE), links)}`;
  }).join('');
}

function renderLine(line: string, links: EmailLink[]): string {
  const f = FOOTER.exec(line.replace(/[\u0001\u0002]/g, ''));
  if (f) {
    const hit = linkFor(f[2], f[1], links);
    if (hit) return `${esc(f[1])}: ${a(hit.url, f[2])}`;
  }
  return inline(line, links);
}

/** Plain part (markers removed) and HTML part (escaped, at most MAX_MARKERS <strong>, allowlisted links only, no images or remote resources). */
export function buildEmailParts(text: string, links: EmailLink[]): EmailParts {
  const plain = stripMarkers(text);
  let n = 0;
  const marked = String(text ?? '').replace(/[\u0001\u0002]/g, '').replace(MARK, (_m, c: string) => (++n <= MAX_MARKERS ? `${OPEN}${c}${CLOSE}` : c)).replace(/\*\*/g, '');
  const blocks = marked.replace(/\r\n/g, '\n').trim().split(/\n[ \t]*\n/).filter((b) => b.trim());
  const html = blocks.map((b) => {
    const lines = b.split('\n').map((l) => l.replace(/\s+$/, ''));
    if (lines.length > 0 && lines.every((l) => /^- /.test(l))) {
      return `<ul style="margin:0 0 12px;padding-left:20px">${lines.map((l) => `<li>${renderLine(l.slice(2), links)}</li>`).join('')}</ul>`;
    }
    return `<p style="margin:0 0 12px">${lines.map((l) => renderLine(l, links)).join('<br>')}</p>`;
  }).join('');
  return { plain, html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${html}</div>` };
}
