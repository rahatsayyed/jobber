// Browser-dork provider for the `contacts` MCP server (finding 7): cache -> dork -> Serper.
// The web runtime (patchright + installed Chrome through launchRealChrome, locked headless session) is
// created on the first search that misses the cache, and the scout engine closes it after every query,
// also when it throws (src/scout/engine.ts `finally`). Gating (DORK_ENABLED, the block
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

// Owner order (2026-11-02): Google first, Bing and DuckDuckGo stay as fallbacks (a Google page with no usable
// profile URLs falls through to the next layer). The note below is the earlier measurement. People lookups need the real profile URL of each hit. Measured live (2026-11-02): Bing returns its results as
// /ck/a?u=a1<base64url> links that unwrapResultUrl decodes; Google now wraps every result in an opaque, encrypted
// /goto?url= token (the target URL is not in the page at all) and walls us after a few queries; DuckDuckGo shows a
// bot check. So Bing goes first, then DuckDuckGo, and Google stays last (it may still show direct links to some
// users). The scout engine puts a blocked engine (CAPTCHA, unusual traffic) on a DORK_BLOCK_COOLDOWN_HOURS
// cooldown, never solves or waits it out, and moves to the next engine.
const byId = (id: EngineDef['id']): EngineDef => ENGINES.find((e) => e.id === id)!;
export const PEOPLE_ENGINES: readonly EngineDef[] = [byId('google'), byId('bing'), byId('duckduckgo')];

export type ContactsDorkDeps = { db: BetterSqlite3.Database; runtime?: WebRuntime; engines?: readonly EngineDef[] } & Omit<WebRuntimeDeps, 'db'>;

export function createContactsDork(d: ContactsDorkDeps): SearchProvider {
  let runtime: WebRuntime | null = d.runtime ?? null;
  return createBrowserDorkProvider(() => {
    runtime ??= createWebRuntime({ db: d.db, env: d.env, now: d.now, launcher: d.launcher, lockPath: d.lockPath, sessionDir: d.sessionDir, config: d.config, sleep: d.sleep, random: d.random, idleMs: d.idleMs });
    return createScoutEngine({ runtime, db: d.db, env: d.env, now: d.now, ...(d.engines ? { engines: d.engines } : {}) });
  });
}
