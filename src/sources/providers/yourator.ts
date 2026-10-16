// Adapted from career-ops-hq/career-ops providers/yourator.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed: GET https://www.yourator.co/api/v4/jobs?page=N -> { payload: { jobs: [{ name, path, company: { brand }, location }], hasMore } }.
// career-ops may use a job's thirdPartyUrl (an employer page on any host); this port ALWAYS uses the yourator.co path so no foreign host is stored.
// career-ops pages up to 120 times; here at most 5 pages per run. Shape read from career-ops code only (live-unverified).
// Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export const spec: FeedSpec = {
  id: 'yourator',
  label: 'Yourator',
  hosts: ['yourator.co'],
  pageUrl: (page) => `https://www.yourator.co/api/v4/jobs?page=${page}`,
  maxPages: 5,
  format: 'json',
  itemsOf(doc: any) {
    const jobs = doc?.payload?.jobs;
    if (!Array.isArray(jobs)) throw new Error('unexpected API response (expected { payload: { jobs: [...] } })');
    return jobs;
  },
  hasMore: (doc: any) => doc?.payload?.hasMore === true,
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    const path = str(j.path);
    if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return null;
    return { title: str(j.name), company: str(j.company?.brand), url: `https://www.yourator.co${path}`, location: str(j.location) };
  },
  shapeSpec: z.object({ name: z.string(), path: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
