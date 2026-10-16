// Adapted from career-ops-hq/career-ops providers/jobicy.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide remote-jobs JSON feed: GET https://jobicy.com/api/v2/remote-jobs?count=50 -> { jobs: [{ jobTitle, url, companyName, jobGeo, pubDate }] }.
// Every posting is remote. Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export const spec: FeedSpec = {
  id: 'jobicy',
  label: 'Jobicy',
  hosts: ['jobicy.com'],
  pageUrl: () => 'https://jobicy.com/api/v2/remote-jobs?count=50',
  maxPages: 1,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !Array.isArray(doc.jobs)) throw new Error('unexpected API response (expected { jobs: [...] })');
    return doc.jobs;
  },
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    return { title: str(j.jobTitle), company: str(j.companyName), url: str(j.url), location: str(j.jobGeo), remote: true, posted: j.pubDate };
  },
  shapeSpec: z.object({ jobTitle: z.string(), url: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
