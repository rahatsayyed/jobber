import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createRuntime, type Runtime } from '../src/linkedin/runtime.js';
import { buildSnapshotFromHtml } from '../src/linkedin/snapshot.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { haltPlatform } from '../src/outreach/limits.js';
import { buildHandlers, schemas, TOOL_NAMES } from '../src/mcp/linkedin.js';
import { searchJobs } from '../src/linkedin/searchJobs.js';
import { buildJobsSearchUrl, loadDiscoveryConfig, type DiscoveryConfig } from '../src/linkedin/discoveryConfig.js';
import { canonicalJobUrl, extractLinkedInJobId, linkedInJobDbId } from '../src/linkedin/jobIds.js';
import { parseLinkedInJobCards, extractLinkedInJobId as oldExtract } from '../src/discover/linkedin-jobs.js';
import { SCREENED_SURFACES, callsScreen } from '../src/safety/screen.js';
import type { LayoutObserver } from '../src/layout/runtime.js';
import type { ToolDeps, Screen } from '../src/linkedin/toolDeps.js';
import { makeFakeLauncher, type FakeSite } from './helpers/fakeLinkedin.js';

const STATE = { cookies: [{ name: 'li_at', value: 'SENTINEL-NOT-REAL', domain: '.linkedin.com', path: '/' }], origins: [] };
const fx = (n: string) => readFileSync(new URL(`./fixtures/linkedin/${n}`, import.meta.url), 'utf8');
const JOBS_URL = 'https://www.linkedin.com/jobs/search/?keywords=react';
const JP = '/jobs/search/';
const LIVE = { LINKEDIN_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false' };
const CONFIG: DiscoveryConfig = {
  jobs: [{ name: 'react-india', keyword: 'react developer', location: 'India', remote_only: true, limit: 25 }],
  posts: [{ name: 'default', role: 'react developer', geo: 'in', limit: 25 }],
};
const PASS: Screen = async (t) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const });
let dir: string;
const runtimes: Runtime[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'li-sj-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(STATE), { mode: 0o600 });
  chmodSync(path.join(dir, 'state.json'), 0o600);
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(site: FakeSite, env: NodeJS.ProcessEnv = {}, over: Partial<ToolDeps> = {}) {
  const log: string[] = [];
  const db = openDb(':memory:');
  const launcher = makeFakeLauncher(site, log);
  const rt = createRuntime({
    db, launcher, sessionPath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: {},
  });
  runtimes.push(rt);
  const deps: ToolDeps = {
    rt, db, now: () => new Date('2026-10-16T10:00:00Z'), cfg: loadLinkedinConfig(env), env,
    factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG, screen: PASS, ...over,
  };
  return { deps, log, db, rt };
}
const page = (name: string) => ({ pages: { [JP]: buildSnapshotFromHtml(fx(name), JOBS_URL) } }) as FakeSite;
const jobs = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT id, source, title, company, url, apply_url, description FROM jobs ORDER BY id').all() as Array<Record<string, string>>;
const counter = (db: ReturnType<typeof openDb>, key: string) =>
  (db.prepare("SELECT count FROM daily_counters WHERE key = ?").get(key) as { count: number } | undefined)?.count ?? 0;
const events = (db: ReturnType<typeof openDb>) => (db.prepare('SELECT COUNT(*) c FROM rate_events').get() as { c: number }).c;
const opened = (log: string[]) => log.filter((l) => l.startsWith('goto:'));

describe('job id derivation (moved from src/discover/linkedin-jobs.ts)', () => {
  const HREFS = [
    'https://www.linkedin.com/jobs/view/3891234567/',
    'https://www.linkedin.com/jobs/view/3891234567/?refId=abc&trackingId=xyz',
    '/jobs/view/3900000001/?trackingId=abc',
    'https://www.linkedin.com/jobs/search/?keywords=react',
    'https://www.linkedin.com/jobs/view/senior-engineer-at-acme-3900000009/',
    '',
  ];
  it('matches the old derivation on every vector', () => {
    for (const h of HREFS) expect(extractLinkedInJobId(h)).toBe(oldExtract(h));
    expect(extractLinkedInJobId(HREFS[0])).toBe('3891234567');
    expect(extractLinkedInJobId(HREFS[3])).toBeNull();
    expect(extractLinkedInJobId(HREFS[4])).toBeNull();
  });
  it('yields the same jobs-table id as the old card parser', () => {
    for (const h of HREFS.slice(0, 3)) {
      const old = parseLinkedInJobCards([{ titleText: 'T', companyText: 'C', hrefRaw: h, snippetText: '', easyApply: false }]);
      expect(old.jobs[0].id).toBe(linkedInJobDbId(extractLinkedInJobId(h)!));
    }
    expect(canonicalJobUrl('3900000001')).toBe('https://www.linkedin.com/jobs/view/3900000001/');
  });
});

describe('discovery config and URL building', () => {
  it('the shipped config migrates every usable old entry and builds a code-made url', () => {
    const cfg = loadDiscoveryConfig();
    expect(cfg.jobs.map((j) => j.name)).toEqual(['full-stack-remote-india']);
    expect(cfg.posts.map((p) => p.name)).toEqual(['default']);
    const u = new URL(buildJobsSearchUrl(cfg.jobs[0]));
    expect(u.origin + u.pathname).toBe('https://www.linkedin.com/jobs/search/');
    expect(u.searchParams.get('keywords')).toBe('full stack developer react');
    expect(u.searchParams.get('f_TPR')).toBe('r86400');
    expect(u.searchParams.get('f_WT')).toBe('2');
    expect(u.searchParams.get('f_E')).toBe('4');
  });
  it('an unreadable config yields no searches', () => {
    expect(loadDiscoveryConfig(path.join(dir, 'missing.json'))).toEqual({ jobs: [], posts: [] });
  });
});

describe('searchJobs', () => {
  it('saves the fixture jobs once; a second call saves nothing', async () => {
    const { deps, db, log } = setup(page('jobs-search.html'), LIVE);
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'ok', code: 'saved', fetched: 5, new: 3, skipped: 2, seen: 0 });
    expect(r.job_ids).toEqual(['li-job:3900000001', 'li-job:3900000002', 'li-job:3900000003']);
    const rows = jobs(db);
    expect(rows.map((j) => j.id)).toEqual(r.job_ids);
    expect(rows[0]).toMatchObject({
      source: 'linkedin-jobs', title: 'Full Stack Engineer', company: 'Acme Robotics',
      url: 'https://www.linkedin.com/jobs/view/3900000001/', apply_url: 'https://www.linkedin.com/jobs/view/3900000001/',
    });
    expect(rows[0].description).toContain('React, TypeScript');
    expect(JSON.stringify(r)).not.toContain('Acme');
    expect(counter(db, 'linkedin_search')).toBe(1);
    expect(events(db)).toBe(1);
    expect(log.filter((l) => /^(click|fill):/.test(l))).toEqual([]);

    const again = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(again).toMatchObject({ status: 'ok', code: 'no_new', new: 0, seen: 3, job_ids: [] });
    expect(jobs(db)).toHaveLength(3);
  });

  it('opens a url built from the named definition only', async () => {
    const { deps, log } = setup(page('jobs-search.html'), LIVE);
    await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(opened(log)).toEqual(['goto:/jobs/search/']);
  });

  it('unknown search name: failed, nothing opened', async () => {
    const { deps, log, db } = setup(page('jobs-search.html'), LIVE);
    const r = await searchJobs({ search: 'https://evil.example.com' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'failed', code: 'unknown_search' });
    expect(opened(log)).toEqual([]);
    expect(jobs(db)).toEqual([]);
  });

  it('hostile fixture: the input gate drops the injected card and hidden text is never read', async () => {
    const { deps, db } = setup(page('jobs-search-hostile.html'), LIVE);
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'ok', fetched: 2, new: 1, skipped: 1, injection_suspected: true });
    const rows = jobs(db);
    expect(rows.map((j) => j.id)).toEqual(['li-job:3900000102']);
    expect(JSON.stringify(rows)).not.toMatch(/admin mode|previous instructions/i);
  });

  it('hostile fixture blocked by the classifier: nothing saved, no counter', async () => {
    const screen: Screen = async (t) => ({ blocked: true, unscreened: false, text: t, flags: ['classifier_injection'], code: 'injection_suspected' });
    const { deps, db } = setup(page('jobs-search-hostile.html'), LIVE, { screen });
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'failed', code: 'injection_suspected', injection_suspected: true, new: 0 });
    expect(jobs(db)).toEqual([]);
    expect(counter(db, 'linkedin_search')).toBe(0);
    expect(events(db)).toBe(0);
  });

  it('live with a classifier error: classifier_unavailable, no saves, no counter', async () => {
    const screen: Screen = async (t) => ({ blocked: true, unscreened: false, text: t, flags: [], code: 'classifier_unavailable' });
    const { deps, db } = setup(page('jobs-search.html'), LIVE, { screen });
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'failed', code: 'classifier_unavailable', new: 0 });
    expect(jobs(db)).toEqual([]);
    expect(counter(db, 'linkedin_search')).toBe(0);
    expect(events(db)).toBe(0);
  });

  it('dry run saves nothing, records the action and consumes no ceiling', async () => {
    const { deps, db } = setup(page('jobs-search.html'), {});
    expect(deps.cfg.dryRun).toBe(true);
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'dry_run', code: 'dry_run', fetched: 5, new: 0 });
    expect(jobs(db)).toEqual([]);
    expect(counter(db, 'linkedin_search')).toBe(0);
    expect(events(db)).toBe(0);
    const rec = db.prepare('SELECT action, platform, payload FROM dry_run_actions').all() as Array<{ action: string; platform: string; payload: string }>;
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ action: 'linkedin_search_jobs', platform: 'linkedin' });
    expect(JSON.parse(rec[0].payload)).toMatchObject({ search: 'react-india', fetched: 5, would_save: 3 });
  });

  it('discover ceiling exhausted: rate_limited before the page is opened', async () => {
    const { deps, db, log } = setup(page('jobs-search.html'), { ...LIVE, LINKEDIN_MAX_DISCOVER_PER_DAY: '1' });
    expect((await searchJobs({ search: 'react-india' }, deps, { config: CONFIG })).status).toBe('ok');
    log.length = 0;
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'rate_limited', code: 'discover_limit', new: 0 });
    expect(opened(log)).toEqual([]);
    expect(events(db)).toBe(1);
  });

  it('shared daily search ceiling exhausted: rate_limited', async () => {
    const { deps, log } = setup(page('jobs-search.html'), LIVE, { cfg: { ...loadLinkedinConfig(LIVE), maxSearchesPerDay: 0 } });
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'rate_limited', code: 'search_limit' });
    expect(opened(log)).toEqual([]);
  });

  it('halted platform: halted, nothing opened or saved', async () => {
    const { deps, db, log } = setup(page('jobs-search.html'), LIVE);
    haltPlatform(db, 'linkedin', 'checkpoint: /x', new Date('2026-10-16T09:00:00Z'));
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'halted', code: 'halted' });
    expect(opened(log)).toEqual([]);
    expect(jobs(db)).toEqual([]);
  });

  it('layout drift in enforce mode refuses before any ceiling or save; unlearned jobs layout is unverified', async () => {
    const { deps, db, rt } = setup(page('jobs-search.html'), LIVE, { layoutCfg: loadLayoutConfig({ LAYOUT_ENFORCE: 'enforce' }) });
    rt.layout = {
      last: () => ({ kind: 'jobs', verdict: { class: 'drift', score: 0.2, missing: ['results.cards'], variant: 'v' }, landmarks: [] }),
    } as unknown as LayoutObserver;
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'refused', code: 'layout_drift', new: 0 });
    expect(jobs(db)).toEqual([]);
    expect(counter(db, 'linkedin_search')).toBe(0);
    expect(events(db)).toBe(0);

    rt.layout = { last: () => null } as unknown as LayoutObserver;
    expect(await searchJobs({ search: 'react-india' }, deps, { config: CONFIG })).toMatchObject({ status: 'refused', code: 'layout_unverified' });
  });

  it('warn mode (default) proceeds on an unlearned layout and reports it', async () => {
    const { deps } = setup(page('jobs-search.html'), LIVE);
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r.status).toBe('ok');
    expect(r.layout).toBeDefined();
  });

  it('a redirect to a non-search page fails closed', async () => {
    const site = { ...page('jobs-search.html'), redirects: { [JP]: 'https://www.linkedin.com/feed/' } } as FakeSite;
    site.pages['/feed/'] = buildSnapshotFromHtml('<html><body><main>feed</main></body></html>', 'https://www.linkedin.com/feed/');
    const { deps, db } = setup(site, LIVE);
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'failed', code: 'not_search_page' });
    expect(jobs(db)).toEqual([]);
  });
});

