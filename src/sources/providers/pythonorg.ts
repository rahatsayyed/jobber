// Adapted from career-ops-hq/career-ops providers/pythonorg.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide RSS feed: GET https://www.python.org/jobs/feed/rss/, <item><title>Role, Company</title><link/><description/><pubDate/></item>.
// The first plain line of the description is the location (career-ops: when it does not start with a tag). Shape read from career-ops code only (live-unverified).
// Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { htmlToPlain } from '../boards/filters.js';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export function pythonLocation(rawDesc: string): string {
  if (!rawDesc) return '';
  const first = rawDesc.split(/\r?\n|(?=<[a-z/!])|(?=&lt;[a-z/!])/i)[0] ?? '';
  return /^\s*(?:<|&lt;)/i.test(first) ? '' : htmlToPlain(first);
}

export const spec: FeedSpec = {
  id: 'pythonorg',
  label: 'Python.org Job Board',
  hosts: ['python.org'],
  pageUrl: () => 'https://www.python.org/jobs/feed/rss/',
  maxPages: 1,
  format: 'rss',
  itemsOf: (items) => items as unknown[],
  map(it: Record<string, string>) {
    const raw = str(it.title);
    const comma = raw.lastIndexOf(',');
    if (comma <= 0) return null;
    const title = raw.slice(0, comma).trim();
    const company = raw.slice(comma + 1).trim();
    if (!title || !company) return null;
    const desc = str(it.description);
    const location = pythonLocation(desc);
    return { title, company, url: str(it.link) || str(it.guid), location, remote: /remote/i.test(location), description: desc, posted: it.pubDate || it['dc:date'] };
  },
  shapeSpec: z.object({ title: z.string().min(1), link: z.string().min(1) }).passthrough(),
};

export const provider = makeFeedProvider(spec);
