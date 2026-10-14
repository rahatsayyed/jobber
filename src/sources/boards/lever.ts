// Adapted from career-ops-hq/career-ops providers/lever.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
import { toIsoDay } from '../../db.js';
import { assertSlug, type TrackedCompany } from './filters.js';
import { boardUrl, capDescription, clip, getJson, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, stripQuery, type BoardJob } from './greenhouse.js';

export function normalizeLever(raw: any, c: TrackedCompany): BoardJob[] {
  const list = (Array.isArray(raw) ? raw : []).slice(0, MAX_JOBS_PER_BOARD);
  const out: BoardJob[] = [];
  for (const p of list) {
    if (!p || typeof p.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(p.id) || typeof p.text !== 'string') continue;
    if (`lever:${c.slug}:${p.id}`.length > MAX_ID_CHARS) continue;
    const all = Array.isArray(p.categories?.allLocations) && p.categories.allLocations.length
      ? p.categories.allLocations.filter((x: unknown): x is string => typeof x === 'string').map(clip)
      : [clip(typeof p.categories?.location === 'string' ? p.categories.location : '')];
    const posted = toIsoDay(p.createdAt);
    const description = capDescription([p.descriptionPlain, p.additionalPlain].filter((x) => typeof x === 'string' && x.trim()).join('\n\n'));
    const canonical = `https://jobs${c.region === 'eu' ? '.eu' : ''}.lever.co/${c.slug}/${p.id}`;
    const url = boardUrl(p.hostedUrl, 'lever.co', canonical);
    out.push({
      id: `lever:${c.slug}:${p.id}`,
      source: 'lever',
      title: clip(p.text),
      company: c.name,
      url,
      apply_url: boardUrl(p.applyUrl, 'lever.co', `${stripQuery(url)}/apply`),
      description,
      ...(posted ? { posted_at: posted } : {}),
      locations: all.length ? all : [''],
      remote: p.workplaceType === 'remote' || all.some((l: string) => /remote/i.test(l)),
    });
  }
  return out;
}

export async function fetchLever(c: TrackedCompany): Promise<BoardJob[]> {
  assertSlug(c.slug);
  const host = c.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
  const raw = await getJson(`https://${host}/v0/postings/${encodeURIComponent(c.slug)}?mode=json`, `lever ${c.slug}`);
  return normalizeLever(raw, c);
}
