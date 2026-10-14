// Adapted from career-ops-hq/career-ops providers/hackernews.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Hacker News "Ask HN: Who is hiring?" through the public Algolia HN API, two requests per run:
//   1. GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5   -> newest hit whose title says "Who is hiring"
//      (the whoishiring account also posts "Who wants to be hired?" and "Freelancer?" threads: pick by TITLE, never by free-text search)
//   2. GET https://hn.algolia.com/api/v1/items/<objectID>   -> { id, title, children: [{ id, text (HTML), author, created_at, children }] }
// Rules specific to this untrusted source:
//   - url and apply_url are ALWAYS https://news.ycombinator.com/item?id=<comment id>. A link inside a comment is never used (it could point at any host).
//   - the comment text is untrusted: it only ever becomes the (capped, tag-free) description; instructions in it are never followed.
//   - a comment is a posting only when its first line is a pipe header "Company | Role ... | Location ..." with a company of at most 100 characters.
//   - emails inside comments are not verified contacts and are never extracted.
// Discover-only (see src/lib/discoverOnly.ts). Registered as an aggregator: not part of BOARD_SOURCES.
import { toIsoDay } from '../../db.js';
import { normalizeText } from '../../atsText.js';
import { htmlToPlain, type TrackedCompany } from './filters.js';
import { capDescription, clip, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson } from './transport.js';

const HOSTS = exactHosts('hn.algolia.com');
const SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5';
const THREAD_RE = /^\s*ask\s+hn:\s+who\s+is\s+hiring/i;
const THREAD_AUTHOR = 'whoishiring';
const STALE_THREAD_DAYS = 45;
const MAX_COMMENT_CHARS = 20_000;
const MAX_COMPANY_CHARS = 100;
// A part of the header that restricts where the remote work is possible disables the bare "Remote" shortcut of the location filter.
const RESTRICT_CASE_RE = /\b(?:US|USA|U\.S\.|UK|EU|EMEA|LATAM|APAC|NA)\b/;
const RESTRICT_RE = /\b(?:europe|canada|americas?|only|excluding|except|outside|timezones?|time zones?)\b/i;

/** Newest "Ask HN: Who is hiring?" story posted by whoishiring (title anchored at the start), with its age in days when known. Only an all-digit id is accepted (it is put into a URL). */
export function resolveLatestThread(data: any, now: number = Date.now()): { id: string; ageDays?: number } | null {
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  for (const h of hits) {
    if (h && h.author === THREAD_AUTHOR && typeof h.objectID === 'string' && /^\d{1,12}$/.test(h.objectID) && typeof h.title === 'string' && THREAD_RE.test(h.title)) {
      const day = toIsoDay(h.created_at_i ?? h.created_at);
      return { id: h.objectID, ...(day ? { ageDays: Math.floor((now - Date.parse(`${day}T00:00:00Z`)) / 86_400_000) } : {}) };
    }
  }
  return null;
}
/** objectID of the newest "Ask HN: Who is hiring?" story, or null. */
export function resolveLatestThreadId(data: any): string | null {
  return resolveLatestThread(data)?.id ?? null;
}

