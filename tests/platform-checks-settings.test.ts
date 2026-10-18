// tests/platform-checks-settings.test.ts
// Plan 8H, Task 14: doctor checks settings_catalog, settings_store, settings_exposure, settings_files.
// Hermetic: a temp root, a fixture catalog or the real one, no real .env, nothing printed from a value.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { settingsChecks, catalogRuleProblems } from '../src/platform/checksSettings.js';
import { allDoctorChecks } from '../src/platform/checkLists.js';
import { ENV_CATALOG } from '../src/settings/envCatalog.js';
import { ENV_EXAMPLE_HEADER, renderEnvExample } from '../src/settings/exampleGen.js';
import { cleanupRoots, ctxFor, tempRoot } from './helpers/doctorRoot.js';
import { fixtureText } from './helpers/settingsHarness.js';
import { installNoRealEnv } from './helpers/noRealEnv.js';

const guard = installNoRealEnv();
afterAll(() => guard.restore());
afterEach(cleanupRoots);

async function run(id: string, ctx: DoctorContext) {
  const check = settingsChecks().find((c) => c.id === id)!;
  return (await runChecks([check], ctx))[0]!.result;
}
const EXAMPLE = renderEnvExample(ENV_CATALOG, ENV_EXAMPLE_HEADER);
const GOOD_KEY = ENV_CATALOG[0]!.key;

describe('registration', () => {
  it('the four checks are in the shared doctor list', () => {
    const ids = allDoctorChecks().map((c) => c.id);
    for (const id of ['settings_catalog', 'settings_store', 'settings_exposure', 'settings_files']) expect(ids).toContain(id);
  });
});

describe('settings_catalog', () => {
  it('passes with the real catalog, a matching example and only known keys', async () => {
    const root = tempRoot({ '.env.example': EXAMPLE, '.env': `${GOOD_KEY}=1\n` });
    const r = await run('settings_catalog', ctxFor(root));
    expect(r.status).toBe('pass');
  });
  it('warns with names only for unknown keys, never values', async () => {
    const root = tempRoot({ '.env.example': EXAMPLE, '.env': 'MY_ODD_KEY=FIXTURE-SECRET-9\nOTHER_ODD=2\n' });
    const r = await run('settings_catalog', ctxFor(root));
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('MY_ODD_KEY');
    expect(r.detail).toContain('2 unknown');
    expect(JSON.stringify(r)).not.toContain('FIXTURE-SECRET');
  });
  it('warns when .env.example differs from the generated text, fix names the command', async () => {
    const root = tempRoot({ '.env.example': EXAMPLE + '# hand edit\n' });
    const r = await run('settings_catalog', ctxFor(root));
    expect(r.status).toBe('warn');
    expect(r.fix).toContain('npm run env:example');
  });
  it('catalog rule violations fail', async () => {
    const bad = [{ ...ENV_CATALOG.find((s) => s.key === 'JOBBER_DRY_RUN')!, tier: 'normal' as const }, ...ENV_CATALOG.filter((s) => s.key !== 'JOBBER_DRY_RUN')];
    expect(catalogRuleProblems(bad).join(' ')).toContain('JOBBER_DRY_RUN');
    const check = settingsChecks({ catalog: bad }).find((c) => c.id === 'settings_catalog')!;
    const r = (await runChecks([check], ctxFor(tempRoot({ '.env.example': EXAMPLE }))))[0]!.result;
    expect(r.status).toBe('fail');
  });
  it('the real catalog has no rule problems', () => {
    expect(catalogRuleProblems(ENV_CATALOG)).toEqual([]);
  });
});

describe('settings_store', () => {
  const store = (root: string) => join(root, '.jobber', 'settings-backups');
  const good = (root: string) => {
    mkdirSync(join(store(root), 'env'), { recursive: true, mode: 0o700 });
    chmodSync(store(root), 0o700);
    chmodSync(join(store(root), 'env'), 0o700);
  };
  const backup = (root: string, n: string, mode = 0o600) => {
    const p = join(store(root), 'env', `${n}.env`);
    writeFileSync(p, 'x', { mode });
    chmodSync(p, mode);
  };
  const files = { '.gitignore': '.env\n.jobber/\n' };

  it('warns with no backups yet', async () => {
    const r = await run('settings_store', ctxFor(tempRoot(files)));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/no backups yet/);
  });
  it('passes with 0700 dirs, 0600 files, ignored, within keep', async () => {
    const root = tempRoot(files);
    good(root);
    backup(root, '20260101T000000Z-aaaaaaaa');
    expect((await run('settings_store', ctxFor(root))).status).toBe('pass');
  });
  it('fails on a directory that is too open', async () => {
    const root = tempRoot(files);
    good(root);
    chmodSync(join(store(root), 'env'), 0o755);
    const r = await run('settings_store', ctxFor(root));
    expect(r.status).toBe('fail');
    expect(r.fix).toBeTruthy();
  });
  it('fails on a backup file readable by others', async () => {
    const root = tempRoot(files);
    good(root);
    backup(root, '20260101T000000Z-aaaaaaaa', 0o644);
    expect((await run('settings_store', ctxFor(root))).status).toBe('fail');
  });
  it('fails when .jobber/ is not git-ignored', async () => {
    const root = tempRoot({ '.gitignore': '.env\n' });
    good(root);
    backup(root, '20260101T000000Z-aaaaaaaa');
    expect((await run('settings_store', ctxFor(root))).status).toBe('fail');
  });
  it('warns when the count exceeds SETTINGS_BACKUP_KEEP', async () => {
    const root = tempRoot(files);
    good(root);
    backup(root, '20260101T000000Z-aaaaaaaa');
    backup(root, '20260102T000000Z-bbbbbbbb');
    const r = await run('settings_store', ctxFor(root, { SETTINGS_BACKUP_KEEP: '1' }));
    expect(r.status).toBe('warn');
  });
});

