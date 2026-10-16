// Shared engine for the imported board-wide feeds (plan 8G task 9). One imported source is a small declarative FeedSpec:
// which hosts it may call, how to build page URLs, how to read raw items and how to map one item to a posting.
// Everything else is common and fail-closed: https and an allowed host only (transport.ts), no redirects, size caps,
// posting URLs must sit on the feed's own host(s), ids are hashes of the URL, text is clipped, the description starts
// with the same "Location:" line fetchBoards adds, and raw items are handed to the runner for the shape check.
// These sources are DISCOVER-ONLY for apply (src/lib/discoverOnly.ts) and ship disabled in config/platforms.json.
import { z } from 'zod';
import { toIsoDay, type Job } from '../../db.js';
import { hostMatches } from '../../lib/hostClass.js';
import { locationLine } from '../boards/index.js';
import { htmlToPlain } from '../boards/filters.js';
import { capDescription, clip, MAX_JOBS_PER_BOARD, MAX_URL_CHARS } from '../boards/greenhouse.js';
import { apexHosts, getJson, getText } from '../boards/transport.js';
import { hasPlainAuthority, shortHash } from '../boards/util.js';
import { childOf, childrenOf, parseXml, textOf } from '../boards/xml.js';
import type { Provider } from '../provider.js';

export const SAMPLE_ITEMS = 5;
/** Kept postings per feed after the role filter. */
export const MAX_KEPT = 200;

export interface FeedPosting {
  title: string;
  /** Company name; falls back to the feed's label when the item has none. */
  company?: string;
  /** Posting page. Must be https on one of the spec's hosts, otherwise the posting is dropped. */
  url: string;
  location?: string;
  remote?: boolean;
  /** Plain or HTML text from the feed; absent for listing-only feeds. */
  description?: string;
  /** Epoch seconds or milliseconds, or a date string; anything unreadable is ignored. */
  posted?: unknown;
}

export interface FeedSpec {
  id: string;
  label: string;
  /** Apex domains the feed may be requested from AND posting URLs may point to. */
  hosts: string[];
  /** URL of page `page` (1-based); `prev` is the previous response document (cursor-style feeds). */
  pageUrl(page: number, prev?: unknown): string;
  maxPages: number;
  format: 'json' | 'rss';
  /** Raw items of one response (json: the parsed document; rss: the plain item objects from rssItems). Throw on a wrong envelope. */
  itemsOf(page: unknown): unknown[];
  /** json only: true when another page follows. */
  hasMore?(page: unknown, items: unknown[], pageNo: number): boolean;
  map(item: any): FeedPosting | null;
  /** What one raw item must look like (required keys and types, extra keys allowed). */
  shapeSpec: z.ZodTypeAny;
}

/** Epoch ms from epoch seconds, epoch ms or a parseable date string. */
export function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v.trim());
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Plain objects, one per RSS <item>, keyed by child element name (text only). Throws when there is no rss channel. */
export function rssItems(xml: string): Record<string, string>[] {
  const channel = childOf(childOf(parseXml(xml), 'rss'), 'channel');
  if (!channel) throw new Error('unexpected response shape (no rss channel)');
  return childrenOf(channel, 'item').slice(0, MAX_JOBS_PER_BOARD).map((it) => {
    const o: Record<string, string> = {};
    for (const c of it.children) if (!(c.name in o)) o[c.name] = textOf(it, c.name);
    return o;
  });
}

const STOP = new Set(['and', 'the', 'for', 'with', 'job', 'jobs']);
/** Lower-case words of the configured role that a title can match on. Empty role means keep everything. */
export function roleTokens(role: string | undefined): string[] {
  return [...new Set(String(role ?? '').toLowerCase().split(/[^a-z0-9.+#]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
}
export const titleMatchesRole = (title: string, tokens: string[]): boolean => !tokens.length || tokens.some((t) => title.toLowerCase().includes(t));

const LISTING_ONLY = 'Listing only: this feed carries no job description. Open the URL for the posting.';

function urlOk(u: string, hosts: string[]): boolean {
  return u.length > 0 && u.length <= MAX_URL_CHARS && hasPlainAuthority(u) && hosts.some((h) => hostMatches(u, h));
}

export function toJob(spec: FeedSpec, p: FeedPosting): Job | null {
  const title = clip(str(p.title));
  const url = str(p.url);
  if (!title || !urlOk(url, spec.hosts)) return null;
  const ms = toMs(p.posted);
  const posted = ms === undefined ? undefined : toIsoDay(ms);
  const body = p.description ? capDescription(htmlToPlain(p.description)) : '';
  const locs = str(p.location) ? [str(p.location)] : [];
  return {
    id: `${spec.id}:${shortHash(url, 16)}`,
    source: spec.id,
    title,
    company: clip(str(p.company) || spec.label),
    url,
    apply_url: url,
    description: capDescription(`${locationLine(locs, p.remote)}${body || LISTING_ONLY}`),
    ...(posted ? { posted_at: posted } : {}),
  };
}

export function mapItems(spec: FeedSpec, items: unknown[], tokens: string[] = []): Job[] {
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const it of items) {
    let p: FeedPosting | null = null;
    try { p = spec.map(it); } catch { p = null; }
    if (!p || !titleMatchesRole(str(p.title), tokens)) continue;
    const j = toJob(spec, p);
    if (!j || seen.has(j.id)) continue;
    seen.add(j.id);
    out.push(j);
    if (out.length >= MAX_KEPT) break;
  }
  return out;
}

export function makeFeedProvider(spec: FeedSpec): Provider {
  const hosts = apexHosts(...spec.hosts);
  return {
    id: spec.id,
    shapeSpec: spec.shapeSpec,
    async fetch(ctx) {
      const label = spec.id;
      const raw: unknown[] = [];
      let prev: unknown;
      for (let page = 1; page <= spec.maxPages; page++) {
        if (ctx.deadlineAt !== undefined && Date.now() >= ctx.deadlineAt) { ctx.warn?.(`${label}: stopped at page ${page - 1}, time budget used`); break; }
        const url = spec.pageUrl(page, prev);
        let items: unknown[];
        let doc: unknown;
        try {
          if (spec.format === 'json') {
            doc = await getJson(url, label, { hosts });
            items = spec.itemsOf(doc);
          } else {
            items = spec.itemsOf(rssItems(await getText(url, label, { hosts })));
            doc = items;
          }
        } catch (e) {
          if (page === 1) throw e instanceof Error && e.message.startsWith(label) ? e : new Error(`${label}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
          ctx.warn?.(`${label}: page ${page} failed, kept the earlier pages`);
          break;
        }
        prev = doc;
        raw.push(...items);
        if (raw.length >= MAX_JOBS_PER_BOARD) break;
        if (spec.format === 'rss' || !spec.hasMore || !spec.hasMore(doc, items, page)) break;
      }
      const jobs = mapItems(spec, raw, roleTokens(ctx.params?.role));
      return { jobs, sample: raw.slice(0, SAMPLE_ITEMS) };
    },
  };
}
