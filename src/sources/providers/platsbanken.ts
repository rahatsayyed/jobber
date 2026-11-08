// Adapted from career-ops-hq/career-ops providers/platsbanken.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12. See that repo's LICENSE.
// Board-wide JSON search (Sweden, JobTech Dev JobSearch): GET https://jobsearch.api.jobtechdev.se/search?q=react&limit=100&offset=N -> { hits: [{ id, headline, employer: { name }, workplace_address, publication_date, description: { text } }] }.
// The permalink is rebuilt from the ad id on arbetsformedlingen.se (never the payload's webpage_url). One fixed keyword. The source stops serving rows past offset 2000.
// Shape read from career-ops code only (live-unverified). Terms of use and robots.txt are unreviewed: check them before enabling.
import { z } from 'zod';
import { makeFeedProvider, str, type FeedSpec } from './feed.js';

const PER_PAGE = 100;

export const spec: FeedSpec = {
  id: 'platsbanken',
  label: 'Platsbanken',
  hosts: ['jobtechdev.se', 'arbetsformedlingen.se'],
  pageUrl: (page) => `https://jobsearch.api.jobtechdev.se/search?q=react&limit=${PER_PAGE}&offset=${(page - 1) * PER_PAGE}`,
  maxPages: 2,
  format: 'json',
  itemsOf(doc: any) {
    if (!doc || !Array.isArray(doc.hits)) throw new Error('unexpected API response (expected { hits: [...] })');
    return doc.hits;
  },
  hasMore: (_doc, items) => items.length >= PER_PAGE,
  map(j: any) {
    if (!j || typeof j !== 'object') return null;
    const id = str(j.id);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const a = j.workplace_address ?? {};
    const location = [str(a.city) || str(a.municipality), str(a.region), str(a.country)].filter(Boolean).join(', ');
    return {
      title: str(j.headline),
      company: str(j.employer?.name),
      url: `https://arbetsformedlingen.se/platsbanken/annonser/${id}`,
      location,
      description: str(j.description?.text),
      posted: j.publication_date,
    };
  },
  shapeSpec: z.object({ id: z.string(), headline: z.string() }).passthrough(),
};

export const provider = makeFeedProvider(spec);
