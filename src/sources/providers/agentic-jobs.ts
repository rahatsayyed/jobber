// Adapted from career-ops-hq/career-ops providers/agentic-jobs.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed: GET https://agentic-engineering-jobs.com/api/v1/jobs?page=N (1-based, 50 per page) -> { data: [{ title, companyName, slug, location, countries, geoRegion, description, postedAt }], meta: { total, per_page } }.
// The posting URL is built as /jobs/{slug} on the site origin, never taken from the payload.
// Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

const ORIGIN = 'https://agentic-engineering-jobs.com';
const PER_PAGE = 50;

export const spec: FeedSpec = {
  id: 'agentic-jobs',
  label: 'Agentic Engineering Jobs',
  hosts: ['agentic-engineering-jobs.com'],
  pageUrl: (page) => `${ORIGIN}/api/v1/jobs?page=${page}`,
  maxPages: 3,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !Array.isArray(doc.data)) throw new Error('unexpected API response (expected { data: [...] })');
    return doc.data;
  },
  hasMore: (_doc, items) => items.length >= PER_PAGE,
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    const slug = str(j.slug);
    if (!slug || !/^[A-Za-z0-9._~-]+$/.test(slug) || slug.includes('..')) return null;
    const countries = Array.isArray(j.countries) ? j.countries.filter((c: unknown) => typeof c === 'string').join(', ') : str(j.countries);
    return {
      title: str(j.title),
      company: str(j.companyName),
      url: `${ORIGIN}/jobs/${slug}`,
      location: str(j.location) || countries || str(j.geoRegion),
      description: str(j.description),
      posted: j.postedAt,
    };
  },
  shapeSpec: z.object({ title: z.string(), slug: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
