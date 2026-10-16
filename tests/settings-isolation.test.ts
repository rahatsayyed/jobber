// tests/settings-isolation.test.ts
// Plan 8H, Task 9: the settings API is isolated from agents, chat and CLI writes. Import graph, no agent-facing
// mentions, read-only CLI, chat cannot reach the settings module, write routes need Sec-Fetch-Site same-origin.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { runCli, readOnlyFs, type CliDeps } from '../scripts/settings.js';
import { validateChatText, STATUS_COMMANDS } from '../src/web/chat.js';
import { createSettingsRoutes } from '../src/web/settingsRoutes.js';
import { FIXTURE_CATALOG } from './fixtures/settings/catalog.fixture.js';
import { memFs } from './helpers/memFs.js';
import { makeHarness, type Harness } from './helpers/webHarness.js';
import { BACKUPS, ENV_PATH, fixtureText, ROOT as PROJ, setupSettings, type SettingsSetup } from './helpers/settingsHarness.js';
import { installNoRealEnv } from './helpers/noRealEnv.js';

const guard = installNoRealEnv();
afterAll(() => guard.restore());

const REPO = resolve(__dirname, '..');
const rel = (p: string): string => relative(REPO, p).split(sep).join('/');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('import graph', () => {
  const ALLOWED = new Set([
    'src/web/settingsRoutes.ts',
    'src/web/server.ts',
    'scripts/web.ts',
    'scripts/gen-env-example.ts',
    'scripts/settings.ts',
    'src/platform/checksSettings.ts', // later task
    'src/stack/up.ts', // later task (pending-restart clear)
    'src/dash/configView.ts', // type-only import of EnvSpec (Task 8, injected catalog)
  ]);
  const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]*\/settings\/[^'"]*)['"]/g;
  const files = [...walk(join(REPO, 'src')), ...walk(join(REPO, 'scripts')), ...walk(join(REPO, '.claude'))].filter((p) =>
    /\.(ts|tsx|js|cjs|mjs|sh)$/.test(p),
  );
  it('only the listed files import src/settings/*', () => {
    const importers: string[] = [];
    for (const f of files) {
      const r = rel(f);
      if (r.startsWith('src/settings/')) continue; // the module itself
      const text = readFileSync(f, 'utf8');
      IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_RE.exec(text)) !== null) {
        const target = resolve(f, '..', m[1]);
        if (rel(target).startsWith('src/settings/')) importers.push(r);
      }
    }
    const extra = [...new Set(importers)].filter((r) => !ALLOWED.has(r));
    expect(extra).toEqual([]);
  });
  it('nothing in the agent-side trees imports it, even by text', () => {
    const FORBIDDEN = ['src/mcp/', 'src/scheduler/', 'src/outreach/', 'src/linkedin/', 'src/naukri/', 'scripts/run-claude', 'scripts/scheduler.ts'];
    for (const f of files) {
      const r = rel(f);
      if (!FORBIDDEN.some((p) => r.startsWith(p))) continue;
      expect(/settings\/(?:atomic|backups|diff|envEdit|fileRegistry|jsonStore|policy|types|valueCheck|envCatalog|schemas)/.test(readFileSync(f, 'utf8')), r).toBe(false);
    }
  });
});

describe('no write path from agents', () => {
  const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');
  it('permission sets, run profiles and worker tools never mention the settings API', () => {
    for (const p of ['config/permission-sets.json', 'config/run-profiles.json', 'config/worker-tools.json']) {
      const t = read(p);
      expect(/\/api\/settings|settings_pending|settings-backups|scripts\/settings|npm run settings/i.test(t), p).toBe(false);
      expect(/\bsettings\b/i.test(t), p).toBe(false);
    }
  });
  it('no agent or skill markdown mentions the settings API', () => {
    const md = [...walk(join(REPO, '.claude/agents')), ...walk(join(REPO, '.claude/skills')), ...walk(join(REPO, '.claude/commands'))].filter((p) => p.endsWith('.md'));
    expect(md.length).toBeGreaterThan(5);
    for (const f of md) expect(/\/api\/settings|settings_pending|settings-backups|npm run settings/i.test(readFileSync(f, 'utf8')), rel(f)).toBe(false);
  });
  it('the CLI source has no write primitive', () => {
    const src = read('scripts/settings.ts');
    for (const w of ['writeFileSync', 'renameSync', 'applyEnvPlan', 'applyJson']) expect(src.includes(w), w).toBe(false);
  });
  it('package.json has the settings script', () => {
    expect(JSON.parse(read('package.json')).scripts.settings).toBe('tsx scripts/settings.ts');
  });
});

