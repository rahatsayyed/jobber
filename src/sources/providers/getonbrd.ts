// Adapted from career-ops-hq/career-ops providers/getonbrd.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON:API feed, default category only: GET https://www.getonbrd.com/api/v0/categories/programming/jobs?per_page=100&expand[]=company&page=N ->
//   { data: [{ attributes: { title, remote, countries, published_at, company: { data: { attributes: { name } } } }, links: { public_url } }] }.
// career-ops supports several configurable categories; this port reads "programming" only. published_at is epoch SECONDS.
// Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

const PER_PAGE = 100;

export const spec: FeedSpec = {
  id: 'getonbrd',
  label: 'Get on Board',
  hosts: ['getonbrd.com'],
  pageUrl: (page) => `https://www.getonbrd.com/api/v0/categories/programming/jobs?per_page=${PER_PAGE}&expand[]=company&page=${page}`,
  maxPages: 3,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !Array.isArray(doc.data)) throw new Error('unexpected API response (expected { data: [...] })');
    return doc.data;
  },
  hasMore: (_doc, items) => items.length >= PER_PAGE,
  map(j: any) {
    const a = j && typeof j === 'object' ? j.attributes : null;
    if (!a || typeof a !== 'object') return null;
    const countries = Array.isArray(a.countries) ? a.countries.map(str).filter(Boolean).join(', ') : str(a.countries);
    return {
      title: str(a.title),
      company: str(a.company?.data?.attributes?.name),
      url: str(j.links?.public_url),
      location: a.remote === true ? 'Remote' : countries,
      remote: a.remote === true,
      posted: a.published_at,
    };
  },
  shapeSpec: z.object({ attributes: z.object({ title: z.string() }).passthrough(), links: z.object({ public_url: z.string() }).passthrough() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
