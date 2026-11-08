// Adapted from career-ops-hq/career-ops providers/higheredjobs.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide RSS category feed: GET https://www.higheredjobs.com/rss/categoryFeed.cfm?catID=68 (default category) -> <item><title/><link/><description>Institution (City, ST)</description><pubDate/></item>.
// The description is split at its last " (" into company and location. Listing only.
// Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export const spec: FeedSpec = {
  id: 'higheredjobs',
  label: 'HigherEdJobs',
  hosts: ['higheredjobs.com'],
  pageUrl: () => 'https://www.higheredjobs.com/rss/categoryFeed.cfm?catID=68',
  maxPages: 1,
  format: 'rss',
  itemsOf: (items) => items as unknown[],
  map(it: Record<string, string>) {
    const d = str(it.description);
    const i = d.lastIndexOf(' (');
    let company = d;
    let location = '';
    if (i >= 0) {
      company = d.slice(0, i).trim();
      const rest = d.slice(i + 2);
      const close = rest.lastIndexOf(')');
      location = (close >= 0 ? rest.slice(0, close) : rest).trim();
    }
    return { title: str(it.title), company, url: str(it.link), location, posted: it.pubDate };
  },
  shapeSpec: z.object({ title: z.string().min(1), link: z.string().min(1) }).passthrough(),
};

export const provider = makeFeedProvider(spec);
