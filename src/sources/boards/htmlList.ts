// Small, bounded helpers for the board providers that read a vendor HTML list or an RSS feed (teamtailor, jobvite, icims, jazzhr, join,
// softgarden, avature, applitrack, neogov, pageup, eploy). Page text is untrusted: everything here is linear (indexOf scans and
// anchored regexes on a single tag), never a lazy match across the whole document, and every loop has a cap.
import { toIsoDay } from '../../db.js';
import { htmlToPlain, type TrackedCompany } from './filters.js';
import { capDescription, clip, MAX_ID_CHARS, MAX_URL_CHARS, type BoardJob } from './greenhouse.js';
import { getText, type HostPolicy } from './transport.js';

export const HTML_ACCEPT = 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5';
/** GET an HTML page through the hardened transport (https only, host policy, no redirects, size cap). */
export const getHtml = (url: string, label: string, hosts: HostPolicy): Promise<string> => getText(url, label, { hosts, accept: HTML_ACCEPT });

const MAX_TAG_CHARS = 2000;
const MAX_BLOCK_CHARS = 40_000;
const MAX_JSON_LD_CHARS = 1_000_000;

/** Plain text of an HTML fragment (tags stripped, entities decoded once, whitespace folded). */
export const plain = (s: string): string => htmlToPlain(s);

/** Value of attribute `name` in ONE opening tag string, or null. */
export function attrOf(tag: string, name: string): string | null {
  if (tag.length > MAX_TAG_CHARS) return null;
  const m = new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? '') : null;
}

export interface Anchor { href: string; inner: string; open: string; start: number; end: number }
/** The <a ...>...</a> elements of a document in order (an anchor with no closing tag ends the scan). At most `max`. */
export function anchorsOf(html: string, max = 5000): Anchor[] {
  const out: Anchor[] = [];
  const re = /<a\s/gi;
  let m: RegExpExecArray | null;
  while (out.length < max && (m = re.exec(html))) {
    const tagEnd = html.indexOf('>', m.index);
    if (tagEnd === -1) break;
    if (tagEnd - m.index > MAX_TAG_CHARS) { re.lastIndex = m.index + 2; continue; }
    const close = html.indexOf('</a>', tagEnd);
    if (close === -1) break;
    const open = html.slice(m.index, tagEnd + 1);
    out.push({ href: attrOf(open, 'href') ?? '', inner: html.slice(tagEnd + 1, close), open, start: m.index, end: close + 4 });
    re.lastIndex = close + 4;
  }
  return out;
}

/** Substrings that start at `open` (literal) and end at the next `close` (literal, kept out). Case-sensitive, at most `max`, each at most 40000 chars. */
export function blocksBetween(html: string, open: string, close: string, max = 5000): string[] {
  const out: string[] = [];
  let pos = 0;
  while (out.length < max) {
    const s = html.indexOf(open, pos);
    if (s === -1) break;
    const e = html.indexOf(close, s + open.length);
    if (e === -1) break;
    out.push(html.slice(s, Math.min(e, s + MAX_BLOCK_CHARS)));
    pos = e + close.length;
  }
  return out;
}

/** Parsed application/ld+json nodes of a page (arrays and @graph flattened). Unparseable or huge blocks are skipped. */
export function jsonLdOf(html: string): any[] {
  const out: any[] = [];
  const re = /<script\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(html)) && guard++ < 200) {
    if (!/ld\+json/i.test(m[0])) continue;
    const end = html.indexOf('</script>', re.lastIndex);
    if (end === -1) break;
    const body = html.slice(re.lastIndex, end);
    re.lastIndex = end;
    if (body.length > MAX_JSON_LD_CHARS) continue;
    let v: unknown;
    try { v = JSON.parse(body); } catch { continue; }
    const push = (x: unknown): void => {
      if (Array.isArray(x)) x.slice(0, 500).forEach(push);
      else if (x && typeof x === 'object') { out.push(x); push((x as any)['@graph']); }
    };
    push(v);
  }
  return out;
}

/** "City, Region, Country" from a schema.org address (or place) value. */
export function addressText(place: any): string {
  const a = place?.address && typeof place.address === 'object' ? place.address : place;
  const parts = ['addressLocality', 'addressRegion', 'addressCountry']
    .map((k) => (typeof a?.[k] === 'string' ? a[k].trim() : typeof a?.[k]?.name === 'string' ? a[k].name.trim() : ''))
    .filter(Boolean);
  return [...new Set(parts)].join(', ');
}

/** ISO day from "M/D/YYYY" (US order), or undefined when not a real calendar day. */
export function mdyToIso(s: string): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[3]), Number(m[1]), Number(m[2])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return toIsoDay(dt.getTime());
}

export interface JobParts {
  prefix: string; source: string; c: TrackedCompany; key: string; title: string; url: string; apply_url?: string;
  description?: string; posted?: string | undefined; locations?: string[]; remote?: boolean;
}
/** One BoardJob with the shared limits, or null (no title, no key, id or url too long). */
export function makeJob(p: JobParts): BoardJob | null {
  const title = plain(p.title);
  const id = `${p.prefix}:${p.c.slug}:${p.key}`;
  if (!title || !p.key || id.length > MAX_ID_CHARS || p.url.length > MAX_URL_CHARS) return null;
  const locations = [...new Set((p.locations ?? []).map((l) => plain(l)).filter(Boolean))].map(clip);
  return {
    id, source: p.source, title: clip(title), company: p.c.name, url: p.url, apply_url: p.apply_url ?? p.url,
    description: capDescription(p.description ? plain(p.description) : ''),
    ...(p.posted ? { posted_at: p.posted } : {}),
    locations,
    remote: p.remote ?? (/remote/i.test(title) || locations.some((l) => /remote/i.test(l))),
  };
}

/** A response-supplied URL, resolved against `base`, kept only when it is https and on exactly `host`; query and fragment dropped. */
export function sameHostUrl(candidate: string, base: string, host: string): string | null {
  try {
    const u = new URL(candidate, base);
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== host || u.username || u.password || u.port) return null;
    u.search = ''; u.hash = '';
    return u.href;
  } catch { return null; }
}
