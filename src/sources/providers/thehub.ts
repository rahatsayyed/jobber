// Adapted from career-ops-hq/career-ops providers/thehub.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed: GET https://thehub.io/api/v2/jobsandfeatured?page=N&countryCode=EU ->
//   { jobs: { docs: [{ id, title, company: { name }, location: { address, locality, country }, isRemote }], pages } }.
// career-ops also runs an optional second pass with isRemote=true and a configurable country code; this port reads the default EU scope only.
// Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

const PER_PAGE = 15;

export const spec: FeedSpec = {
  id: 'thehub',
  label: 'The Hub',
  hosts: ['thehub.io'],
  pageUrl: (page) => `https://thehub.io/api/v2/jobsandfeatured?page=${page}&countryCode=EU`,
  maxPages: 3,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !doc.jobs || !Array.isArray(doc.jobs.docs)) throw new Error('unexpected API response (expected { jobs: { docs: [...] } })');
    return doc.jobs.docs;
  },
  hasMore: (doc: any, items, page) => items.length >= PER_PAGE && !(Number.isInteger(doc?.jobs?.pages) && page >= doc.jobs.pages),
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    const id = str(j.id);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const loc = j.location && typeof j.location === 'object' ? j.location : {};
    return {
      title: str(j.title),
      company: str(j.company?.name),
      url: `https://thehub.io/jobs/${id}`,
      location: str(loc.address) || [str(loc.locality), str(loc.country)].filter(Boolean).join(', '),
      remote: j.isRemote === true,
    };
  },
  shapeSpec: z.object({ id: z.string(), title: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
