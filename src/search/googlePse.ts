// Google Programmable Search JSON API provider. Key and cx come from env only (GOOGLE_PSE_API_KEY, GOOGLE_PSE_CX).
import type { SearchProvider, SearchResult } from './index.js';

type FetchLike = (url: string, init?: { method: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function createGooglePseProvider(apiKey: string, cx: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): SearchProvider {
  return {
    id: 'google_pse',
    async search(q) {
      try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=10`;
        const res = await fetchImpl(url, { method: 'GET' });
        if (!res.ok) return { results: [] };
        const data = (await res.json()) as { items?: Array<{ title?: unknown; snippet?: unknown; link?: unknown }> };
        const results: SearchResult[] = [];
        for (const o of data?.items ?? []) {
          if (typeof o.link !== 'string') continue;
          results.push({ title: typeof o.title === 'string' ? o.title : '', snippet: typeof o.snippet === 'string' ? o.snippet : '', url: o.link });
        }
        return { results };
      } catch {
        return { results: [] };
      }
    },
  };
}
