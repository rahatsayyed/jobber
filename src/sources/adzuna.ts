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

/**
 * The search URL, pure (no network). Finding 8: the request used to send `where=` empty and a
 * `content-type` query parameter, and Adzuna answered HTTP 400 (the empty parameter is the likely cause;
 * the live fix is unverified). Now only non-empty documented parameters are sent, the role has its
 * punctuation stripped to words, and missing credentials fail before any request. `paramNames` is what
 * errors may show: names only, never values.
 */
export function buildAdzunaRequest(
  params: { role: string; location?: string; country?: string },
  env: Record<string, string | undefined> = process.env,
): { url: string; paramNames: string[] } {
  const appId = (env.ADZUNA_APP_ID ?? '').trim();
  const appKey = (env.ADZUNA_APP_KEY ?? '').trim();
  if (!appId || !appKey) throw new Error('adzuna_credentials_missing');
  const what = (params.role ?? '').replace(/[^\p{L}\p{N}+#.\s-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!what) throw new Error('adzuna_role_missing');
  const cc = (params.country ?? '').trim().toLowerCase();
  const country = /^[a-z]{2}$/.test(cc) ? cc : 'in';
  const query = new URLSearchParams({ app_id: appId, app_key: appKey, results_per_page: '50', what });
  const where = (params.location ?? '').trim();
  if (where) query.set('where', where);
  return {
    url: `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${query.toString()}`,
    paramNames: [...query.keys()],
  };
}

async function requestAdzuna(params: { role: string; location?: string; country?: string }): Promise<{ jobs: Job[]; sample: unknown[] }> {
  const { url, paramNames } = buildAdzunaRequest(params);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Adzuna request failed: ${res.status} (params: ${paramNames.join(', ')})`);
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