describe('chat', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await h.close();
    h = null;
  });

  it('validateChatText still rejects any slash text other than the status commands', () => {
    expect([...STATUS_COMMANDS].sort()).toEqual(['health', 'limits', 'working']);
    for (const t of ['/api/settings/env/apply', '/settings', '/limits now', '/runhunt', ' /outcome 1 hired', '/']) {
      expect(validateChatText(t).ok, t).toBe(false);
    }
    for (const c of STATUS_COMMANDS) expect(validateChatText(`/${c}`).ok).toBe(true);
  });

  it('the chat routes never mention settings in the server source', () => {
    const src = readFileSync(join(REPO, 'src/web/server.ts'), 'utf8');
    const a = src.indexOf("'/api/send/prepare'");
    const b = src.indexOf('chat_send');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(/settings/i.test(src.slice(a, b))).toBe(false);
  });

  it('a chat prepare/confirm only calls the injected send(text) and writes nothing in the settings store', async () => {
    const calls: unknown[][] = [];
    const fs = memFs({ [ENV_PATH]: fixtureText('env.fixture') });
    fs.mkdirp(BACKUPS, 0o700);
    const before = fs.log.length;
    h = await makeHarness({
      settings: {
        root: PROJ, envPath: ENV_PATH, backupDir: BACKUPS, userDataDir: `${PROJ}/user-data`, catalog: FIXTURE_CATALOG, fs,
        editEnabled: true, remoteExposure: false, remoteSafetyAllowed: false, backupKeep: 10,
        startMode: { mode: 'DRY RUN', flags: {} }, secrets: [],
      },
      chat: { enabled: true, session: 'ccgram', window: 'JobApplier', send: async (...a: unknown[]) => { calls.push(a); } },
    });
    const { cookie } = await h.login();
    const sess = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body);
    const post = (path: string, body: unknown) =>
      h!.call('POST', path, {
        headers: { cookie, 'x-csrf-token': sess.csrf, origin: `http://127.0.0.1:${h!.port}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const text = 'please set FX_DRY_RUN false';
    const p = JSON.parse((await post('/api/send/prepare', { text })).body);
    expect((await post('/api/send/confirm', { text, token: p.token })).status).toBe(200);
    expect(calls).toEqual([[text]]);
    expect(fs.log.slice(before).filter((l) => /^(write|rename|remove|chmod|mkdir):/.test(l))).toEqual([]);
    expect((await post('/api/send/prepare', { text: '/api/settings/env/apply' })).status).toBe(400);
  });
});

describe('route reachability', () => {
  let s: SettingsSetup | null = null;
  afterEach(async () => {
    if (s) await s.h.close();
    s = null;
  });
  it('every POST route is 403 for a valid session without Sec-Fetch-Site same-origin', async () => {
    s = await setupSettings();
    const routes = createSettingsRoutes(s.deps, { auth: s.h.auth, now: s.h.now, authMode: 'token', reauthMaxAgeSec: 300 });
    const writes = routes.filter((r) => r.method === 'POST').map((r) => r.pattern.replace(':id', 'portals'));
    expect(writes.length).toBeGreaterThanOrEqual(6);
    for (const p of writes) {
      for (const sfs of [undefined, 'none', 'same-site', 'cross-site']) {
        const res = await s.post(p, { etag: 'x', changes: [] }, { 'sec-fetch-site': sfs });
        expect(res.status, `${p} ${sfs}`).toBe(403);
      }
    }
  });
});

describe('CLI', () => {
  const SECRETS = ['FIXTURE-SECRET-1', 'FIXTURE-SECRET-2'];
  const env = fixtureText('env.fixture');
  const mk = (envText: string | null, extra: Record<string, string> = {}): CliDeps => ({
    catalog: FIXTURE_CATALOG,
    fs: memFs({ ...(envText === null ? {} : { [ENV_PATH]: envText }), ...extra }),
    envPath: ENV_PATH,
    backupDir: BACKUPS,
  });
  const noSecret = (t: string): void => {
    for (const x of SECRETS) expect(t.includes(x)).toBe(false);
  };

  it('list prints names and set/unset only', () => {
    const r = runCli(['list'], mk(env));
    expect(r.code).toBe(0);
    expect(r.out).toContain('FX_API_KEY  set');
    expect(r.out).toContain('FX_OAUTH_SECRET  unset');
    expect(r.out).toContain('UNKNOWN_FIXTURE_KEY');
    expect(r.out).not.toContain('keep-me-as-is');
    expect(r.out).not.toContain('fixture runner');
    noSecret(r.out);
  });

  it('get refuses a secret key with set or not set, prints a non-secret value, rejects an unknown key', () => {
    const d = mk(env);
    expect(runCli(['get', 'FX_API_KEY'], d)).toEqual({ code: 0, out: 'secret: set\n' });
    expect(runCli(['get', 'FX_OAUTH_SECRET'], d).out).toBe('secret: not set\n');
    expect(runCli(['get', 'FX_MAX_PER_DAY'], d).out).toBe('FX_MAX_PER_DAY=5\n');
    const u = runCli(['get', 'UNKNOWN_FIXTURE_KEY'], d);
    expect(u.code).toBe(1);
    expect(u.out).not.toContain('keep-me-as-is');
    expect(runCli(['get'], d).code).toBe(1);
  });

  it('check exits non-zero on an invalid fixture and zero on a valid one, without printing values', () => {
    const bad = runCli(['check'], mk(env));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('FX_MODE');
    noSecret(bad.out);
    expect(bad.out).not.toContain('alpha');
    const good = runCli(['check'], mk('FX_ALLOWED_EMAIL=owner@example.test\nFX_MODE=token\nFX_API_KEY=FIXTURE-SECRET-1\n'));
    expect(good.out).toContain('check: ok');
    expect(good.code).toBe(0);
  });

  it('backups lists ids and diff masks secret and unknown values', () => {
    const id = '20261016T101500Z-abcdef12';
    const old = 'FX_API_KEY=FIXTURE-SECRET-1\nFX_MAX_PER_DAY=9\nUNKNOWN_FIXTURE_KEY=old-unknown\n';
    const d = mk('FX_API_KEY=FIXTURE-SECRET-2\nFX_MAX_PER_DAY=5\nUNKNOWN_FIXTURE_KEY=new-unknown\n', { [`${BACKUPS}/env/${id}.env`]: old });
    const b = runCli(['backups'], d);
    expect(b.out).toContain(id);
    const r = runCli(['diff', id], d);
    expect(r.code).toBe(0);
    expect(r.out).toContain('- FX_MAX_PER_DAY=9');
    expect(r.out).toContain('+ FX_MAX_PER_DAY=5');
    expect(r.out).toContain('FX_API_KEY=<hidden>');
    noSecret(r.out);
    expect(r.out).not.toContain('unknown');
    expect(runCli(['diff', '../etc/passwd'], d).code).toBe(1);
    expect(runCli(['diff'], d).code).toBe(1);
  });

  it('check with no catalog loaded prints a notice and exits non-zero', () => {
    const r = runCli(['check'], { ...mk(env), catalog: [] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('no catalog loaded');
    noSecret(r.out);
  });

  it('unknown command prints usage; the read-only fs refuses every mutation', () => {
    expect(runCli(['nope'], mk(env)).code).toBe(1);
    expect(runCli([], mk(null)).code).toBe(1);
    expect(runCli(['list'], mk(null)).code).toBe(0);
    const ro = readOnlyFs(memFs({}));
    expect(() => ro.write('/x', 'y', 0o600)).toThrow();
    expect(() => ro.rename('/x', '/y')).toThrow();
    expect(() => ro.remove('/x')).toThrow();
    expect(() => ro.mkdir('/x', 0o700)).toThrow();
    expect(() => ro.chmod('/x', 0o600)).toThrow();
  });
});
