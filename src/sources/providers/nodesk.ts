// Adapted from career-ops-hq/career-ops providers/nodesk.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide RSS feed: GET https://nodesk.co/remote-jobs/index.xml, <item><title>Role at Company</title><link/><pubDate/></item>.
// A remote-jobs board: every posting is remote, no location field. Listing only. Shape read from career-ops code only (live-unverified).
// Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export function splitAtCi(raw: string): { title: string; company: string } {
  const idx = raw.toLowerCase().lastIndexOf(' at ');
  if (idx > 0) {
    const title = raw.slice(0, idx).trim();
    const company = raw.slice(idx + 4).trim();
    if (title && company) return { title, company };
  }
  return { title: raw.trim(), company: '' };
}

export const spec: FeedSpec = {
  id: 'nodesk',
  label: 'NoDesk',
  hosts: ['nodesk.co'],
  pageUrl: () => 'https://nodesk.co/remote-jobs/index.xml',
  maxPages: 1,
  format: 'rss',
  itemsOf: (items) => items as unknown[],
  map(it: Record<string, string>) {
    const { title, company } = splitAtCi(str(it.title));
    return { title, company, url: str(it.link), remote: true, posted: it.pubDate };
  },
  shapeSpec: z.object({ title: z.string().min(1), link: z.string().min(1) }).passthrough(),
};

export const provider = makeFeedProvider(spec);