describe('MCP wiring', () => {
  it('schemas take only a search NAME: no url, no keywords', () => {
    for (const t of ['linkedin_search_jobs', 'linkedin_search_posts'] as const) {
      expect(TOOL_NAMES).toContain(t);
      expect(Object.keys(schemas[t])).toEqual(['search']);
      const s = schemas[t].search;
      expect(s.safeParse('react-india').success).toBe(true);
      expect(s.safeParse('https://www.linkedin.com/jobs/search/').success).toBe(false);
      expect(s.safeParse('react developer').success).toBe(false);
      expect(s.safeParse('../x').success).toBe(false);
      expect(s.safeParse('').success).toBe(false);
    }
  });

  it('the handler runs a named search and returns JSON counts', async () => {
    const log: string[] = [];
    const db = openDb(':memory:');
    const rt = createRuntime({
      db, launcher: makeFakeLauncher(page('jobs-search.html'), log), sessionPath: path.join(dir, 'state.json'),
      lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: {},
    });
    runtimes.push(rt);
    const handlers = buildHandlers({
      db, rt, env: LIVE, now: () => new Date('2026-10-16T10:00:00Z'), discoveryConfig: CONFIG,
      factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
      sessionPath: path.join(dir, 'state.json'),
      classifier: { classify: async () => ({ injection: false, score: 0 }) } as any,
    });
    const r = JSON.parse((await handlers.linkedin_search_jobs({ search: 'react-india' })) as string);
    expect(r).toMatchObject({ code: expect.any(String), fetched: expect.any(Number) });
    expect(Object.keys(r)).not.toContain('description');
  });

  it('both surfaces are screened and registered', () => {
    for (const id of ['linkedin_search_jobs', 'linkedin_search_posts']) {
      const s = SCREENED_SURFACES.find((x) => x.id === id);
      expect(s).toBeDefined();
      expect(callsScreen(readFileSync(s!.file, 'utf8'))).toBe(true);
    }
  });
});

describe('operator definition', () => {
  const md = readFileSync('.claude/agents/linkedin-operator.md', 'utf8');
  const tools = /^tools:\s*(.*)$/m.exec(md)![1].split(',').map((s) => s.trim());
  it('lists both discovery tools in the agent and in worker-tools.json, in the same order', () => {
    const wt = JSON.parse(readFileSync('config/worker-tools.json', 'utf8')) as Record<string, string[]>;
    expect(tools).toEqual(wt['linkedin-operator']);
    expect(tools).toContain('mcp__linkedin__linkedin_search_jobs');
    expect(tools).toContain('mcp__linkedin__linkedin_search_posts');
    expect(tools).not.toContain('mcp__linkedin__linkedin_find_profiles');
  });
  it('states the discover task and its stop rules', () => {
    const body = md.slice(md.indexOf('## Task: discover'), md.indexOf('## Task: search'));
    expect(body).toMatch(/quota/);
    expect(body).toMatch(/Never pass a URL or keywords/);
    expect(body).toMatch(/`rate_limited`, `halted` or any `killed`/);
    expect(body).toMatch(/never retry the same search/);
  });
});