describe('settings_exposure', () => {
  const r = (env: NodeJS.ProcessEnv) => run('settings_exposure', ctxFor(tempRoot(), env));
  it('passes when editing is off', async () => {
    expect((await r({})).status).toBe('pass');
  });
  it('passes on loopback with edit on', async () => {
    expect((await r({ WEB_SETTINGS_EDIT: 'true' })).status).toBe('pass');
  });
  it('warns with a proxy, a non-loopback bind or chat on', async () => {
    expect((await r({ WEB_SETTINGS_EDIT: 'true', WEB_TRUST_PROXY: 'true' })).status).toBe('warn');
    expect((await r({ WEB_SETTINGS_EDIT: 'true', WEB_BIND: '0.0.0.0', WEB_ALLOW_REMOTE_BIND: 'true' })).status).toBe('warn');
    expect((await r({ WEB_SETTINGS_EDIT: 'true', WEB_CHAT_ENABLED: 'true' })).status).toBe('warn');
  });
  it('fails on remote safety override without allowed hosts, passes with them', async () => {
    const bad = await r({ WEB_SETTINGS_EDIT: 'true', WEB_SETTINGS_REMOTE_SAFETY: 'true' });
    expect(bad.status).toBe('fail');
    expect(bad.fix).toContain('WEB_ALLOWED_HOSTS');
    const ok = await r({ WEB_SETTINGS_EDIT: 'true', WEB_SETTINGS_REMOTE_SAFETY: 'true', WEB_ALLOWED_HOSTS: 'jobber.example.test' });
    expect(ok.status).not.toBe('fail');
  });
  it('reads .env as well as the process env', async () => {
    const root = tempRoot({ '.env': 'WEB_SETTINGS_EDIT=true\nWEB_TRUST_PROXY=true\n' });
    expect((await run('settings_exposure', ctxFor(root))).status).toBe('warn');
  });
});

describe('settings_files', () => {
  const seed = (over: Record<string, string> = {}) => tempRoot({
    'config/portals.json': fixtureText('portals.json'),
    'config/target-regions.json': fixtureText('target-regions.json'),
    'config/deal-breakers.json': fixtureText('deal-breakers.json'),
    'config/replies.json': fixtureText('replies.json'),
    'user-data/languages.json': fixtureText('languages.json'),
    'user-data/easy-apply-answers.json': fixtureText('easy-apply-answers.json'),
    'user-data/profile.json': fixtureText('profile.json'),
    'user-data/fact-gate.json': fixtureText('fact-gate.json'),
    ...over,
  });
  it('warns by name when files are missing (linkedin-discovery is not seeded)', async () => {
    const r = await run('settings_files', ctxFor(seed()));
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('linkedin-discovery');
  });
  it('names an invalid file without its content', async () => {
    const r = await run('settings_files', ctxFor(seed({ 'user-data/languages.json': '{FIXTURE-SECRET-4' })));
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('languages');
    expect(JSON.stringify(r)).not.toContain('FIXTURE-SECRET');
  });
  it('reports the count of locally modified config files through git', async () => {
    const root = seed();
    const run2 = (async (cmd: string, args: string[]) =>
      cmd === 'git' && args[0] === 'status' ? { stdout: ' M config/portals.json\n M config/replies.json\n', code: 0 } : { stdout: '', code: 1 }) as unknown as DoctorContext['run'];
    const r = await run('settings_files', ctxFor(root, {}, { run: run2 }));
    expect(r.detail).toContain('2 committed config file');
  });
  it('is quiet about git when git is unavailable', async () => {
    const r = await run('settings_files', ctxFor(seed()));
    expect(r.detail).not.toMatch(/committed config/);
  });
});
