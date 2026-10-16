// Adapted from career-ops-hq/career-ops providers/larajobs.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide RSS feed: GET https://larajobs.com/feed, <item><title/><link/><job:company/><dc:creator/><job:location/><pubDate/></item>.
// Listing only. Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export const spec: FeedSpec = {
  id: 'larajobs',
  label: 'LaraJobs',
  hosts: ['larajobs.com'],
  pageUrl: () => 'https://larajobs.com/feed',
  maxPages: 1,
  format: 'rss',
  itemsOf: (items) => items as unknown[],
  map(it: Record<string, string>) {
    const location = str(it['job:location']);
    return { title: str(it.title), company: str(it['job:company']) || str(it['dc:creator']), url: str(it.link), location, remote: /remote|anywhere/i.test(location), posted: it.pubDate };
  },
  shapeSpec: z.object({ title: z.string().min(1), link: z.string().min(1) }).passthrough(),
};

export const provider = makeFeedProvider(spec);
