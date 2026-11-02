// Tavily search provider (plain fetch). Key comes from env only (TAVILY_API_KEY).
import type { SearchProvider, SearchResult } from './index.js';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export function createTavilyProvider(apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): SearchProvider {
  return {
    id: 'tavily',
    async search(q) {
      try {
        const res = await fetchImpl('https://api.tavily.com/search', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, max_results: 10 }),
        });
        if (!res.ok) return { results: [] };
        const data = (await res.json()) as { results?: Array<{ title?: unknown; content?: unknown; url?: unknown }> };
        const results: SearchResult[] = [];
        for (const o of data?.results ?? []) {
          if (typeof o.url !== 'string') continue;
          results.push({ title: typeof o.title === 'string' ? o.title : '', snippet: typeof o.content === 'string' ? o.content : '', url: o.url });
        }
        return { results };
      } catch {
        return { results: [] };
      }
    },
  };
}
