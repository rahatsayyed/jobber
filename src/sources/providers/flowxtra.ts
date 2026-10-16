// Adapted from career-ops-hq/career-ops providers/flowxtra.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed: GET https://app.flowxtra.com/api/central/jobs?status=Live&per_page=100&page=N ->
//   { data: { data: [{ title, urlJobApplay, name_company, city_company, state_company, country_company, workplace, date_share }], next_page_url } }.
// The posting URL (urlJobApplay) must be on flowxtra.com. Shape read from career-ops code only (live-unverified).
// Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

const PER_PAGE = 100;

export const spec: FeedSpec = {
  id: 'flowxtra',
  label: 'Flowxtra',
  hosts: ['flowxtra.com'],
  pageUrl: (page) => `https://app.flowxtra.com/api/central/jobs?status=Live&per_page=${PER_PAGE}&page=${page}`,
  maxPages: 3,
  format: 'json',
  itemsOf(doc: any) {
    const rows = doc?.data?.data;
    if (!Array.isArray(rows)) throw new Error('unexpected API response (expected { data: { data: [...] } })');
    return rows;
  },
  hasMore: (doc: any, items) => Boolean(doc?.data?.next_page_url) && items.length >= PER_PAGE,
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    return {
      title: str(j.title),
      company: str(j.name_company),
      url: str(j.urlJobApplay),
      location: [j.city_company, j.state_company, j.country_company].map(str).filter(Boolean).join(', '),
      remote: j.workplace === 'Remote',
      posted: j.date_share,
    };
  },
  shapeSpec: z.object({ title: z.string(), urlJobApplay: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
