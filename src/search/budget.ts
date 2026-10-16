// Search usage counters, result cache and dork block cooldown (plan 8G task 3). All in SQLite.
import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export interface SearchConfig {
  dorkEnabled: boolean;
  dorkBlockCooldownHours: number;
  cacheTtlDays: number;
  serperDaily: number;
  serperMonthly: number;
  dorkDaily: number;
}

function int(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '' || !/^\d+$/.test(raw.trim())) return def;
  const n = Number(raw.trim());
  return n >= min && n <= max ? n : def;
}

export function loadSearchConfig(env: Record<string, string | undefined>): SearchConfig {
  return {
    dorkEnabled: (env.DORK_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    dorkBlockCooldownHours: int(env.DORK_BLOCK_COOLDOWN_HOURS, 24, 0, 720),
    cacheTtlDays: int(env.SEARCH_CACHE_TTL_DAYS, 14, 0, 365),
    serperDaily: int(env.SERPER_DAILY_BUDGET, 20, 0, 100000),
    serperMonthly: int(env.SERPER_MONTHLY_BUDGET, 200, 0, 1000000),
    dorkDaily: int(env.DORK_DAILY_BUDGET, 30, 0, 100000),
  };
}

export const dayKey = (now: Date): string => now.toISOString().slice(0, 10);

export function recordUsage(db: Db, provider: string, now: Date): void {
  db.prepare(
    `INSERT INTO search_usage (day, provider, count) VALUES (?, ?, 1)
     ON CONFLICT(day, provider) DO UPDATE SET count = count + 1`,
  ).run(dayKey(now), provider);
}

export function usageToday(db: Db, provider: string, now: Date): number {
  const r = db.prepare('SELECT count FROM search_usage WHERE day = ? AND provider = ?').get(dayKey(now), provider) as
    | { count: number }
    | undefined;
  return r?.count ?? 0;
}

export function usageMonth(db: Db, provider: string, now: Date): number {
  const month = dayKey(now).slice(0, 7);
  const r = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS n FROM search_usage WHERE provider = ? AND substr(day, 1, 7) = ?')
    .get(provider, month) as { n: number };
  return r.n;
}

export function queryHash(kind: string, query: string): string {
  return createHash('sha256').update(`${kind}\n${query}`).digest('hex');
}

export function cacheGet(db: Db, qhash: string, ttlDays: number, now: Date): { results: unknown[] } | null {
  if (ttlDays <= 0) return null;
  const r = db.prepare("SELECT result, at FROM search_cache WHERE qhash = ? AND kind != 'cooldown'").get(qhash) as
    | { result: string; at: string }
    | undefined;
  if (!r) return null;
  if (now.getTime() - new Date(r.at).getTime() > ttlDays * 86400_000) return null;
  try {
    const parsed = JSON.parse(r.result);
    return Array.isArray(parsed) ? { results: parsed } : null;
  } catch {
    return null;
  }
}

export function cachePut(db: Db, qhash: string, provider: string, kind: string, results: unknown[], now: Date): void {
  db.prepare(
    `INSERT INTO search_cache (qhash, provider, kind, result, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(qhash) DO UPDATE SET provider = excluded.provider, kind = excluded.kind, result = excluded.result, at = excluded.at`,
  ).run(qhash, provider, kind, JSON.stringify(results), now.toISOString());
}

const COOLDOWN_KEY = (provider: string) => `cooldown:${provider}`;

export function startCooldown(db: Db, provider: string, hours: number, now: Date): void {
  const until = new Date(now.getTime() + hours * 3600_000).toISOString();
  db.prepare(
    `INSERT INTO search_cache (qhash, provider, kind, result, at) VALUES (?, ?, 'cooldown', ?, ?)
     ON CONFLICT(qhash) DO UPDATE SET result = excluded.result, at = excluded.at`,
  ).run(COOLDOWN_KEY(provider), provider, JSON.stringify(until), now.toISOString());
}

export function cooldownUntil(db: Db, provider: string, now: Date): Date | null {
  const r = db.prepare('SELECT result FROM search_cache WHERE qhash = ?').get(COOLDOWN_KEY(provider)) as
    | { result: string }
    | undefined;
  if (!r) return null;
  try {
    const d = new Date(JSON.parse(r.result) as string);
    return d.getTime() > now.getTime() ? d : null;
  } catch {
    return null;
  }
}