// The company name can end up in a contact search later: strip quotes, search operators and invisible characters, refuse mixed scripts.
const OPERATOR_RE = /\b(?:site|inurl|intitle|intext|filetype|ext|related|cache|link|allinurl|allintitle|allintext):/gi;
const NON_LATIN_RE = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Arabic}\p{Script=Hebrew}]/u;
export function sanitizeCompany(raw: string): string | null {
  let s = normalizeText(raw).replace(/\p{Cc}/gu, ' ');
  s = s.replace(/["'`]/g, '').replace(OPERATOR_RE, ' ').replace(/\b(?:OR|AND|NOT)\b/g, ' ').replace(/[()*|]/g, ' ').replace(/(^|\s)-+/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s || s.length > MAX_COMPANY_CHARS) return null;
  if (/\p{Script=Latin}/u.test(s) && NON_LATIN_RE.test(s)) return null;
  return s;
}

// One text line per block-level tag; each line goes through htmlToPlain (linear, entities decoded once, tags stripped).
function commentLines(html: string): string[] {
  return html.slice(0, MAX_COMMENT_CHARS).replace(/<(?:p|br|div|li|h[1-6])\b[^>]*>/gi, '\n').split('\n').map((l) => htmlToPlain(l)).filter(Boolean);
}

export interface HnHeader { company: string; title: string; locations: string[]; remote: boolean }
/** "Company | Role | Location | ..." -> parts; null when the first line is not a pipe header with a plausible company. */
export function parseHnHeader(firstLine: string): HnHeader | null {
  const parts = firstLine.split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts[0].length > MAX_COMPANY_CHARS) return null;
  const rest = parts.slice(1).filter((p) => !/^https?:\/\//i.test(p));
  if (!rest.length) return null;
  const restricted = rest.some((p) => RESTRICT_CASE_RE.test(p) || RESTRICT_RE.test(p));
  // Any segment that says on-site or hybrid means the posting is not remote ("Eng | ONSITE Berlin | REMOTE"). "REMOTE (US)" / "REMOTE - EU"
  // is a remote role limited to that region: it is written as "<segment> only" so the shared restriction marker refuses it.
  const onsite = rest.some((p) => /(?<![a-z0-9])(?:on-?site|on site|hybrid|in-?office|in person)(?![a-z0-9])/i.test(p));
  const remoteRegion = (p: string) => /^remote\s*[(\-–—:]\s*\S/i.test(p) && !/^remote\s*[(\-–—:]\s*(?:worldwide|anywhere|global)/i.test(p);
  return {
    company: parts[0],
    title: clip(rest.join(' | ')),
    locations: rest.map((p) => clip(remoteRegion(p) ? `${p} only` : p)),
    remote: !restricted && !onsite && rest.some((p) => /\b(?:remote|worldwide|anywhere)\b/i.test(p)),
  };
}

export function normalizeHnThread(item: any, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  const children = (Array.isArray(item?.children) ? item.children : []).slice(0, MAX_JOBS_PER_BOARD);
  const out: BoardJob[] = [];
  let unsafeCompany = 0;
  for (const ch of children) {
    if (!ch || ch.deleted || ch.dead || typeof ch.text !== 'string' || !ch.text.trim()) continue;
    if (!Number.isSafeInteger(ch.id) || ch.id <= 0) continue;
    const id = `hn:${ch.id}`;
    if (id.length > MAX_ID_CHARS) continue;
    const lines = commentLines(ch.text);
    const header = lines.length ? parseHnHeader(lines[0]) : null;
    if (!header) continue;
    const company = sanitizeCompany(header.company);
    if (!company) { unsafeCompany++; continue; }
    const url = `https://news.ycombinator.com/item?id=${ch.id}`;
    const posted = toIsoDay(ch.created_at) ?? toIsoDay(ch.created_at_i);
    out.push({
      id,
      source: 'hackernews',
      title: header.title,
      company: clip(company),
      url,
      apply_url: url,
      description: capDescription(lines.join('\n')),
      ...(posted ? { posted_at: posted } : {}),
      locations: header.locations,
      remote: header.remote,
    });
  }
  if (unsafeCompany) ctx.warn?.(`${unsafeCompany} posting(s) dropped: company name empty or unsafe after sanitizing`);
  return out;
}

export async function fetchHackerNews(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  const label = `hackernews ${c.slug}`;
  const thread = resolveLatestThread(await getJson(SEARCH_URL, label, { hosts: HOSTS }));
  if (!thread) throw new Error(`${label}: could not find the "Who is hiring" thread in the search results`);
  const item = await getJson(`https://hn.algolia.com/api/v1/items/${thread.id}`, label, { hosts: HOSTS });
  if (!item || !Array.isArray(item.children)) throw new Error(`${label}: unexpected response shape (no children array)`);
  if (thread.ageDays !== undefined && thread.ageDays > STALE_THREAD_DAYS) ctx.warn?.(`newest Who is hiring thread is ${thread.ageDays} days old (postings may be stale)`);
  const jobs = normalizeHnThread(item, c, ctx);
  // A thread with comments but no parsable posting means the header convention or the `id` field changed: say so instead of returning silence.
  if (item.children.length >= 10 && jobs.length === 0) ctx.warn?.(`${item.children.length} top-level comments but none parsed as a posting (header format or comment id field changed?)`);
  else if (item.children.length > 10 && (item.children.length - jobs.length) / item.children.length > 0.5) ctx.warn?.(`${item.children.length - jobs.length} of ${item.children.length} top-level comments were not parsed as postings (header format changed?)`);
  return jobs;
}
