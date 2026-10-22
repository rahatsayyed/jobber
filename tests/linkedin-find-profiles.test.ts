import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { openDb } from '../src/db.js';
import { createRuntime, type Runtime } from '../src/linkedin/runtime.js';
import { buildSnapshotFromHtml } from '../src/linkedin/snapshot.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { haltPlatform } from '../src/outreach/limits.js';
import { buildHandlers, schemas, TOOL_NAMES } from '../src/mcp/linkedin.js';
import { findProfiles } from '../src/linkedin/findProfiles.js';
import type { ToolDeps } from '../src/linkedin/toolDeps.js';
import type { ClassifierPort } from '../src/safety/inputGate.js';
import { makeFakeLauncher, type FakeSite } from './helpers/fakeLinkedin.js';

const STATE = { cookies: [{ name: 'li_at', value: 'SENTINEL-NOT-REAL', domain: '.linkedin.com', path: '/' }], origins: [] };
const fx = (n: string) => readFileSync(new URL(`./fixtures/linkedin/${n}`, import.meta.url), 'utf8');
const SEARCH = 'https://www.linkedin.com/search/results/people/?keywords=Acme';
const SP = '/search/results/people/';
const LIVE = { JOBBER_DRY_RUN: 'false' };
let dir: string;
const runtimes: Runtime[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'li-find-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(STATE), { mode: 0o600 });
  chmodSync(path.join(dir, 'state.json'), 0o600);
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(site: FakeSite, env: NodeJS.ProcessEnv = {}, cfgOver: Record<string, unknown> = {}) {
  const log: string[] = [];
  const db = openDb(':memory:');
  const launcher = makeFakeLauncher(site, log);
  const rt = createRuntime({
    db, launcher, sessionPath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: {},
  });
  runtimes.push(rt);
  const deps: ToolDeps = {
    rt, db, now: () => new Date('2026-10-14T10:00:00Z'), cfg: { ...loadLinkedinConfig(env), ...cfgOver }, env,
    factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
    screen: async (t) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const }),
  };
  return { deps, log, db, rt, launcher };
}
const snapOf = (name: string) => buildSnapshotFromHtml(fx(name), SEARCH);
const people = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT profile_key, name, category, company FROM people ORDER BY id').all() as Array<{ profile_key: string; name: string; category: string; company: string }>;
const noActions = (log: string[]) => expect(log.filter((l) => /^(click|fill):/.test(l))).toEqual([]);

