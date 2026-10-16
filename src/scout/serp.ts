// SERP parsing for the dork engine (plan 8G task 7). The page script only reports raw anchors; picking
// results, unwrapping redirects and detecting blocks is code. Result text is untrusted.
import { detectBlock, type BlockKind } from '../webcore/blocks.js';
import type { RawAnchorPage } from './page.js';
import type { SearchResult } from '../search/index.js';

export interface EngineDef { id: 'google' | 'duckduckgo' | 'bing'; host: string; url(q: string): string }
export const ENGINES: readonly EngineDef[] = [
  { id: 'google', host: 'google.com', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&hl=en` },
  { id: 'duckduckgo', host: 'duckduckgo.com', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` },
  { id: 'bing', host: 'bing.com', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
];

const ENGINE_HOST = /(^|\.)(google|bing|duckduckgo|gstatic|googleusercontent|microsoft|msn)\.[a-z.]+$/i;
const MAX_RESULTS = 10;

/** Unwraps the engines' redirect links (google /url?q=, duckduckgo /l/?uddg=); returns null for anything not http(s). */
export function unwrapResultUrl(href: string): string | null {
  let u: URL;
  try { u = new URL(href, 'https://www.google.com/'); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname === '/url') {
    const t = u.searchParams.get('q') ?? u.searchParams.get('url');
    return t ? unwrapResultUrl(t) : null;
  }
  if (/(^|\.)duckduckgo\.com$/.test(host) && u.pathname.startsWith('/l/')) {
    const t = u.searchParams.get('uddg');
    return t ? unwrapResultUrl(t) : null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (ENGINE_HOST.test(host)) return null;
  u.hash = '';
  return u.toString();
}

export type SerpOutcome = { blocked: true; block: BlockKind } | { blocked: false; results: SearchResult[] };

export function parseSerp(raw: RawAnchorPage): SerpOutcome {
  const block = detectBlock({
    url: raw.url, title: raw.title ?? '', text: raw.text ?? '', fields: [], controls: [], notices: [], captchaWidget: raw.captchaWidget,
  });
  if (block) return { blocked: true, block };
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const a of raw.anchors ?? []) {
    const url = unwrapResultUrl(a.href);
    if (!url || seen.has(url)) continue;
    const title = (a.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (title.length < 3) continue;
    seen.add(url);
    const snippet = (a.context ?? '').replace(title, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    results.push({ title, snippet, url });
    if (results.length >= MAX_RESULTS) break;
  }
  return { blocked: false, results };
}
