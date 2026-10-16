// Adapted from career-ops-hq/career-ops providers/4dayweek.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed: GET https://4dayweek.io/api/jobs?page=N -> { jobs: [...], has_more }. Shape read from career-ops code only (live-unverified).
// Listing only (the feed fields career-ops reads carry no description). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const PER_PAGE = 25;

export const spec: FeedSpec = {
  id: '4dayweek',
  label: '4 Day Week',
  hosts: ['4dayweek.io'],
  pageUrl: (page) => `https://4dayweek.io/api/jobs?page=${page}`,
  maxPages: 3,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !Array.isArray(doc.jobs)) throw new Error('unexpected API response (expected { jobs: [...] })');
    return doc.jobs;
  },
  hasMore: (doc: any, items) => doc?.has_more !== false && items.length >= PER_PAGE,
  map(j: any) {
    if (!j || typeof j !== 'object' || j.is_expired === true) return null;
    const slug = str(j.slug);
    if (!SLUG_RE.test(slug)) return null;
    const first = Array.isArray(j.locations) && j.locations[0] && typeof j.locations[0] === 'object' ? j.locations[0] : {};
    const base = [str(first.city), str(first.country)].filter(Boolean).join(', ');
    const remote = j.work_arrangement === 'remote' || first.work_arrangement === 'remote';
    return {
      title: str(j.title),
      company: str(j.company_name) || str(j.company?.name),
      url: `https://4dayweek.io/job/${encodeURIComponent(slug)}`,
      location: base,
      remote,
      posted: j.posted,
    };
  },
  shapeSpec: z.object({ title: z.string(), slug: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
