// Browser-dork provider for the `contacts` MCP server (finding 7): cache -> dork -> Serper.
// The web runtime (patchright + installed Chrome through launchRealChrome, locked headless session) is
// created on the first search that misses the cache, and the scout engine closes it after every query,
// also when it throws (src/scout/engine.ts `finally`). Gating (DORK_ENABLED, DORK_DAILY_BUDGET, the block
// cooldown) stays in searchWithBudget; a search is a read, so dry-run flags do not stop it (same as
// scout_search). If another session holds the web lock the engine gets `session_locked`, returns no
// results and the ladder falls through to Serper.
// Live-unverified: never run against a real search engine or inside a real wake.
import type BetterSqlite3 from 'better-sqlite3';
import { createWebRuntime, type WebRuntime, type WebRuntimeDeps } from '../webcore/runtime.js';
import { createScoutEngine } from '../scout/engine.js';
import { ENGINES, type EngineDef } from '../scout/serp.js';
import { createBrowserDorkProvider } from './dork.js';
import type { SearchProvider } from './index.js';

// People lookups use the owner-chosen engine order: Google, then DuckDuckGo HTML, then Bing. The scout engine
// already puts a blocked engine (CAPTCHA, unusual traffic) on a DORK_BLOCK_COOLDOWN_HOURS cooldown, never
// solves or waits it out, and moves to the next engine.
export const PEOPLE_ENGINES: readonly EngineDef[] = ENGINES;

export type ContactsDorkDeps = { db: BetterSqlite3.Database; runtime?: WebRuntime; engines?: readonly EngineDef[] } & Omit<WebRuntimeDeps, 'db'>;

export function createContactsDork(d: ContactsDorkDeps): SearchProvider {
  let runtime: WebRuntime | null = d.runtime ?? null;
  return createBrowserDorkProvider(() => {
    runtime ??= createWebRuntime({ db: d.db, env: d.env, now: d.now, launcher: d.launcher, lockPath: d.lockPath, sessionDir: d.sessionDir, config: d.config, sleep: d.sleep, random: d.random, idleMs: d.idleMs });
    return createScoutEngine({ runtime, db: d.db, env: d.env, now: d.now, ...(d.engines ? { engines: d.engines } : {}) });
  });
}
