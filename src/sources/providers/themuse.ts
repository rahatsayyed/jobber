// Adapted from career-ops-hq/career-ops providers/themuse.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed: GET https://www.themuse.com/api/public/jobs?page=N (page is 0-based) ->
//   { results: [{ name, refs: { landing_page }, company: { name }, locations: [{ name }] }], page_count }.
// career-ops reads up to 100 pages with retries; here at most 5 pages per run and no retry loop (the runner records a failure).
// Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export const spec: FeedSpec = {
  id: 'themuse',
  label: 'The Muse',
  hosts: ['themuse.com'],
  pageUrl: (page) => `https://www.themuse.com/api/public/jobs?page=${page - 1}`,
  maxPages: 5,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !Array.isArray(doc.results)) throw new Error('unexpected API response (expected { results: [...] })');
    return doc.results;
  },
  hasMore: (doc: any, _items, page) => Number.isInteger(doc?.page_count) && doc.page_count > page,
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    const loc = Array.isArray(j.locations) && j.locations[0] && typeof j.locations[0] === 'object' ? str(j.locations[0].name) : '';
    return { title: str(j.name), company: str(j.company?.name), url: str(j.refs?.landing_page), location: loc, remote: /flexible\s*\/\s*remote|remote/i.test(loc) };
  },
  shapeSpec: z.object({ name: z.string(), refs: z.object({ landing_page: z.string() }).passthrough() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
