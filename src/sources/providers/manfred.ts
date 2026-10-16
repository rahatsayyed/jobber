// Adapted from career-ops-hq/career-ops providers/manfred.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON feed: GET https://www.getmanfred.com/api/v2/public/offers?lang=EN -> [{ id, slug, position, status, company: { name }, locations, remotePercentage }].
// Only status ACTIVE offers are kept. Salary fields are not imported. Shape read from career-ops code only (live-unverified).
// Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

export function manfredLocation(o: any): string {
  const listed = Array.isArray(o?.locations) ? o.locations.map(str).filter(Boolean) : [];
  if (listed.length) return listed.join(', ');
  const remote = Number(o?.remotePercentage);
  if (!Number.isFinite(remote)) return '';
  if (remote >= 100) return 'Remote';
  if (remote > 0) return 'Hybrid';
  return '';
}

export const spec: FeedSpec = {
  id: 'manfred',
  label: 'getManfred',
  hosts: ['getmanfred.com'],
  pageUrl: () => 'https://www.getmanfred.com/api/v2/public/offers?lang=EN',
  maxPages: 1,
  format: 'json',
  itemsOf(doc) {
    if (!Array.isArray(doc)) throw new Error('unexpected API response (expected a JSON array of offers)');
    return doc;
  },
  map(o: any) {
    if (!o || typeof o !== 'object' || o.status !== 'ACTIVE') return null;
    const id = Number(o.id);
    const slug = str(o.slug);
    if (!Number.isInteger(id) || id <= 0 || !/^[A-Za-z0-9._~-]+$/.test(slug)) return null;
    const location = manfredLocation(o);
    return {
      title: str(o.position),
      company: str(o.company?.name),
      url: `https://www.getmanfred.com/ofertas-empleo/${id}/${slug}`,
      location,
      remote: location === 'Remote',
    };
  },
  shapeSpec: z.object({ id: z.number(), slug: z.string(), position: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
