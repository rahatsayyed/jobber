// Doctor checks for discovery sources, search providers and generated providers (plan 8G-2 task 24).
// Registered in checkLists.ts. Offline and read-only; no check prints an env value or a key, only ids, counts and dates.
// Modules the 8G-1 branch adds later (generated providers) are tolerated as absent: the check then reports skip.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { skip } from './doctor.js';
import { parseEnv } from './envFile.js';
import { loadRegistry } from '../sources/registry.js';
import { BOARD_PROVIDERS } from '../sources/boards/providers.js';
import { FLAKY_STREAK } from '../sources/runner.js';
import { searchStatus } from '../search/index.js';
import { dbPath } from '../dbPath.js';

type Db = BetterSqlite3.Database;

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, fix?: string): CheckResult => ({ status: 'warn', detail, fix });
const fail = (detail: string, fix?: string): CheckResult => ({ status: 'fail', detail, fix });

const STALE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface SourcesCheckDeps {
  /** Read-only database handle; null or a throw means "no database". */
  db?: () => Db | null;
}

function defaultDb(): Db | null {
  try {
    const p = dbPath();
    if (p === ':memory:' || !existsSync(p)) return null;
    const Ctor = createRequire(import.meta.url)('better-sqlite3') as new (
      path: string, opts: { readonly: boolean; fileMustExist: boolean }) => Db;
    return new Ctor(p, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/** process env over .env, like the runner. Values are never printed. */
export function mergedEnv(ctx: DoctorContext): NodeJS.ProcessEnv {
  const file = join(ctx.root, '.env');
  let fromFile: Record<string, string> = {};
  try {
    if (ctx.fs.exists(file)) fromFile = parseEnv(ctx.fs.read(file));
  } catch {
    fromFile = {};
  }
  return { ...fromFile, ...ctx.env };
}

function withDb<T>(deps: SourcesCheckDeps, f: (db: Db) => T): T | null {
  let db: Db | null = null;
  try {
    db = (deps.db ?? defaultDb)();
    if (!db) return null;
    return f(db);
  } catch {
    return null;
  } finally {
    if (!deps.db) { try { db?.close(); } catch { /* already closed */ } }
  }
}

function hasTable(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function enabledTenantVendors(ctx: DoctorContext): { vendors: string[]; error?: string } {
  const p = join(ctx.root, 'config', 'portals.json');
  if (!ctx.fs.exists(p)) return { vendors: [] };
  try {
    const cfg = JSON.parse(ctx.fs.read(p)) as { tracked_companies?: Array<{ ats?: unknown; enabled?: unknown }> };
    const set = new Set<string>();
    for (const c of cfg.tracked_companies ?? []) if (c?.enabled === true && typeof c.ats === 'string') set.add(c.ats);
    return { vendors: [...set] };
  } catch {
    return { vendors: [], error: 'config/portals.json is not valid JSON' };
  }
}

export function sourcesChecks(deps: SourcesCheckDeps = {}): Check[] {
  return [
    {
      id: 'source_status',
      title: 'job sources: registry, providers and freshness',
      async run(ctx) {
        const { platforms, errors } = loadRegistry(join(ctx.root, 'config', 'platforms.json'));
        if (errors.length) return fail(`registry invalid: ${errors[0]!.slice(0, 160)}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`, 'fix config/platforms.json');
        const tenants = enabledTenantVendors(ctx);
        if (tenants.error) return fail(tenants.error, 'fix config/portals.json');
        const missing = tenants.vendors.filter((v) => !(v in BOARD_PROVIDERS));
        if (missing.length) return fail(`enabled tenant vendor without a provider: ${missing.join(', ')}`, 'set enabled to false or add the provider');
        const problems: string[] = [];
        for (const p of platforms) if (p.enabled && p.stability === 'flaky') problems.push(`${p.id} flaky`);
        const now = (ctx.now ?? (() => new Date()))().getTime();
        const enabled = new Set(platforms.filter((p) => p.enabled && p.tier === 'script').map((p) => p.id));
        withDb(deps, (db) => {
          if (!hasTable(db, 'platform_status')) return;
          const rows = db.prepare('SELECT id, last_run_at, streak_fail FROM platform_status').all() as Array<{ id: string; last_run_at: string | null; streak_fail: number }>;
          for (const r of rows) {
            if (!enabled.has(r.id)) continue;
            if (r.streak_fail >= FLAKY_STREAK) problems.push(`${r.id} flaky (${r.streak_fail} failed runs)`);
            else if (r.last_run_at && now - Date.parse(r.last_run_at) > STALE_DAYS * DAY_MS) problems.push(`${r.id} stale (last run over ${STALE_DAYS} days ago)`);
          }
        });
        const base = `${platforms.length} platforms, ${platforms.filter((p) => p.enabled).length} enabled, ${tenants.vendors.length} tenant vendors with a provider`;
        if (problems.length) return warn(`${base}; ${problems.join(', ')}`, 'npm run check-portal, or see source_status');
        return pass(base);
      },
    },
    {
      id: 'search_providers',
      title: 'search providers: dork and Serper budgets',
      async run(ctx) {
        const env = mergedEnv(ctx);
        const st = withDb(deps, (db) => searchStatus(db, { env, now: ctx.now }));
        if (!st) return skip('no database yet: search usage unknown');
        const now = (ctx.now ?? (() => new Date()))();
        const cooling = !!st.dork.cooldownUntil && Date.parse(st.dork.cooldownUntil) > now.getTime();
        const dorkOk = st.dork.enabled && !cooling && st.dork.today < st.dork.dailyBudget;
        const serperOk = st.serper.keySet && st.serper.today < st.serper.dailyBudget && st.serper.month < st.serper.monthlyBudget;
        const detail =
          `dork ${st.dork.enabled ? 'enabled' : 'disabled'}${st.dork.cooldownUntil ? `, blocked until ${st.dork.cooldownUntil}` : ''}, ${st.dork.today}/${st.dork.dailyBudget} today; ` +
          `Serper key ${st.serper.keySet ? 'present' : 'absent'}, ${st.serper.today}/${st.serper.dailyBudget} today, ${st.serper.month}/${st.serper.monthlyBudget} this month`;
        const emailOn = (env.SEND_LIMIT_PER_RUN ?? '1').trim() !== '0';
        if (!dorkOk && !serperOk && emailOn) return fail(`${detail}; both providers unavailable while the email channel is on`, 'set SERPER_API_KEY, or enable DORK_ENABLED and wait out the cooldown');
        const over = (a: number, b: number) => b > 0 && a / b > 0.8;
        const hot = st.serper.keySet && (over(st.serper.today, st.serper.dailyBudget) || over(st.serper.month, st.serper.monthlyBudget));
        if (hot) return warn(`${detail}; Serper over 80% of a budget`, 'raise SERPER_DAILY_BUDGET or SERPER_MONTHLY_BUDGET, or wait');
        if (cooling) return warn(`${detail}; dork in cooldown`);
        return pass(detail);
      },
    },
    {
      id: 'generated_providers',
      title: 'generated providers: validation and review queue',
      async run(ctx) {
        const rows = withDb(deps, (db) => {
          if (!hasTable(db, 'generated_providers')) return null;
          return db.prepare("SELECT state, COUNT(*) AS n, SUM(CASE WHEN reason IS NOT NULL THEN 1 ELSE 0 END) AS bad FROM generated_providers GROUP BY state").all() as Array<{ state: string; n: number; bad: number | null }>;
        });
        if (!rows) return skip('n/a: no generated_providers table or database');
        // A validated or trusted provider whose last validation left a reason (store.ts sets `reason` on a failed revalidation) is a failure.
        const failing = rows.filter((r) => (r.state === 'validated' || r.state === 'trusted') && (r.bad ?? 0) > 0);
        if (failing.length) return fail(`a validated or trusted provider fails validation (${failing.map((r) => `${r.state}: ${r.bad}`).join(', ')})`, 'revalidate or remove the provider: npm run providers');
        const waiting = rows.filter((r) => r.state === 'candidate').reduce((a, r) => a + r.n, 0);
        if (waiting > 0) return warn(`${waiting} candidate provider${waiting === 1 ? '' : 's'} waiting for validation or review`, 'npm run providers -- list');
        const total = rows.reduce((a, r) => a + r.n, 0);
        return pass(total === 0 ? 'none' : `${total} provider${total === 1 ? '' : 's'}, none failing validation`);
      },
    },
  ];
}
