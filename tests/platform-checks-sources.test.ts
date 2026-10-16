import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { runChecks } from '../src/platform/doctor.js';
import { sourcesChecks } from '../src/platform/checksSources.js';
import { recordUsage, startCooldown } from '../src/search/budget.js';
import { recordRun } from '../src/sources/status.js';
import { cleanupRoots, copyFromRepo, ctxFor, tempRoot } from './helpers/doctorRoot.js';

afterEach(cleanupRoots);

const NOW = new Date('2026-10-16T12:00:00Z');
const PORTALS = (ats: string) => JSON.stringify({ tracked_companies: [{ name: 'Acme', ats, slug: 'acme', enabled: true }] });

async function run(id: string, root: string, env: NodeJS.ProcessEnv = {}, db: ReturnType<typeof openDb> | null = null) {
  const check = sourcesChecks({ db: () => db }).find((c) => c.id === id)!;
  return (await runChecks([check], ctxFor(root, env)))[0]!.result;
}
const goodRoot = (portals = PORTALS('greenhouse')) => {
  const root = tempRoot({ 'config/portals.json': portals });
  copyFromRepo(root, ['config/platforms.json']);
  return root;
};

describe('source_status', () => {
  it('passes when the registry loads and every enabled tenant vendor has a provider', async () => {
    const r = await run('source_status', goodRoot());
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/1 tenant vendors with a provider/);
  });

  it('fails when the registry is invalid', async () => {
    const root = tempRoot({ 'config/platforms.json': '{ not json', 'config/portals.json': PORTALS('greenhouse') });
    expect((await run('source_status', root)).status).toBe('fail');
  });

  it('fails on an enabled tenant vendor without a provider', async () => {
    const r = await run('source_status', goodRoot(PORTALS('nosuchvendor')));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('nosuchvendor');
  });

  it('warns on a platform with consecutive failed runs and on a stale one', async () => {
    const db = openDb(':memory:');
    const root = goodRoot();
    for (let i = 0; i < 3; i++) recordRun(db, 'remotive', { fetched: 0, kept: 0, new: 0, error: 'boom' });
    let r = await run('source_status', root, {}, db);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/remotive flaky/);
    const db2 = openDb(':memory:');
    recordRun(db2, 'remoteok', { fetched: 1, kept: 1, new: 0 });
    db2.prepare("UPDATE platform_status SET last_run_at = '2026-09-01T00:00:00.000Z'").run();
    r = await run('source_status', root, {}, db2);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/remoteok stale/);
  });
});

describe('search_providers', () => {
  it('skips without a database', async () => {
    expect((await run('search_providers', goodRoot())).status).toBe('skip');
  });

  it('passes and shows budgets without the key', async () => {
    const db = openDb(':memory:');
    const r = await run('search_providers', goodRoot(), { SERPER_API_KEY: 'sk-secret-value', SEND_LIMIT_PER_RUN: '1' }, db);
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/Serper key present/);
    expect(r.detail).toMatch(/dork enabled/);
    expect(r.detail).not.toContain('sk-secret-value');
  });

  it('warns when Serper is over 80% of its daily budget', async () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 17; i++) recordUsage(db, 'serper', NOW);
    const r = await run('search_providers', goodRoot(), { SERPER_API_KEY: 'k', SERPER_DAILY_BUDGET: '20' }, db);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/over 80%/);
  });

  it('warns while the dork provider is in cooldown', async () => {
    const db = openDb(':memory:');
    startCooldown(db, 'browser-dork', 24, NOW);
    const r = await run('search_providers', goodRoot(), { SERPER_API_KEY: 'k' }, db);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/cooldown/);
    expect(r.detail).toMatch(/blocked until/);
  });

  it('fails when both providers are unavailable while the email channel is on, not when it is off', async () => {
    const db = openDb(':memory:');
    const env = { DORK_ENABLED: 'false' };
    expect((await run('search_providers', goodRoot(), env, db)).status).toBe('fail');
    expect((await run('search_providers', goodRoot(), { ...env, SEND_LIMIT_PER_RUN: '0' }, db)).status).not.toBe('fail');
  });
});

describe('generated_providers', () => {
  it('skips with an n/a note when the module and table are not installed', async () => {
    const r = await run('generated_providers', goodRoot(), {}, openDb(':memory:'));
    expect(r.status).toBe('skip');
    expect(r.detail).toMatch(/n\/a: not installed/);
  });

  describe('with a generated_providers table', () => {
    const mk = () => {
      const db = openDb(':memory:');
      db.exec('CREATE TABLE generated_providers (id TEXT PRIMARY KEY, status TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 1)');
      return db;
    };
    it('passes with none and with all approved', async () => {
      const db = mk();
      expect((await run('generated_providers', goodRoot(), {}, db)).detail).toBe('none');
      db.prepare("INSERT INTO generated_providers VALUES ('a','approved',1)").run();
      expect((await run('generated_providers', goodRoot(), {}, db)).status).toBe('pass');
    });
    it('warns on candidates waiting for review', async () => {
      const db = mk();
      db.prepare("INSERT INTO generated_providers VALUES ('a','candidate',1)").run();
      expect((await run('generated_providers', goodRoot(), {}, db)).status).toBe('warn');
    });
    it('fails on a trusted provider with failing validation', async () => {
      const db = mk();
      db.prepare("INSERT INTO generated_providers VALUES ('a','approved',0)").run();
      expect((await run('generated_providers', goodRoot(), {}, db)).status).toBe('fail');
    });
  });
});
