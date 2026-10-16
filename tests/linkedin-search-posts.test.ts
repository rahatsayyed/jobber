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
import { createHash } from 'node:crypto';
import { searchPosts, mentionsRole, parsePostCards } from '../src/linkedin/searchPosts.js';
import { buildPostsSearchUrl, type DiscoveryConfig } from '../src/linkedin/discoveryConfig.js';
import { buildSyntheticPostId } from '../src/linkedin/jobIds.js';
import { buildSyntheticPostId as oldPostId } from '../src/discover/linkedin-posts.js';
import type { LayoutObserver } from '../src/layout/runtime.js';
import type { ToolDeps, Screen } from '../src/linkedin/toolDeps.js';
import { makeFakeLauncher, type FakeSite } from './helpers/fakeLinkedin.js';

const STATE = { cookies: [{ name: 'li_at', value: 'SENTINEL-NOT-REAL', domain: '.linkedin.com', path: '/' }], origins: [] };
const fx = (n: string) => readFileSync(new URL(`./fixtures/linkedin/${n}`, import.meta.url), 'utf8');
const POSTS_URL = 'https://www.linkedin.com/search/results/content/?keywords=hiring';
const PP = '/search/results/content/';
const LIVE = { LINKEDIN_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false' };
const CONFIG: DiscoveryConfig = {
  jobs: [],
  posts: [{ name: 'default', role: 'react developer', geo: 'in', limit: 25 }],
};
const PASS: Screen = async (t) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const });
let dir: string;
const runtimes: Runtime[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'li-sp-'));
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
  const rt = createRuntime({
    db, launcher: makeFakeLauncher(site, log), sessionPath: path.join(dir, 'state.json'),
    lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: {},
  });
  runtimes.push(rt);
  const deps: ToolDeps = {
    rt, db, now: () => new Date('2026-10-16T10:00:00Z'), cfg: loadLinkedinConfig(env), env,
    factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG, screen: PASS, ...over,
  };
  return { deps, log, db, rt };
}
const page = () => ({ pages: { [PP]: buildSnapshotFromHtml(fx('posts-search.html'), POSTS_URL) } }) as FakeSite;
type Db = ReturnType<typeof openDb>;
const jobs = (db: Db) =>
  db.prepare('SELECT id, source, title, company, url, apply_url, description FROM jobs ORDER BY id').all() as Array<Record<string, string>>;
const people = (db: Db) =>
  db.prepare('SELECT profile_key, name, category, company FROM people ORDER BY id').all() as Array<Record<string, string>>;
const counter = (db: Db, key: string) =>
  (db.prepare('SELECT count FROM daily_counters WHERE key = ?').get(key) as { count: number } | undefined)?.count ?? 0;

