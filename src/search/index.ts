// Search abstraction (plan 8G task 3): cache -> browser-dork (budget, block cooldown) -> Serper (daily and
// monthly budget). Every provider call is counted. Search results are untrusted text.
import type BetterSqlite3 from 'better-sqlite3';
import {
  cacheGet, cachePut, cooldownUntil, loadSearchConfig, queryHash, recordUsage, startCooldown, usageMonth, usageToday,
  type SearchConfig,
} from './budget.js';
import { buildDork, type DorkParams } from './dork.js';
import { createSerperProvider } from './serper.js';
import { createGooglePseProvider } from './googlePse.js';
import { createTavilyProvider } from './tavily.js';

type Db = BetterSqlite3.Database;

export type SearchKind = 'company_domain' | 'domain_emails' | 'careers_page' | 'hiring_posts' | 'jobs_site' | 'linkedin_people';
export interface SearchResult { title: string; snippet: string; url: string }
export interface SearchProvider {
  id: 'browser-dork' | 'serper' | 'google_pse' | 'tavily';
  search(q: string, o: { kind: SearchKind }): Promise<{ results: SearchResult[]; blocked?: boolean }>;
}
export type { DorkParams } from './dork.js';

export interface SearchDeps {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** The browser-dork provider (Task 7 engine). Absent: dorking is skipped. */
  dork?: SearchProvider;
  /** Override for tests; default is built from SERPER_API_KEY. */
  serper?: SearchProvider;
  /** Layered callers (linkedin_find_profiles) run one layer at a time: skip the browser dork or Serper. */
  google_pse?: SearchProvider;
  tavily?: SearchProvider;
  skip?: { dork?: boolean; serper?: boolean; google_pse?: boolean; tavily?: boolean };
}

export interface SearchOutcome {
  results: SearchResult[];
  provider: string | 'cache' | 'none';
  reason?: string;
}

function clean(results: SearchResult[]): SearchResult[] {
  return results
    .filter((r) => r && typeof r.url === 'string')
    .map((r) => ({ title: String(r.title ?? ''), snippet: String(r.snippet ?? ''), url: r.url }));
}

