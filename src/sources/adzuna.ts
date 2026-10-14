import { toIsoDay, type Job } from '../db.js';

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

export async function fetchAdzuna(params: { role: string; location?: string; country?: string }): Promise<Job[]> {
  try {
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
    return normalizeAdzuna(raw);
  } catch (err) {
    console.error('[adzuna] fetch failed:', err);
    return [];
  }
}
