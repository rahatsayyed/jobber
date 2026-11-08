// Adapted from career-ops-hq/career-ops providers/a16z-speedrun-talent.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed: GET https://speedrun-talent-network.com/api/v1/jobs?page=N&source=career-ops -> { jobs: [{ title, url, company, location, remote, published_at }], total_pages }. Page is 0-based.
// Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export const spec: FeedSpec = {
  id: 'a16z-speedrun-talent',
  label: 'a16z speedrun talent network',
  hosts: ['speedrun-talent-network.com'],
  pageUrl: (page) => `https://speedrun-talent-network.com/api/v1/jobs?page=${page - 1}&source=career-ops`,
  maxPages: 3,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !Array.isArray(doc.jobs)) throw new Error('unexpected API response (expected { jobs: [...] })');
    return doc.jobs;
  },
  hasMore: (doc: any, _items, pageNo) => typeof doc?.total_pages === 'number' && pageNo < doc.total_pages,
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    return { title: str(j.title), company: str(j.company), url: str(j.url), location: str(j.location), remote: j.remote === true, posted: j.published_at };
  },
  shapeSpec: z.object({ title: z.string(), url: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
