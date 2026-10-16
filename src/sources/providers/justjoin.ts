// Adapted from career-ops-hq/career-ops providers/justjoin.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed with a cursor: GET https://justjoin.it/api/candidate-api/offers?from=<cursor>&itemsCount=100&... ->
//   { data: [{ slug, title, companyName, workplaceType, locations: [{ city }], city, publishedAt }], meta: { next: { cursor } } }.
// At most 3 pages per run. Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

const BASE = 'https://justjoin.it/api/candidate-api/offers';
const SLUG_RE = /^[A-Za-z0-9._~-]+$/;

export function jobLocation(o: any): string {
  const parts: string[] = [];
  const workplace = str(o?.workplaceType);
  if (workplace) parts.push(workplace);
  if (Array.isArray(o?.locations)) for (const l of o.locations) { const c = str(l?.city); if (c) parts.push(c); }
  const city = str(o?.city);
  if (city) parts.push(city);
  return [...new Set(parts)].join(', ');
}

export const spec: FeedSpec = {
  id: 'justjoin',
  label: 'Just Join IT',
  hosts: ['justjoin.it'],
  pageUrl(_page, prev: any) {
    const raw = prev?.meta?.next?.cursor;
    const from = Number.isFinite(Number(raw)) && raw !== undefined && raw !== null ? Number(raw) : 0;
    return `${BASE}?from=${from}&itemsCount=100&cityRadius=30&currency=pln&orderBy=descending&sortBy=publishedAt&keywordType=any&isPromoted=true`;
  },
  maxPages: 3,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !Array.isArray(doc.data)) throw new Error('unexpected API response (expected { data: [...] })');
    return doc.data;
  },
  hasMore: (doc: any, items) => items.length > 0 && doc?.meta?.next?.cursor != null && Number.isFinite(Number(doc.meta.next.cursor)),
  map(o: any) {
    if (!o || typeof o !== 'object') return null;
    const slug = str(o.slug);
    if (!SLUG_RE.test(slug)) return null;
    const location = jobLocation(o);
    return {
      title: str(o.title),
      company: str(o.companyName),
      url: `https://justjoin.it/job-offer/${slug}`,
      location,
      remote: /remote/i.test(str(o.workplaceType)),
      posted: o.publishedAt,
    };
  },
  shapeSpec: z.object({ slug: z.string(), title: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
