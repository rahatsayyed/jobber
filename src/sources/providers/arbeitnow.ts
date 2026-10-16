// Adapted from career-ops-hq/career-ops providers/arbeitnow.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed: GET https://www.arbeitnow.com/api/job-board-api?page=N -> { data: [{ slug, company_name, title, description, remote, url, location, created_at }] }.
// Pages are built as ?page=N, never by following links.next (it carries a rotating search term). created_at is epoch SECONDS.
// Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

const PER_PAGE = 100;

export const spec: FeedSpec = {
  id: 'arbeitnow',
  label: 'Arbeitnow',
  hosts: ['arbeitnow.com'],
  pageUrl: (page) => `https://www.arbeitnow.com/api/job-board-api?page=${page}`,
  maxPages: 3,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !Array.isArray(doc.data)) throw new Error('unexpected API response (expected { data: [...] })');
    return doc.data;
  },
  hasMore: (_doc, items) => items.length >= PER_PAGE,
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    return {
      title: str(j.title),
      company: str(j.company_name),
      url: str(j.url),
      location: str(j.location),
      remote: j.remote === true,
      description: str(j.description),
      posted: j.created_at,
    };
  },
  shapeSpec: z.object({ title: z.string(), url: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
