// Dork engine (plan 8G task 7): runs a built dork through Google, then DuckDuckGo HTML, then Bing HTML,
// all through the shared web runtime (patchright + installed Chrome; never a direct launch). A block
// page (CAPTCHA, unusual traffic) puts that engine on cooldown and moves to the next one; when every
// engine is blocked the caller gets `blocked: true` (the search layer then starts the provider cooldown
// and falls through to Serper). Nothing is solved, clicked or waited out.
import type BetterSqlite3 from 'better-sqlite3';
import type { WebRuntime } from '../webcore/runtime.js';
import { loadSearchConfig, cooldownUntil, startCooldown } from '../search/budget.js';
import type { DorkExecutor } from '../search/dork.js';
import type { SearchResult } from '../search/index.js';
import { ANCHORS_SCRIPT, type RawAnchorPage } from './page.js';
import { ENGINES, parseSerp, type EngineDef } from './serp.js';

export interface EngineDeps {
  runtime: WebRuntime;
  db: BetterSqlite3.Database;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  engines?: readonly EngineDef[];
  /** Receives every result URL (the scout registers them as navigable). */
  onResults?: (results: SearchResult[]) => void;
}

const cooldownKey = (id: string): string => `dork-engine:${id}`;

export function createScoutEngine(d: EngineDeps): DorkExecutor {
  const env = d.env ?? process.env;
  const now = d.now ?? (() => new Date());
  const engines = d.engines ?? ENGINES;
  return async (q) => {
    const cfg = loadSearchConfig(env);
    let blockedOrCooling = 0;
    try {
      for (const e of engines) {
        if (cooldownUntil(d.db, cooldownKey(e.id), now())) { blockedOrCooling++; continue; }
        const nav = await d.runtime.open(e.url(q), { allowedHosts: [e.host], jobId: 'dork' });
        if (!nav.ok) {
          if (nav.code === 'halted') return { results: [] };
          continue;
        }
        let raw: RawAnchorPage | null = null;
        try {
          raw = await d.runtime.serial(async () => d.runtime.page()?.evaluate<RawAnchorPage>(ANCHORS_SCRIPT) ?? null);
        } catch { raw = null; }
        if (!raw) continue;
        const out = parseSerp(raw);
        if (out.blocked) {
          blockedOrCooling++;
          startCooldown(d.db, cooldownKey(e.id), cfg.dorkBlockCooldownHours, now());
          continue;
        }
        if (out.results.length > 0) {
          d.onResults?.(out.results);
          return { results: out.results };
        }
      }
    } finally {
      await d.runtime.close().catch(() => undefined);
    }
    return { results: [], ...(blockedOrCooling >= engines.length ? { blocked: true } : {}) };
  };
}
