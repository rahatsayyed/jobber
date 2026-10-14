// Adapted from career-ops-hq/career-ops providers/ashby.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
import { toIsoDay } from '../../db.js';
import { assertSlug, type TrackedCompany } from './filters.js';
import { boardUrl, capDescription, clip, getJson, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, stripQuery, type BoardJob } from './greenhouse.js';

export function normalizeAshby(raw: any, c: TrackedCompany): BoardJob[] {
  const jobs = (Array.isArray(raw?.jobs) ? raw.jobs : []).slice(0, MAX_JOBS_PER_BOARD);
  const out: BoardJob[] = [];
  for (const j of jobs) {
    if (!j || typeof j.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(j.id) || typeof j.title !== 'string') continue;
    if (`ashby:${c.slug}:${j.id}`.length > MAX_ID_CHARS) continue;
    if (j.isListed === false) continue;
    const locations = [j.location, ...(Array.isArray(j.secondaryLocations) ? j.secondaryLocations.map((s: any) => s?.location) : [])]
      .filter((x): x is string => typeof x === 'string').map(clip);
    const posted = toIsoDay(j.publishedAt);
    const url = boardUrl(j.jobUrl, 'ashbyhq.com', `https://jobs.ashbyhq.com/${c.slug}/${j.id}`);
    out.push({
      id: `ashby:${c.slug}:${j.id}`,
      source: 'ashby',
      title: clip(j.title),
      company: c.name,
      url,
      apply_url: boardUrl(j.applyUrl, 'ashbyhq.com', `${stripQuery(url)}/application`),
      description: capDescription(typeof j.descriptionPlain === 'string' ? j.descriptionPlain : ''),
      ...(posted ? { posted_at: posted } : {}),
      locations: locations.length ? locations : [''],
      remote: typeof j.workplaceType === 'string' ? j.workplaceType.toLowerCase() === 'remote' : j.isRemote === true,
    });
  }
  return out;
}

export async function fetchAshby(c: TrackedCompany): Promise<BoardJob[]> {
  assertSlug(c.slug);
  const raw = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.slug)}?includeCompensation=true`, `ashby ${c.slug}`);
  return normalizeAshby(raw, c);
}
