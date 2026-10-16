import { z } from 'zod';
import { toIsoDay, type Job } from '../db.js';
import type { Provider } from './provider.js';
import { listAt } from './boards/provider.js';

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

export const shapeSpec = z.object({ id: z.union([z.number(), z.string()]), title: z.string(), company_name: z.string(), url: z.string() }).passthrough();

async function requestRemotive(params: { role: string }): Promise<{ jobs: Job[]; sample: unknown[] }> {
  const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(params.role)}&limit=50`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Remotive request failed: ${res.status}`);
  }
  const raw = await res.json();
  return { jobs: normalizeRemotive(raw), sample: listAt(raw, 'jobs').slice(0, 5) };
}

export const provider: Provider = {
  id: 'remotive',
  shapeSpec,
  fetch: (ctx) => requestRemotive({ role: ctx.params?.role ?? '' }),
};

export async function fetchRemotive(params: { role: string }): Promise<Job[]> {
  try {
    return (await requestRemotive(params)).jobs;
  } catch (err) {
    console.error('[remotive] fetch failed:', err);
    return [];
  }
}
