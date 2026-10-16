import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createWebRuntime, type WebRuntime } from '../src/webcore/runtime.js';
import { createBrowserTextFetcher } from '../src/sources/generated/browser.js';
import { createGeneratedProvider } from '../src/sources/generated/engine.js';
import { specSchema } from '../src/sources/generated/spec.js';
import { approveProvider, getProvider, proposeProvider, recordProviderRun } from '../src/sources/generated/store.js';
import { run as providersCli } from '../scripts/providers.js';
import { runScriptSources } from '../src/sources/runner.js';
import { createScoutBrowser } from './helpers/fakeScoutBrowser.js';
import { baseSpec, BASE_URL } from './helpers/genSpec.js';

const LISTING = readFileSync('tests/fixtures/web/listing-a.html', 'utf8');
const NOW = new Date('2026-10-16T10:00:00Z');
let dir: string;
let rt: WebRuntime | null = null;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'jobber-genb-')); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(async () => { vi.restoreAllMocks(); await rt?.close(); rt = null; rmSync(dir, { recursive: true, force: true }); });

function runtimeFor(pages: Record<string, string>, redirects: Record<string, string> = {}) {
  const browser = createScoutBrowser(pages, redirects);
  rt = createWebRuntime({ db: openDb(':memory:'), launcher: browser.launcher, lockPath: path.join(dir, 'l.lock'), sessionDir: path.join(dir, 's'), config: { minGapSec: 0, settleMs: 0 } });
  return { browser, rt };
}
const spec = () => specSchema.parse(baseSpec());

describe('browser text fetcher', () => {
  it('loads the page through the shared runtime and returns the sanitised html', async () => {
    const { browser, rt } = runtimeFor({ [BASE_URL]: LISTING });
    const html = await createBrowserTextFetcher(rt, spec())(BASE_URL);
    expect(html).toContain('Frontend Engineer');
    expect(browser.gotos).toEqual([BASE_URL]);
    const r = await createGeneratedProvider(spec(), createBrowserTextFetcher(rt, spec())).fetch({});
    expect(r.jobs).toHaveLength(3);
  });

  it('rejects a redirect off the spec hosts (final URL check)', async () => {
    const { rt } = runtimeFor({ 'https://evil.example.test/jobs': LISTING }, { [BASE_URL]: 'https://evil.example.test/jobs' });
    await expect(createBrowserTextFetcher(rt, spec())(BASE_URL)).rejects.toThrow();
  });
});

describe('runner uses the browser for html_list by default', () => {
  it('a validated html_list provider with no injected fetcher loads through the web runtime', async () => {
    const db = openDb(':memory:');
    const fx = path.join(dir, 'fixtures', 'acme');
    mkdirSync(fx, { recursive: true });
    writeFileSync(path.join(fx, 'a.html'), LISTING);
    expect(proposeProvider(db, dir, baseSpec(), { minJobs: 3, now: NOW }).state).toBe('validated');
    const portals = path.join(dir, 'p.json');
    writeFileSync(portals, JSON.stringify({ tracked_companies: [], title_filter: { positive: ['engineer'], negative: [] }, location_filter: { allow: ['india'] } }));
    const reg = path.join(dir, 'r.json');
    writeFileSync(reg, JSON.stringify({ platforms: [] }));
    // html_list must use the injected web runtime (fake browser), never the plain fetch transport.
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const { browser, rt } = runtimeFor({ [BASE_URL]: LISTING });
    const r = await runScriptSources(db, { role: 'x', portalsPath: portals, registryPath: reg, generatedRoot: dir, runId: 'r1', env: {}, webRuntime: rt });
    vi.unstubAllGlobals();
    expect(f).not.toHaveBeenCalled();
    expect(browser.gotos).toEqual([BASE_URL]);
    expect(r.rows.find((x) => x.source === 'gen:acme')).toMatchObject({ fetched: 3, kept: 2 });
  });
});

describe('approval needs trusted unless forced', () => {
  const setup = () => {
    const db = openDb(':memory:');
    const fx = path.join(dir, 'fixtures', 'acme');
    mkdirSync(fx, { recursive: true });
    writeFileSync(path.join(fx, 'a.html'), LISTING);
    proposeProvider(db, dir, baseSpec(), { minJobs: 3, now: NOW });
    return db;
  };
  it('validated is refused without force, trusted is approved', () => {
    const db = setup();
    expect(approveProvider(db, 'acme', NOW)).toMatchObject({ ok: false, code: 'not_trusted' });
    expect(getProvider(db, 'acme')!.approved).toBe(0);
    for (const id of ['r1', 'r2', 'r3']) recordProviderRun(db, 'acme', { runId: id, clean: true, promoteN: 3, now: NOW });
    expect(approveProvider(db, 'acme', NOW)).toMatchObject({ ok: true });
  });
  it('the CLI refuses without --force, and --force approves with a warning', () => {
    const db = setup();
    const deps = { db, root: dir, now: () => NOW, env: {} };
    const no = providersCli(['approve', 'acme'], deps);
    expect(no.code).toBe(1);
    expect(no.lines[0]).toContain('not_trusted');
    expect(getProvider(db, 'acme')!.approved).toBe(0);
    const yes = providersCli(['approve', 'acme', '--force'], deps);
    expect(yes.code).toBe(0);
    expect(yes.lines[0]).toMatch(/^WARNING: acme is validated, not trusted/);
    expect(getProvider(db, 'acme')!.approved).toBe(1);
  });
});

describe('src/sources/generated imports no browser library', () => {
  it.each(readdirSync('src/sources/generated').filter((f) => f.endsWith('.ts')))('%s', (f) => {
    const src = readFileSync(path.join('src/sources/generated', f), 'utf8');
    expect(src).not.toMatch(/from\s+['"](playwright|patchright|puppeteer|playwright-core)[^'"]*['"]/);
    expect(src).not.toMatch(/launchRealChrome|chromium|launchPersistentContext/);
  });
});
