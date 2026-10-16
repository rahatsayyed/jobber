// tests/web-settings-leak.test.ts
// Leak tests for the settings API (plan 8H, Task 7): run every flow with fixture secrets and scan responses, audit
// rows, settings_pending rows, console output and thrown error messages for FIXTURE-SECRET-.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_CATALOG } from './fixtures/settings/catalog.fixture.js';
import { planEnvChange, readEnvState, applyEnvPlan } from '../src/settings/envEdit.js';
import { ENV_PATH, BACKUPS, ROOT, setupSettings, type SettingsSetup } from './helpers/settingsHarness.js';
import { installNoRealEnv } from './helpers/noRealEnv.js';

const guard = installNoRealEnv();
afterAll(() => guard.restore());

let s: SettingsSetup | null = null;
afterEach(async () => {
  if (s) await s.h.close();
  s = null;
  vi.restoreAllMocks();
});

const NEEDLE = /FIXTURE-SECRET-/;
const J = (r: { body: string }): any => JSON.parse(r.body);
const set = (key: string, value: string) => ({ key, op: 'set' as const, value });

function capture(x: SettingsSetup): string[] {
  const seen: string[] = [];
  const orig = x.h.call.bind(x.h);
  x.h.call = async (...a: Parameters<typeof orig>) => {
    const r = await orig(...a);
    seen.push(r.body, JSON.stringify(r.headers));
    return r;
  };
  return seen;
}

const tables = (x: SettingsSetup): string =>
  JSON.stringify([
    x.h.auth.prepare('SELECT * FROM audit_log').all(),
    x.h.auth.prepare('SELECT * FROM settings_pending').all(),
    x.h.auth.prepare('SELECT * FROM chat_pending').all(),
  ]);