describe('searchPosts', () => {
  it('saves hiring posts once, registers only verified role-hiring authors', async () => {
    const { deps, db, log } = setup(page(), LIVE);
    const r = await searchPosts({ search: 'default' }, deps, { config: CONFIG });
    // jane (hiring react), omar (not hiring) and priya (hiring, other role) and the offsite link are the visible cards
    expect(r).toMatchObject({ status: 'ok', code: 'saved', fetched: 4, new: 2, skipped: 2, seen: 0, people: 1 });
    const rows = jobs(db);
    expect(rows).toHaveLength(2);
    for (const j of rows) {
      expect(j).toMatchObject({ source: 'linkedin-posts', company: '' });
      expect(j.url).toBe(j.apply_url);
      expect(j.url).toMatch(/^https:\/\/www\.linkedin\.com\/in\/[a-z-]+\/$/);
    }
    const jane = rows.find((j) => j.url.endsWith('/jane-recruiter/'))!;
    expect(jane.title).toBe('Jane Recruiter');
    expect(jane.description).toContain('React developer');
    expect(people(db)).toEqual([{ profile_key: 'linkedin.com/in/jane-recruiter', name: 'Jane Recruiter', category: 'peer', company: '' }]);
    expect(JSON.stringify(r)).not.toContain('Jane');
    expect(counter(db, 'linkedin_search')).toBe(1);
    expect(log.filter((l) => /^(click|fill):/.test(l))).toEqual([]);

    const again = await searchPosts({ search: 'default' }, deps, { config: CONFIG });
    expect(again).toMatchObject({ status: 'ok', code: 'no_new', new: 0, seen: 2 });
    expect(jobs(db)).toHaveLength(2);
    expect(people(db)).toHaveLength(1);
  });

  it('post ids equal the old algorithm on the old stored-url form and the card text', () => {
    // old algorithm inlined: sha256(href + textContent.slice(0, 100)) first 16 hex chars
    const old = (href: string, text: string) =>
      `li-post:${createHash('sha256').update(href + text.slice(0, 100)).digest('hex').slice(0, 16)}`;
    const text = 'Jane Recruiter We are hiring a React developer for our Pune team. Remote friendly, message me.';
    const snap = {
      ...buildSnapshotFromHtml('<html><body><main>x</main></body></html>', POSTS_URL),
      postCards: [{ text, authorName: 'Jane Recruiter', profileHref: 'https://www.linkedin.com/in/jane-recruiter/?trk=abc' }],
    };
    const p = parsePostCards(snap, 25, 'react developer');
    expect(p.jobs[0].url).toBe('https://www.linkedin.com/in/jane-recruiter/');
    expect(p.jobs[0].id).toBe(old('https://www.linkedin.com/in/jane-recruiter/', text));
    // helper itself still matches the old exported function
    expect(buildSyntheticPostId('https://www.linkedin.com/in/x/', 'hi')).toBe(oldPostId('https://www.linkedin.com/in/x/', 'hi'));
  });

  it('role match is a word check on the definition', () => {
    expect(mentionsRole('Hiring a React Developer in Pune', 'full stack developer / react')).toBe(true);
    expect(mentionsRole('Hiring a payroll accountant', 'full stack developer / react')).toBe(false);
  });

  it('builds the content search url in code', () => {
    const u = new URL(buildPostsSearchUrl(CONFIG.posts[0]));
    expect(u.origin + u.pathname).toBe('https://www.linkedin.com/search/results/content/');
    expect(u.searchParams.get('keywords')).toContain('(react developer) in');
  });

  it('classifier block: nothing saved, no author registered, no counter', async () => {
    const screen: Screen = async (t) => ({ blocked: true, unscreened: false, text: t, flags: ['classifier_injection'], code: 'injection_suspected' });
    const { deps, db } = setup(page(), LIVE, { screen });
    const r = await searchPosts({ search: 'default' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'failed', code: 'injection_suspected', new: 0 });
    expect(jobs(db)).toEqual([]);
    expect(people(db)).toEqual([]);
    expect(counter(db, 'linkedin_search')).toBe(0);
  });

  it('live with a classifier error: classifier_unavailable and nothing written', async () => {
    const screen: Screen = async (t) => ({ blocked: true, unscreened: false, text: t, flags: [], code: 'classifier_unavailable' });
    const { deps, db } = setup(page(), LIVE, { screen });
    expect(await searchPosts({ search: 'default' }, deps, { config: CONFIG })).toMatchObject({ status: 'failed', code: 'classifier_unavailable' });
    expect(jobs(db)).toEqual([]);
    expect(people(db)).toEqual([]);
    expect(counter(db, 'linkedin_search')).toBe(0);
  });

  it('dry run saves no job and registers no author, and records the action', async () => {
    const { deps, db } = setup(page(), {});
    const r = await searchPosts({ search: 'default' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'dry_run', new: 0 });
    expect(jobs(db)).toEqual([]);
    expect(people(db)).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) c FROM dry_run_actions').get() as { c: number }).c).toBe(1);
    expect(counter(db, 'linkedin_search')).toBe(0);
  });

  it('ceiling exhausted and halted are refused before the page opens', async () => {
    const a = setup(page(), { ...LIVE, LINKEDIN_MAX_DISCOVER_PER_DAY: '0' });
    expect(await searchPosts({ search: 'default' }, a.deps, { config: CONFIG })).toMatchObject({ status: 'rate_limited', code: 'discover_limit' });
    expect(a.log.filter((l) => l.startsWith('goto:'))).toEqual([]);
    const b = setup(page(), LIVE);
    haltPlatform(b.db, 'linkedin', 'restriction: /x', new Date('2026-10-16T09:00:00Z'));
    expect(await searchPosts({ search: 'default' }, b.deps, { config: CONFIG })).toMatchObject({ status: 'halted' });
    expect(b.log.filter((l) => l.startsWith('goto:'))).toEqual([]);
  });

  it('layout drift in enforce mode refuses with nothing written', async () => {
    const { deps, db, rt } = setup(page(), LIVE, { layoutCfg: loadLayoutConfig({ LAYOUT_ENFORCE: 'enforce' }) });
    rt.layout = {
      last: () => ({ kind: 'search', verdict: { class: 'drift', score: 0.1, missing: ['results.cards'], variant: 'v' }, landmarks: [] }),
    } as unknown as LayoutObserver;
    const r = await searchPosts({ search: 'default' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'refused', code: 'layout_drift' });
    expect(jobs(db)).toEqual([]);
    expect(people(db)).toEqual([]);
  });

  it('unknown name is rejected without opening anything', async () => {
    const { deps, log } = setup(page(), LIVE);
    expect(await searchPosts({ search: 'nope' }, deps, { config: CONFIG })).toMatchObject({ status: 'failed', code: 'unknown_search' });
    expect(log.filter((l) => l.startsWith('goto:'))).toEqual([]);
  });
});
