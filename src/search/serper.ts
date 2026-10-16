// Serper (google.serper.dev) provider. Used for contact finding only, after cache and dorking miss.
import type { SearchProvider, SearchResult } from './index.js';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export function createSerperProvider(apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): SearchProvider {
  return {
    id: 'serper',
    async search(q) {
      try {
        const res = await fetchImpl('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q }),
        });
        if (!res.ok) return { results: [] };
        const data = (await res.json()) as { organic?: Array<{ title?: unknown; snippet?: unknown; link?: unknown }> };
        const results: SearchResult[] = [];
        for (const o of data?.organic ?? []) {
          if (typeof o.link !== 'string') continue;
          results.push({
            title: typeof o.title === 'string' ? o.title : '',
            snippet: typeof o.snippet === 'string' ? o.snippet : '',
            url: o.link,
          });
        }
        return { results };
      } catch {
        return { results: [] };
      }
    },
  };
}