export async function searchWithBudget(db: Db, kind: SearchKind, params: DorkParams, deps: SearchDeps = {}): Promise<SearchOutcome> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const cfg = loadSearchConfig(env);

  let q: string;
  try {
    q = buildDork(kind, params);
  } catch {
    return { results: [], provider: 'none', reason: 'invalid_params' };
  }
  const qhash = queryHash(kind, q);
  const hit = cacheGet(db, qhash, cfg.cacheTtlDays, now);
  if (hit) return { results: hit.results as SearchResult[], provider: 'cache' };

  const reasons: string[] = [];

  if (deps.skip?.dork) reasons.push('dork_skipped');
  else if (!cfg.dorkEnabled) reasons.push('dork_disabled');
  else if (!deps.dork) reasons.push('dork_unavailable');
  else if (cooldownUntil(db, 'browser-dork', now)) reasons.push('dork_cooldown');
  else {
    recordUsage(db, 'browser-dork', now);
    let out: { results: SearchResult[]; blocked?: boolean } | null = null;
    try {
      out = await deps.dork.search(q, { kind });
    } catch {
      out = null;
    }
    if (out?.blocked) {
      startCooldown(db, 'browser-dork', cfg.dorkBlockCooldownHours, now);
      reasons.push('dork_blocked');
    } else if (out) {
      const results = clean(out.results);
      if (results.length > 0) {
        cachePut(db, qhash, 'browser-dork', kind, results, now);
        return { results, provider: 'browser-dork' };
      }
      reasons.push('dork_empty');
    } else reasons.push('dork_error');
  }

  // API providers after the browser dork: google_pse, tavily, serper. In a layered call (deps.skip set) a missing
  // key is reported; in the implicit chain google_pse and tavily are silent when unkeyed.
  const layered = deps.skip !== undefined;
  const pseKey = (env.GOOGLE_PSE_API_KEY ?? '').trim();
  const pseCx = (env.GOOGLE_PSE_CX ?? '').trim();
  const tavKey = (env.TAVILY_API_KEY ?? '').trim();
  const serKey = (env.SERPER_API_KEY ?? '').trim();
  const chain: Array<{
    id: 'google_pse' | 'tavily' | 'serper'; skipped: boolean; prov?: SearchProvider; noKey: string; daily: number; monthly?: number; always: boolean;
  }> = [
    { id: 'google_pse', skipped: !!deps.skip?.google_pse, prov: deps.google_pse ?? (pseKey && pseCx ? createGooglePseProvider(pseKey, pseCx) : undefined), noKey: 'no_google_pse_key', daily: cfg.googlePseDaily, always: false },
    { id: 'tavily', skipped: !!deps.skip?.tavily, prov: deps.tavily ?? (tavKey ? createTavilyProvider(tavKey) : undefined), noKey: 'no_tavily_key', daily: cfg.tavilyDaily, always: false },
    { id: 'serper', skipped: !!deps.skip?.serper, prov: deps.serper ?? (serKey ? createSerperProvider(serKey) : undefined), noKey: 'no_serper_key', daily: cfg.serperDaily, monthly: cfg.serperMonthly, always: true },
  ];
  let last: SearchOutcome | null = null;
  for (const c of chain) {
    if (c.skipped) { if (c.id === 'serper' || layered) reasons.push(`${c.id}_skipped`); continue; }
    if (!c.prov) { if (c.always || layered) reasons.push(c.noKey); continue; }
    if (usageToday(db, c.id, now) >= c.daily) { reasons.push(`${c.id}_daily_budget`); continue; }
    if (c.monthly !== undefined && usageMonth(db, c.id, now) >= c.monthly) { reasons.push(`${c.id}_monthly_budget`); continue; }
    recordUsage(db, c.id, now);
    let pOut: { results: SearchResult[] } = { results: [] };
    let err = false;
    try {
      pOut = await c.prov.search(q, { kind });
    } catch {
      err = true;
    }
    const results = clean(pOut.results);
    if (results.length > 0) cachePut(db, qhash, c.id, kind, results, now);
    const rs = err ? [...reasons, `${c.id}_error`] : reasons;
    last = { results, provider: c.id, ...(rs.length ? { reason: rs.join(',') } : {}) };
    if (results.length > 0) return last;
    if (err) reasons.push(`${c.id}_error`);
  }
  if (last) return last;
  return { results: [], provider: 'none', reason: reasons.join(',') };
}

export interface SearchStatus {
  dork: { enabled: boolean; today: number; cooldownUntil: string | null };
  google_pse: { keySet: boolean; today: number; dailyBudget: number };
  tavily: { keySet: boolean; today: number; dailyBudget: number };
  serper: { keySet: boolean; today: number; dailyBudget: number; month: number; monthlyBudget: number };
  cacheTtlDays: number;
}

/** Numbers for the doctor and status output. Never includes the key. */
export function searchStatus(db: Db, deps: SearchDeps = {}): SearchStatus {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const cfg: SearchConfig = loadSearchConfig(env);
  const cd = cooldownUntil(db, 'browser-dork', now);
  return {
    dork: { enabled: cfg.dorkEnabled, today: usageToday(db, 'browser-dork', now), cooldownUntil: cd ? cd.toISOString() : null },
    google_pse: { keySet: (env.GOOGLE_PSE_API_KEY ?? '').trim() !== '' && (env.GOOGLE_PSE_CX ?? '').trim() !== '', today: usageToday(db, 'google_pse', now), dailyBudget: cfg.googlePseDaily },
    tavily: { keySet: (env.TAVILY_API_KEY ?? '').trim() !== '', today: usageToday(db, 'tavily', now), dailyBudget: cfg.tavilyDaily },
    serper: {
      keySet: (env.SERPER_API_KEY ?? '').trim() !== '',
      today: usageToday(db, 'serper', now),
      dailyBudget: cfg.serperDaily,
      month: usageMonth(db, 'serper', now),
      monthlyBudget: cfg.serperMonthly,
    },
    cacheTtlDays: cfg.cacheTtlDays,
  };
}
