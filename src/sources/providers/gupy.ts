// Adapted from career-ops-hq/career-ops providers/gupy.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON search: GET https://portal.gupy.io/api/job-search/jobs?jobName=react&limit=100&offset=N -> { data: [{ name, jobUrl, careerPageName, workplaceType, city, state, country, publishedDate, description, isConfidentialCareerPage }] }.
// One fixed keyword (the feed engine has no per-run keywords). Confidential postings are dropped. A short page (under 100) ends the walk.
// Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

const PER_PAGE = 100;
const CONFIDENTIAL = /^(empresa\s+)?confidencial$/i;
const WORKPLACE: Record<string, string> = { remote: 'Remoto', hybrid: 'Híbrido', 'on-site': 'Presencial' };

export const spec: FeedSpec = {
  id: 'gupy',
  label: 'Gupy',
  hosts: ['gupy.io'],
  pageUrl: (page) => `https://portal.gupy.io/api/job-search/jobs?jobName=react&limit=${PER_PAGE}&offset=${(page - 1) * PER_PAGE}`,
  maxPages: 2,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !Array.isArray(doc.data)) throw new Error('unexpected API response (expected { data: [...] })');
    return doc.data;
  },
  hasMore: (_doc, items) => items.length >= PER_PAGE,
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    const company = str(j.careerPageName);
    if (j.isConfidentialCareerPage === true || !company || CONFIDENTIAL.test(company)) return null;
    const wp = str(j.workplaceType).toLowerCase();
    const remote = wp === 'remote' || (!wp && j.isRemoteWork === true);
    const location = [WORKPLACE[wp], str(j.city), str(j.state), str(j.country)].filter(Boolean).join(', ');
    return { title: str(j.name), company, url: str(j.jobUrl), location, remote, description: str(j.description), posted: j.publishedDate };
  },
  shapeSpec: z.object({ name: z.string(), jobUrl: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
