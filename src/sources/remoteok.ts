import { toIsoDay, type Job } from '../db.js';

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

export async function fetchRemoteok(): Promise<Job[]> {
  try {
    const res = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jobber/1.0)' },
    });
    if (!res.ok) {
      throw new Error(`RemoteOK request failed: ${res.status}`);
    }
    const raw = await res.json();
    return normalizeRemoteok(raw);
  } catch (err) {
    console.error('[remoteok] fetch failed:', err);
    return [];
  }
}