describe('settings API leak scan', () => {
  it('no response, audit row, pending row or log line carries a secret value', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    }
    s = await setupSettings({}); // the fixture env already holds FIXTURE-SECRET-1 and FIXTURE-SECRET-2
    const seen = capture(s);
    const { get, post } = s;

    // reads
    await get('/api/settings/meta');
    seen.push((await get('/api/settings/env')).body, (await get('/api/settings/env?q=secret')).body);
    await get('/api/settings/files');
    await get('/api/settings/files/profile');
    await get('/api/settings/backups?target=env');
    await get('/api/config');
    await get('/api/status');
    await get('/api/audit');

    // env flows: replace, set, clear a secret; a rejected pasted secret; stale; wrong token
    let etag = await s.envEtag();
    const changes = [set('FX_API_KEY', 'FIXTURE-SECRET-10'), set('FX_OAUTH_SECRET', 'FIXTURE-SECRET-11'), { key: 'FX_BOT_TOKEN', op: 'clear' }];
    const p = await post('/api/settings/env/preview', { etag, changes });
    expect(p.status, p.body).toBe(200);
    const a = await post('/api/settings/env/apply', { token: J(p).token, etag, changes });
    expect(a.status, a.body).toBe(200);
    expect(s.fs.text(ENV_PATH)).toContain('FIXTURE-SECRET-10'); // it was really written
    etag = J(a).newEtag;
    await post('/api/settings/env/preview', { etag, changes: [set('FX_MAX_PER_DAY', 'FIXTURE-SECRET-12'), set('FX_BOT_TOKEN', 'FIXTURE-SECRET-13' + 'x'.repeat(300))] });
    await post('/api/settings/env/preview', { etag, changes: [{ key: 'FIXTURE-SECRET-14', op: 'set', value: 'FIXTURE-SECRET-15' }] });
    await post('/api/settings/env/preview', { etag, changes: [{ key: 'FX_API_KEY', op: 'reset' }] });
    await post('/api/settings/env/apply', { token: 'FIXTURE-SECRET-16'.padEnd(40, 'x'), etag, changes });
    await post('/api/settings/env/apply', { token: J(p).token, etag: 'FIXTURE-SECRET-17', changes });

    // rollback of the secret change (the clock moves on so the 10 writes per minute budget is not the subject here)
    s.h.clock.t += 61_000;
    const list = J(await get('/api/settings/backups?target=env'));
    expect(list.length).toBeGreaterThan(0);
    const rp = await post('/api/settings/rollback/preview', { target: 'env', backupId: list[0].id });
    expect(rp.status, rp.body).toBe(200);
    const ra = await post('/api/settings/rollback/apply', { token: J(rp).token, target: 'env', backupId: list[0].id });
    expect(ra.status, ra.body).toBe(200);
    expect(s.fs.text(ENV_PATH)).toContain('FIXTURE-SECRET-1'); // restored

    // file flows
    s.h.clock.t += 61_000;
    const cur = J(await get('/api/settings/files/languages'));
    const text = JSON.stringify({ ...JSON.parse(cur.text), confirmed: true }, null, 2) + '\n';
    const fp = await post('/api/settings/files/languages/preview', { etag: cur.etag, text });
    const fa = await post('/api/settings/files/languages/apply', { token: J(fp).token, etag: cur.etag, text });
    expect(fa.status, fa.body).toBe(200);
    await post('/api/settings/files/languages/preview', { etag: cur.etag, text: '{ "FIXTURE-SECRET-18": ' });

    // a failed write
    s.h.clock.t += 61_000;
    s.fs.failOn('rename', ENV_PATH);
    const e2 = await s.envEtag();
    const ch2 = [set('FX_API_KEY', 'FIXTURE-SECRET-19')];
    const p2 = await post('/api/settings/env/preview', { etag: e2, changes: ch2 });
    const a2 = await post('/api/settings/env/apply', { token: J(p2).token, etag: e2, changes: ch2 });
    expect(a2.status).toBe(500);

    for (const body of seen) expect(body).not.toMatch(NEEDLE);
    expect(tables(s)).not.toMatch(NEEDLE);
    expect(logs.join('\n')).not.toMatch(NEEDLE);
  });

  it('GET /api/settings/env and GET /api/config contain no secret value; unknown keys are names only', async () => {
    s = await setupSettings();
    const env = await s.get('/api/settings/env');
    const cfg = await s.get('/api/config');
    for (const r of [env, cfg]) {
      expect(r.status).toBe(200);
      expect(r.body).not.toMatch(NEEDLE);
    }
    expect(env.body).toContain('UNKNOWN_FIXTURE_KEY');
    expect(env.body).not.toContain('keep-me-as-is');
    expect(J(env).unknownKeys).toEqual(['ANOTHER_UNKNOWN', 'UNKNOWN_FIXTURE_KEY']);
  });

  it('a registered secret is masked even if it shows up in a file response', async () => {
    s = await setupSettings({ secrets: ['FIXTURE-SECRET-30'] });
    const prof = JSON.parse(s.fs.text(`${ROOT}/user-data/profile.json`)!);
    s.fs.put(`${ROOT}/user-data/profile.json`, JSON.stringify({ ...prof, note: 'has FIXTURE-SECRET-30 inside' }));
    const r = await s.get('/api/settings/files/profile');
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('FIXTURE-SECRET-30');
    expect(r.body).toContain('[redacted]');
  });

  it('thrown error messages from the apply path carry no secret', async () => {
    const { memFs } = await import('./helpers/memFs.js');
    const { fixtureText } = await import('./helpers/settingsHarness.js');
    const messages: string[] = [];
    for (const op of ['rename', 'write', 'mkdir'] as const) {
      const fs = memFs({ [ENV_PATH]: fixtureText('env.fixture') });
      const state = readEnvState(fs, ENV_PATH);
      const plan = planEnvChange(state, [set('FX_API_KEY', 'FIXTURE-SECRET-40')], FIXTURE_CATALOG, {
        editEnabled: true, remoteExposure: false, remoteSafetyAllowed: false, sessionFresh: true,
      });
      expect(plan.errors).toEqual([]);
      messages.push(JSON.stringify(plan), ...plan.warnings);
      fs.failOn(op);
      try {
        applyEnvPlan(plan, { fs, path: ENV_PATH, backupDir: BACKUPS, keep: 3, now: () => new Date(0) });
        messages.push('did not throw');
      } catch (e) {
        messages.push(`${(e as Error).name}: ${(e as Error).message}`);
      }
    }
    expect(messages.some((m) => m === 'did not throw')).toBe(false);
    expect(messages.join('\n')).not.toMatch(NEEDLE);
  });
});
