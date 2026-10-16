// Adapted from career-ops-hq/career-ops providers/landingjobs.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed: GET https://landing.jobs/api/v1/jobs -> [{ title, url, locations: [{ city, country_code }], remote, published_at, created_at }].
// The company is not a field: career-ops derives it from the posting URL path /at/<company-slug>. Postings without it get the board name.
// Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export function companyFromUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return ''; }
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs[0] !== 'at' || !segs[1]) return '';
  return segs[1].replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

export const spec: FeedSpec = {
  id: 'landingjobs',
  label: 'Landing.jobs',
  hosts: ['landing.jobs'],
  pageUrl: () => 'https://landing.jobs/api/v1/jobs',
  maxPages: 1,
  format: 'json',
  itemsOf(doc) {
    if (!Array.isArray(doc)) throw new Error('unexpected API response (expected a JSON array)');
    return doc;
  },
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    const url = str(j.url);
    const first = Array.isArray(j.locations) && j.locations[0] && typeof j.locations[0] === 'object' ? j.locations[0] : {};
    return {
      title: str(j.title),
      company: companyFromUrl(url),
      url,
      location: [str(first.city), str(first.country_code)].filter(Boolean).join(', '),
      remote: j.remote === true,
      posted: j.published_at ?? j.created_at,
    };
  },
  shapeSpec: z.object({ title: z.string(), url: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