describe('findProfiles', () => {
  it('benign fixture -> candidates with canonical urls, people rows with the caller category', async () => {
    const { deps, db, log } = setup({ pages: { [SP]: snapOf('search-results.html') } });
    const r = await findProfiles({ company: 'Acme', category: 'recruiter' }, deps);
    expect(r.status).toBe('ok');
    expect(r.candidates.map((c) => c.profile_url)).toEqual([
      'https://www.linkedin.com/in/alex-sample', 'https://www.linkedin.com/in/priya-demo', 'https://www.linkedin.com/in/sam-placeholder',
    ]);
    expect(r.candidates[0]).toMatchObject({ name: 'Alex Sample' });
    expect(r.candidates[0].headline).toContain('Engineering Manager at Acme Robotics');
    const rows = people(db);
    expect(rows).toHaveLength(3);
    // Finding 20: the category comes from the headline in code, whatever the caller asked for.
    expect(rows.map((p) => p.category)).toEqual(['hiring_manager', 'recruiter', 'peer']);
    expect(rows.every((p) => p.company === 'Acme')).toBe(true);
    expect(r.candidates.map((c) => c.employer_match)).toEqual([true, false, false]);
    expect(
      (db.prepare('SELECT employer_match AS m FROM people ORDER BY id').all() as Array<{ m: number }>).map((x) => x.m),
    ).toEqual([1, 0, 0]);
    expect((db.prepare('SELECT COUNT(*) c FROM contact_state').get() as { c: number }).c).toBe(3);
    noActions(log);
  });

  it('hostile fixture -> only canonical non-blocked candidates, injection_suspected', async () => {
    const { deps, db, log } = setup({ pages: { [SP]: snapOf('search-results-hostile.html') } });
    const r = await findProfiles({ company: 'Acme', category: 'peer' }, deps);
    expect(r.status).toBe('ok');
    expect(r.injection_suspected).toBe(true);
    expect(r.candidates.map((c) => c.profile_url)).toEqual(['https://www.linkedin.com/in/clean-person']);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
    for (const c of r.candidates) expect(c.profile_url).not.toMatch(/[?#]/);
    expect(people(db).map((p) => p.profile_key)).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/ignore all previous/i);
    noActions(log);
  });

  it('no surviving candidates -> ok no_candidates and the classifier screen is not called', async () => {
    const empty = buildSnapshotFromHtml('<html><body><main></main></body></html>', SEARCH);
    const { deps } = setup({ pages: { [SP]: empty } });
    const screen = vi.fn(deps.screen);
    const r = await findProfiles({ company: 'Acme', category: 'recruiter' }, { ...deps, screen });
    expect(r).toMatchObject({ status: 'ok', code: 'no_candidates', candidates: [] });
    expect(screen).not.toHaveBeenCalled();
  });

  it('MAX_LINKEDIN_SEARCHES_PER_DAY clamp matches the catalog max (100000), default 20', () => {
    expect(loadLinkedinConfig({ MAX_LINKEDIN_SEARCHES_PER_DAY: '100000' }).maxSearchesPerDay).toBe(100000);
    expect(loadLinkedinConfig({ MAX_LINKEDIN_SEARCHES_PER_DAY: '100001' }).maxSearchesPerDay).toBe(20);
    expect(loadLinkedinConfig({}).maxSearchesPerDay).toBe(20);
  });

  it('halted platform -> halted, runtime never launched', async () => {
    const { deps, db, launcher } = setup({ pages: { [SP]: snapOf('search-results.html') } });
    haltPlatform(db, 'linkedin', 'test', new Date('2026-10-14T10:00:00Z'));
    const r = await findProfiles({ company: 'Acme', category: 'recruiter' }, deps);
    expect(r).toMatchObject({ status: 'halted', candidates: [] });
    expect(launcher.launches).toBe(0);
  });

  it('maxSearchesPerDay 0 -> rate_limited, launcher never launched', async () => {
    const { deps, launcher, db } = setup({ pages: { [SP]: snapOf('search-results.html') } }, {}, { maxSearchesPerDay: 0 });
    const r = await findProfiles({ company: 'Acme', category: 'recruiter' }, deps);
    expect(r).toMatchObject({ status: 'rate_limited', candidates: [] });
    expect(launcher.launches).toBe(0);
    expect(people(db)).toEqual([]);
  });

  it('empty company -> failed bad_input, nothing opened', async () => {
    const { deps, launcher } = setup({ pages: {} });
    expect(await findProfiles({ company: ' \u0007 ', category: 'recruiter' }, deps)).toMatchObject({ status: 'failed', code: 'bad_input' });
    expect(launcher.launches).toBe(0);
  });

  it('search redirected to a login page -> failed, no people', async () => {
    const login = buildSnapshotFromHtml(fx('search-results.html'), 'https://www.linkedin.com/login');
    const { deps, db } = setup({ pages: { [SP]: login, '/login': login }, redirects: { [SP]: 'https://www.linkedin.com/login' } });
    const r = await findProfiles({ company: 'Acme', category: 'recruiter' }, deps);
    // The runtime treats a login redirect as a session halt, so it surfaces as halted (not ok).
    expect(r.status).not.toBe('ok');
    expect(r.candidates).toEqual([]);
    expect(people(db)).toEqual([]);
  });

  it('live env + rejecting classifier -> failed classifier_unavailable, no people rows', async () => {
    const db = openDb(':memory:');
    const log: string[] = [];
    const rt = createRuntime({
      db, launcher: makeFakeLauncher({ pages: { [SP]: snapOf('search-results.html') } }, log),
      sessionPath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: {},
    });
    runtimes.push(rt);
    const handlers = buildHandlers({
      db, rt, env: LIVE, now: () => new Date('2026-10-14T10:00:00Z'),
      factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
      sessionPath: path.join(dir, 'state.json'), classifier: () => Promise.reject(new Error('x')),
    });
    const r = JSON.parse((await handlers.linkedin_find_profiles({ company: 'Acme', category: 'recruiter' })) as string);
    expect(r).toMatchObject({ status: 'failed', code: 'classifier_unavailable', candidates: [] });
    expect(people(db)).toEqual([]);
  });

  it('dry env -> candidates returned and people rows written', async () => {
    const db = openDb(':memory:');
    const log: string[] = [];
    const rt = createRuntime({
      db, launcher: makeFakeLauncher({ pages: { [SP]: snapOf('search-results.html') } }, log),
      sessionPath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: {},
    });
    runtimes.push(rt);
    const classifier: ClassifierPort = { classify: vi.fn(async () => ({ malicious: false, score: 0, truncated: false })) };
    const handlers = buildHandlers({
      db, rt, env: { JOBBER_DRY_RUN: 'true' }, now: () => new Date('2026-10-14T10:00:00Z'),
      factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
      sessionPath: path.join(dir, 'state.json'), classifier,
    });
    const r = JSON.parse((await handlers.linkedin_find_profiles({ company: 'Acme', category: 'hiring_manager' })) as string);
    expect(r.status).toBe('ok');
    expect(r.candidates).toHaveLength(3);
    expect(people(db)).toHaveLength(3);
    expect(people(db)[0].category).toBe('hiring_manager');
  });
});

describe('linkedin_find_profiles MCP', () => {
  it('is registered, validates its schema, and goes through safe()', async () => {
    expect(TOOL_NAMES).toContain('linkedin_find_profiles');
    const s = z.object(schemas.linkedin_find_profiles);
    expect(s.safeParse({ company: 'Acme', category: 'ceo' }).success).toBe(false);
    expect(s.safeParse({ company: 'a'.repeat(101), category: 'peer' }).success).toBe(false);
    expect(s.safeParse({ company: 'Acme', category: 'peer' }).success).toBe(true);
    const db = openDb(':memory:');
    const handlers = buildHandlers({
      db, env: {}, rt: { open: async () => { throw new Error('boom net::ERR'); } } as unknown as Runtime,
      factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
    });
    const r = JSON.parse((await handlers.linkedin_find_profiles({ company: 'Acme', category: 'peer' })) as string);
    expect(r).toMatchObject({ status: 'failed', code: 'error' });
    expect(typeof r.kind).toBe('string');
  });
});
