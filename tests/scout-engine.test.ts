import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createWebRuntime, type WebRuntime } from '../src/webcore/runtime.js';
import { createScoutEngine } from '../src/scout/engine.js';
import { parseSerp, unwrapResultUrl, ENGINES } from '../src/scout/serp.js';
import { createBrowserDorkProvider } from '../src/search/dork.js';
import { searchWithBudget, type SearchProvider } from '../src/search/index.js';
import { cooldownUntil } from '../src/search/budget.js';
import { anchorSnapshotFromHtml, createScoutBrowser } from './helpers/fakeScoutBrowser.js';

let dir: string;
let rt: WebRuntime | null = null;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-scout-')); });
afterEach(async () => { await rt?.close(); rt = null; fs.rmSync(dir, { recursive: true, force: true }); });

const Q = 'site:example.com careers';
const urlOf = (id: string) => ENGINES.find((e) => e.id === id)!.url(Q);

function setup(pages: Record<string, string>) {
  const db = openDb(':memory:');
  const browser = createScoutBrowser(pages);
  rt = createWebRuntime({ db, launcher: browser.launcher, lockPath: path.join(dir, 'l.lock'), sessionDir: path.join(dir, 's'), config: { minGapSec: 0, settleMs: 0 } });
  return { db, browser, runtime: rt };
}

describe('SERP parsing', () => {
  it('serp-ok.html parses three results with titles, snippets and URLs', () => {
    const out = parseSerp(anchorSnapshotFromHtml('serp-ok.html', 'https://www.bing.com/search?q=x'));
    expect(out.blocked).toBe(false);
    if (out.blocked) return;
    expect(out.results.map((r) => r.url)).toEqual(['https://example.com/jobs/1', 'https://example.org/careers/2', 'https://example.net/jobs/3']);
    expect(out.results[0]).toMatchObject({ title: 'Example Role 1', snippet: 'Snippet one' });
  });
  it('serp-blocked.html is a block', () => {
    const out = parseSerp(anchorSnapshotFromHtml('serp-blocked.html', 'https://www.google.com/search?q=x'));
    expect(out).toMatchObject({ blocked: true, block: 'bot_wall' });
  });
  it('unwraps engine redirects and drops engine, non-http and credential URLs', () => {
    expect(unwrapResultUrl('https://www.google.com/url?q=https%3A%2F%2Facme.io%2Fjobs&sa=U')).toBe('https://acme.io/jobs');
    expect(unwrapResultUrl('https://duckduckgo.com/l/?uddg=https%3A%2F%2Facme.io%2Fc')).toBe('https://acme.io/c');
    expect(unwrapResultUrl('https://www.google.com/search?q=x')).toBeNull();
    expect(unwrapResultUrl('javascript:alert(1)')).toBeNull();
    expect(unwrapResultUrl('https://u:p@acme.io/x')).toBeNull();
  });
});

describe('dork engine', () => {
  it('a blocked first engine puts it on cooldown and the next engine answers', async () => {
    const s = setup({ [urlOf('google')]: 'serp-blocked.html', [urlOf('duckduckgo')]: 'serp-ok.html' });
    const exec = createScoutEngine({ runtime: s.runtime, db: s.db });
    const out = await exec(Q, { kind: 'careers_page' });
    expect(out.blocked).toBeUndefined();
    expect(out.results).toHaveLength(3);
    expect(s.browser.gotos).toEqual([urlOf('google'), urlOf('duckduckgo')]);
    expect(cooldownUntil(s.db, 'dork-engine:google', new Date())).not.toBeNull();
    expect(cooldownUntil(s.db, 'dork-engine:duckduckgo', new Date())).toBeNull();
    // the cooling engine is skipped on the next query
    s.browser.gotos.length = 0;
    await createScoutEngine({ runtime: s.runtime, db: s.db })(Q, { kind: 'careers_page' });
    expect(s.browser.gotos).toEqual([urlOf('duckduckgo')]);
  });

  it('all engines blocked: blocked to the caller, then the search layer cools the provider and uses Serper', async () => {
    // the dork the search layer builds is not Q: every engine URL serves the blocked page
    const s = setup(new Proxy({}, { get: () => 'serp-blocked.html', has: () => true }) as Record<string, string>);
    const dork = createBrowserDorkProvider(() => createScoutEngine({ runtime: s.runtime, db: s.db }));
    let serperCalls = 0;
    const serper: SearchProvider = { id: 'serper', async search() { serperCalls++; return { results: [{ title: 't', snippet: 's', url: 'https://acme.io/careers' }] }; } };
    const out = await searchWithBudget(s.db, 'careers_page', { domain: 'acme.io' }, { env: { SERPER_API_KEY: 'k' }, dork, serper });
    expect(out.provider).toBe('serper');
    expect(serperCalls).toBe(1);
    expect(s.browser.gotos).toHaveLength(3);
    expect(cooldownUntil(s.db, 'browser-dork', new Date())).not.toBeNull();
  });

  it('a navigation failure moves on, and an empty page returns no results without blocked', async () => {
    const s = setup({});
    const out = await createScoutEngine({ runtime: s.runtime, db: s.db })(Q, { kind: 'careers_page' });
    expect(out).toEqual({ results: [] });
  });
});
