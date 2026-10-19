// Finding 7: the contacts server's browser dork (cache -> dork -> Serper). Hermetic: fake browser, no network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createContactsDork } from '../src/search/contactsDork.js';
import { searchWithBudget, type SearchProvider } from '../src/search/index.js';
import { buildDork } from '../src/search/dork.js';
import { cachePut, cooldownUntil, queryHash, usageToday } from '../src/search/budget.js';
import { resolveDomainForJob } from '../src/search/ladder.js';
import { createScoutBrowser } from './helpers/fakeScoutBrowser.js';
import type { LiBrowser, LiLauncher } from '../src/linkedin/types.js';

const NOW = new Date('2026-10-19T10:00:00Z');
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-cdork-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const everyPage = (fixture: string) => new Proxy({}, { get: () => fixture, has: () => true }) as Record<string, string>;

function setup(fixture: string, env: Record<string, string | undefined> = {}) {
  const db = openDb(':memory:');
  const browser = createScoutBrowser(everyPage(fixture));
  let closes = 0;
  const launcher: LiLauncher = {
    async launch(o) {
      const b = await browser.launcher.launch(o);
      return { ...b, close: async () => { closes++; await b.close(); } } as LiBrowser;
    },
  };
  const e = { SERPER_API_KEY: 'k', ...env };
  const dork = createContactsDork({ db, env: e, now: () => NOW, launcher, lockPath: path.join(dir, 'l.lock'), sessionDir: path.join(dir, 's'), config: { minGapSec: 0, settleMs: 0 } });
  const serperCalls: string[] = [];
  const serper: SearchProvider = { id: 'serper', async search(q) { serperCalls.push(q); return { results: [{ title: 't', snippet: 's', url: 'https://serper-found.io/' }] }; } };
  const deps = { env: e, now: () => NOW, dork, serper };
  return { db, browser, deps, serperCalls, closes: () => closes };
}

const P = { domain: 'acme.io' };

describe('contacts browser dork', () => {
  it('is lazy: a cache hit never launches a browser', async () => {
    const s = setup('serp-ok.html');
    const q = buildDork('careers_page', P);
    cachePut(s.db, queryHash('careers_page', q), 'serper', 'careers_page', [{ title: 't', snippet: 's', url: 'https://cached.io/' }], NOW);
    const out = await searchWithBudget(s.db, 'careers_page', P, s.deps);
    expect(out.provider).toBe('cache');
    expect(s.browser.launches).toBe(0);
    expect(s.serperCalls).toHaveLength(0);
  });

  it('a cache miss dorks first, closes the browser after use and never reaches Serper', async () => {
    const s = setup('serp-ok.html');
    const out = await searchWithBudget(s.db, 'careers_page', P, s.deps);
    expect(out.provider).toBe('browser-dork');
    expect(out.results.length).toBeGreaterThan(0);
    expect(s.browser.launches).toBe(1);
    expect(s.closes()).toBe(1);
    expect(s.serperCalls).toHaveLength(0);
    expect(usageToday(s.db, 'browser-dork', NOW)).toBe(1);
  });

  it('a browser launch failure falls through to Serper and leaves no lock behind', async () => {
    const s = setup('serp-ok.html');
    const failing: LiLauncher = { async launch() { throw new Error('boom'); } };
    const dork = createContactsDork({ db: s.db, env: s.deps.env, now: () => NOW, launcher: failing, lockPath: path.join(dir, 'l2.lock'), sessionDir: path.join(dir, 's2'), config: { minGapSec: 0, settleMs: 0 } });
    const out = await searchWithBudget(s.db, 'careers_page', P, { ...s.deps, dork });
    expect(out.provider).toBe('serper');
    expect(s.serperCalls).toHaveLength(1);
    // the lock was released (a second attempt is not session_locked)
    const again = await searchWithBudget(s.db, 'jobs_site', { role: 'react', company: 'Acme' }, { ...s.deps, dork });
    expect(again.reason ?? '').not.toContain('session_locked');
  });

  it('DORK_ENABLED=false: no browser, Serper answers', async () => {
    const s = setup('serp-ok.html', { DORK_ENABLED: 'false' });
    const out = await searchWithBudget(s.db, 'careers_page', P, s.deps);
    expect(out.provider).toBe('serper');
    expect(out.reason).toContain('dork_disabled');
    expect(s.browser.launches).toBe(0);
  });

  it('daily dork budget exhausted: no browser, Serper answers', async () => {
    const s = setup('serp-ok.html', { DORK_DAILY_BUDGET: '0' });
    const out = await searchWithBudget(s.db, 'careers_page', P, s.deps);
    expect(out.provider).toBe('serper');
    expect(out.reason).toContain('dork_budget');
    expect(s.browser.launches).toBe(0);
  });

  it('dry run: a search is a read, so the dork still runs (same as scout_search)', async () => {
    const s = setup('serp-ok.html', { SCHEDULER_DRY_RUN: 'true', WEB_DRY_RUN: 'true', SCOUT_DRY_RUN: 'true' });
    const out = await searchWithBudget(s.db, 'careers_page', P, s.deps);
    expect(out.provider).toBe('browser-dork');
    expect(s.closes()).toBe(1);
  });

  it('all engines blocked: provider cooldown starts, the browser is closed, Serper answers, next query skips the browser', async () => {
    const s = setup('serp-blocked.html');
    const out = await searchWithBudget(s.db, 'careers_page', P, s.deps);
    expect(out.provider).toBe('serper');
    expect(out.reason).toContain('dork_blocked');
    expect(cooldownUntil(s.db, 'browser-dork', NOW)).not.toBeNull();
    expect(s.closes()).toBe(s.browser.launches);
    const launches = s.browser.launches;
    const next = await searchWithBudget(s.db, 'jobs_site', { role: 'react', company: 'Acme' }, s.deps);
    expect(next.reason).toContain('dork_cooldown');
    expect(s.browser.launches).toBe(launches);
  });

  it('the domain ladder (resolveDomainForJob) uses the dork before Serper', async () => {
    const s = setup('serp-ok.html');
    const r = await resolveDomainForJob(s.db, { company: 'Example Role' }, s.deps);
    expect(r.ladder.domain_source).toBe('search');
    expect(s.serperCalls).toHaveLength(0);
    expect(s.browser.launches).toBe(1);
  });
});
