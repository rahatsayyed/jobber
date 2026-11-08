// Adapted from career-ops-hq/career-ops providers/remote-com.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit abefa6db. See that repo's LICENSE.
// Remote.com (the employer-of-record company) hiring for itself, through its own ATS: GET https://apply.remote.com/api/public/jobs
//   -> { jobs: [{ public_id, title, location ("EMEA", "APAC", "EMEA, NORAM"), workplace, opened_at, status, accepting_applications }] }
// Whole board in one response (undocumented endpoint, shape read from career-ops code, live-unverified). The list carries no usable description.
// Region codes are spelled out ("APAC (Asia-Pacific)") so a location filter written in either vocabulary matches. Posting page: https://apply.remote.com/jobs/<public_id>.
// Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

const REGION_NAMES: Record<string, string> = { EMEA: 'Europe, Middle East & Africa', NORAM: 'North America', LATAM: 'Latin America', APAC: 'Asia-Pacific' };
const WORKPLACE: Record<string, string> = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', on_site: 'On-site', 'on-site': 'On-site', office: 'On-site' };
const KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** "EMEA, NORAM" + "remote" -> "Remote · EMEA (Europe, Middle East & Africa) / NORAM (North America)". */
export function formatRemoteLocation(location: unknown, workplace: unknown): string {
  const seen = new Set<string>();
  const regions: string[] = [];
  if (typeof location === 'string') {
    for (const raw of location.split(',')) {
      const code = raw.trim();
      const key = code.toUpperCase();
      if (!code || seen.has(key)) continue;
      seen.add(key);
      const name = Object.prototype.hasOwnProperty.call(REGION_NAMES, key) ? REGION_NAMES[key] : '';
      regions.push(name ? `${key} (${name})` : code);
    }
  }
  const wpKey = typeof workplace === 'string' ? workplace.trim().toLowerCase() : '';
  const wp = Object.prototype.hasOwnProperty.call(WORKPLACE, wpKey) ? WORKPLACE[wpKey] : '';
  return [wp, regions.join(' / ')].filter(Boolean).join(' · ');
}

export const spec: FeedSpec = {
  id: 'remote-com',
  label: 'Remote',
  hosts: ['remote.com'],
  pageUrl: () => 'https://apply.remote.com/api/public/jobs',
  maxPages: 1,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !Array.isArray(doc.jobs)) throw new Error('unexpected API response (expected { jobs: [...] })');
    return doc.jobs;
  },
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    // Either flag closes a posting; an unseen status value is not taken to mean closed.
    if (j.accepting_applications === false || j.status === 'closed') return null;
    const id = str(j.public_id);
    if (!KEY_RE.test(id)) return null;
    const wp = str(j.workplace).toLowerCase();
    return {
      title: str(j.title), company: 'Remote', url: `https://apply.remote.com/jobs/${id}`,
      location: formatRemoteLocation(j.location, j.workplace), remote: wp === 'remote', posted: j.opened_at,
    };
  },
  shapeSpec: z.object({ public_id: z.string(), title: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
