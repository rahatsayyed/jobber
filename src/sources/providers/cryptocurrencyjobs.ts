// Adapted from career-ops-hq/career-ops providers/cryptocurrencyjobs.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide RSS feed: GET https://cryptocurrencyjobs.co/index.xml, <item><title>Role at Company</title><link/><description/><pubDate/></item>.
// Every posting is treated as remote (career-ops sets the location to "Remote"). Shape read from career-ops code only (live-unverified).
// Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export function splitAt(raw: string): { title: string; company: string } {
  const idx = raw.lastIndexOf(' at ');
  if (idx <= 0) return { title: raw, company: '' };
  return { title: raw.slice(0, idx).trim(), company: raw.slice(idx + 4).trim() };
}

export const spec: FeedSpec = {
  id: 'cryptocurrencyjobs',
  label: 'CryptoCurrencyJobs',
  hosts: ['cryptocurrencyjobs.co'],
  pageUrl: () => 'https://cryptocurrencyjobs.co/index.xml',
  maxPages: 1,
  format: 'rss',
  itemsOf: (items) => items as unknown[],
  map(it: Record<string, string>) {
    const { title, company } = splitAt(str(it.title));
    return { title, company, url: str(it.link) || str(it.guid), location: 'Remote', remote: true, description: str(it.description), posted: it.pubDate };
  },
  shapeSpec: z.object({ title: z.string().min(1), link: z.string().min(1) }).passthrough(),
};

export const provider = makeFeedProvider(spec);
