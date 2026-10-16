// Search abstraction (plan 8G task 3): cache -> browser-dork (budget, block cooldown) -> Serper (daily and
// monthly budget). Every provider call is counted. Search results are untrusted text.
import type BetterSqlite3 from 'better-sqlite3';
import {
  cacheGet, cachePut, cooldownUntil, loadSearchConfig, queryHash, recordUsage, startCooldown, usageMonth, usageToday,
  type SearchConfig,
} from './budget.js';
import { buildDork, type DorkParams } from './dork.js';
import { createSerperProvider } from './serper.js';

type Db = BetterSqlite3.Database;

export type SearchKind = 'company_domain' | 'domain_emails' | 'careers_page' | 'hiring_posts' | 'jobs_site';
export interface SearchResult { title: string; snippet: string; url: string }
export interface SearchProvider {
  id: 'browser-dork' | 'serper';
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

  if (!cfg.dorkEnabled) reasons.push('dork_disabled');
  else if (!deps.dork) reasons.push('dork_unavailable');
  else if (cooldownUntil(db, 'browser-dork', now)) reasons.push('dork_cooldown');
  else if (usageToday(db, 'browser-dork', now) >= cfg.dorkDaily) reasons.push('dork_budget');
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

  const key = (env.SERPER_API_KEY ?? '').trim();
  const serper = deps.serper ?? (key ? createSerperProvider(key) : undefined);
  if (!serper) return { results: [], provider: 'none', reason: [...reasons, 'no_serper_key'].join(',') };
  if (usageToday(db, 'serper', now) >= cfg.serperDaily) return { results: [], provider: 'none', reason: [...reasons, 'serper_daily_budget'].join(',') };
  if (usageMonth(db, 'serper', now) >= cfg.serperMonthly) return { results: [], provider: 'none', reason: [...reasons, 'serper_monthly_budget'].join(',') };
  recordUsage(db, 'serper', now);
  let sOut: { results: SearchResult[] } = { results: [] };
  let serperErr = false;
  try {
    sOut = await serper.search(q, { kind });
  } catch {
    serperErr = true;
  }
  const results = clean(sOut.results);
  if (results.length > 0) cachePut(db, qhash, 'serper', kind, results, now);
  const rs = serperErr ? [...reasons, 'serper_error'] : reasons;
  return { results, provider: 'serper', ...(rs.length ? { reason: rs.join(',') } : {}) };
}

export interface SearchStatus {
  dork: { enabled: boolean; today: number; dailyBudget: number; cooldownUntil: string | null };
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
    dork: { enabled: cfg.dorkEnabled, today: usageToday(db, 'browser-dork', now), dailyBudget: cfg.dorkDaily, cooldownUntil: cd ? cd.toISOString() : null },
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
