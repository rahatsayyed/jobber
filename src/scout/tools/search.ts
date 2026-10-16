// scout_search (plan 8G task 7): the query is built in code from validated tokens (never a raw model
// query) and runs through searchWithBudget (cache, browser dork with engine fallback, then Serper under
// budget). Titles, snippets and URLs are untrusted: screened, wrapped, and only then made navigable.
import { searchWithBudget, type DorkParams, type SearchKind } from '../../search/index.js';
import { blockedJson, json, normalizeUrl, untrustedBlock, type ScoutCtx } from './common.js';

export const SEARCH_KINDS = ['company_domain', 'domain_emails', 'careers_page', 'hiring_posts', 'jobs_site'] as const;

export async function scoutSearch(a: { kind: SearchKind; params?: DorkParams }, deps: ScoutCtx): Promise<string> {
  if (!(SEARCH_KINDS as readonly string[]).includes(a?.kind)) return json({ ok: false, code: 'invalid_kind' });
  const out = await searchWithBudget(deps.db, a.kind, a.params ?? {}, { env: deps.env, now: deps.now, dork: deps.dork });
  if (out.results.length === 0) {
    return json({ ok: true, provider: out.provider, ...(out.reason ? { reason: out.reason } : {}), count: 0 });
  }
  const shown = out.results.slice(0, 10);
  const lines = shown.map((r, i) => `${i + 1}. ${r.title} | ${r.url} | ${r.snippet}`);
  const v = await deps.screen(lines.join('\n'), 'read');
  if (v.blocked) return blockedJson(v);
  for (const r of shown) {
    const n = normalizeUrl(r.url);
    if (n) deps.seenUrls.add(n);
  }
  return json({
    ok: true, provider: out.provider, count: out.results.length, ...(v.unscreened ? { classifier: 'unscreened' } : {}),
    results: untrustedBlock(v.text),
  });
}
