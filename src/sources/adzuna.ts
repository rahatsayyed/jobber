import { z } from 'zod';
import { toIsoDay, type Job } from '../db.js';
import type { Provider } from './provider.js';
import { listAt } from './boards/provider.js';

export function normalizeAdzuna(raw: any): Job[] {
  const results = raw?.results ?? [];
  return results.map((r: any): Job => ({
    id: `adzuna:${r.id}`,
    source: 'adzuna',
    title: r.title,
    company: r.company?.display_name ?? '',
    url: r.redirect_url,
    apply_url: r.redirect_url,
    description: r.description,
    ...(toIsoDay(r.created) ? { posted_at: toIsoDay(r.created) } : {}),
  }));
}

export const shapeSpec = z.object({ id: z.union([z.number(), z.string()]), title: z.string(), redirect_url: z.string() }).passthrough();

async function requestAdzuna(params: { role: string; location?: string; country?: string }): Promise<{ jobs: Job[]; sample: unknown[] }> {
  const country = params.country || 'in';
  const query = new URLSearchParams({
    app_id: process.env.ADZUNA_APP_ID ?? '',
    app_key: process.env.ADZUNA_APP_KEY ?? '',
    results_per_page: '50',
    what: params.role,
    where: params.location || '',
    'content-type': 'application/json',
  });
  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${query.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Adzuna request failed: ${res.status}`);
  }
  const raw = await res.json();
  return { jobs: normalizeAdzuna(raw), sample: listAt(raw, 'results').slice(0, 5) };
}

// Throws on failure so the runner can see it; fetchAdzuna below keeps the old never-throw contract.
export const provider: Provider = {
  id: 'adzuna',
  shapeSpec,
  fetch: (ctx) => requestAdzuna({ role: ctx.params?.role ?? '', location: ctx.params?.location }),
};

export async function fetchAdzuna(params: { role: string; location?: string; country?: string }): Promise<Job[]> {
  try {
    return (await requestAdzuna(params)).jobs;
  } catch (err) {
    console.error('[adzuna] fetch failed:', err);
    return [];
  }
}
