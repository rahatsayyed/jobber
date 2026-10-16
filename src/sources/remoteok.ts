import { z } from 'zod';
import { toIsoDay, type Job } from '../db.js';
import type { Provider } from './provider.js';

const DEV_KEYWORDS = [
  'react',
  'node',
  'typescript',
  'javascript',
  'frontend',
  'full stack',
  'fullstack',
  'software engineer',
  'web developer',
  'backend',
  'python',
  'next.js',
];

export function normalizeRemoteok(raw: any): Job[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((j: any) => j && (j.id !== undefined || j.position !== undefined))
    .filter((j: any) => {
      const haystack = `${j.position ?? ''} ${(j.tags ?? []).join(' ')}`.toLowerCase();
      return DEV_KEYWORDS.some((kw) => haystack.includes(kw));
    })
    .map((j: any): Job => ({
      id: `remoteok:${j.id ?? j.slug}`,
      source: 'remoteok',
      title: j.position,
      company: j.company,
      url: j.url,
      apply_url: j.apply_url ?? j.url,
      description: j.description,
      ...(toIsoDay(j.date ?? j.epoch) ? { posted_at: toIsoDay(j.date ?? j.epoch) } : {}),
    }));
}

// The first element of the feed is a legal notice (no `position`); the sample skips it.
export const shapeSpec = z.object({ position: z.string(), company: z.string(), url: z.string() }).passthrough();

async function requestRemoteok(): Promise<{ jobs: Job[]; sample: unknown[] }> {
  const res = await fetch('https://remoteok.com/api', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jobber/1.0)' },
  });
  if (!res.ok) {
    throw new Error(`RemoteOK request failed: ${res.status}`);
  }
  const raw = await res.json();
  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  return { jobs: normalizeRemoteok(raw), sample: list.filter((x) => !(x && typeof x === 'object' && 'legal' in x)).slice(0, 5) };
}

export const provider: Provider = { id: 'remoteok', shapeSpec, fetch: () => requestRemoteok() };

export async function fetchRemoteok(): Promise<Job[]> {
  try {
    return (await requestRemoteok()).jobs;
  } catch (err) {
    console.error('[remoteok] fetch failed:', err);
    return [];
  }
}
