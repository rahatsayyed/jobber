// Adapted from career-ops-hq/career-ops providers/startup-jobs.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide RSS feed: GET https://startup.jobs/feeds/jobs, <item><title>Role at Company</title><link/><description/><pubDate/></item>.
// An item without " at " in the title (employer unknown) is skipped. The location is the last description line before " · ".
// The posting URL is stored without its query string. career-ops accepts optional role/workplace filters; this port reads the unfiltered feed.
// Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export function startupLocation(description: string): string {
  const lines = description.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const sep = last.indexOf(' · ');
  return (sep === -1 ? last : last.slice(0, sep)).trim();
}

export const spec: FeedSpec = {
  id: 'startup-jobs',
  label: 'startup.jobs',
  hosts: ['startup.jobs'],
  pageUrl: () => 'https://startup.jobs/feeds/jobs',
  maxPages: 1,
  format: 'rss',
  itemsOf: (items) => items as unknown[],
  map(it: Record<string, string>) {
    const raw = str(it.title);
    const idx = raw.lastIndexOf(' at ');
    if (idx === -1) return null;
    const title = raw.slice(0, idx).trim();
    const company = raw.slice(idx + 4).trim().replace(/^bei\s+/i, '');
    if (!title || !company) return null;
    let url = '';
    try { const u = new URL(str(it.link)); url = u.protocol === 'https:' ? `https://${u.hostname}${u.pathname}` : ''; } catch { url = ''; }
    const desc = str(it.description);
    const location = startupLocation(desc);
    return { title, company, url, location, remote: /remote/i.test(location), description: desc, posted: it.pubDate };
  },
  shapeSpec: z.object({ title: z.string().min(1), link: z.string().min(1) }).passthrough(),
};

export const provider = makeFeedProvider(spec);
