import { toIsoDay, type Job } from '../db.js';

export function normalizeRemotive(raw: any): Job[] {
  const jobs = raw?.jobs ?? [];
  return jobs.map((j: any): Job => ({
    id: `remotive:${j.id}`,
    source: 'remotive',
    title: j.title,
    company: j.company_name,
    url: j.url,
    apply_url: j.url,
    description: j.description,
    ...(toIsoDay(j.publication_date) ? { posted_at: toIsoDay(j.publication_date) } : {}),
  }));
}

export async function fetchRemotive(params: { role: string }): Promise<Job[]> {
  try {
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(params.role)}&limit=50`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Remotive request failed: ${res.status}`);
    }
    const raw = await res.json();
    return normalizeRemotive(raw);
  } catch (err) {
    console.error('[remotive] fetch failed:', err);
    return [];
  }
}
