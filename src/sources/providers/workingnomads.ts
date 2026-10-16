// Adapted from career-ops-hq/career-ops providers/workingnomads.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed: GET https://www.workingnomads.com/api/exposed_jobs/ -> [{ title, url, company_name, location }].
// Every posting is remote. Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export const spec: FeedSpec = {
  id: 'workingnomads',
  label: 'Working Nomads',
  hosts: ['workingnomads.com'],
  pageUrl: () => 'https://www.workingnomads.com/api/exposed_jobs/',
  maxPages: 1,
  format: 'json',
  itemsOf(doc) {
    if (!Array.isArray(doc)) throw new Error('unexpected API response (expected a JSON array)');
    return doc;
  },
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    return { title: str(j.title), company: str(j.company_name), url: str(j.url), location: str(j.location), remote: true };
  },
  shapeSpec: z.object({ title: z.string(), url: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
