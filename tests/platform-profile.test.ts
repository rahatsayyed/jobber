// Platform sessions (LinkedIn main, Naukri, Wellfound) in their own persistent Chrome profile, headless: fakes only, no real browser.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/linkedin/runtime.js';
import { acquireLock } from '../src/linkedin/session.js';
import { openDb } from '../src/db.js';
import { naukriClose, naukriOpen, shutdownNaukri } from '../src/mcp/naukri.js';
import { shutdownWellfound, wellfoundClose, wellfoundOpen } from '../src/mcp/wellfound.js';
import {
  extensionIds, importStateOnce, openPlatformContext, refreshStateFile, STATE_IMPORT_MARKER, platformProfileDir,
} from '../src/webcore/platformProfile.js';
import { launchPersistentChrome } from '../src/linkedin/browser.js';
import { run as browserOpen, parseArgs, CHROME_WEB_STORE } from '../scripts/browser-open.js';
import { setupAccountChecks } from '../src/platform/checksSetup.js';
import type { DoctorContext } from '../src/platform/doctor.js';
import type { LiContext, LiLauncher, LiPage } from '../src/linkedin/types.js';
import { makeFakeLauncher } from './helpers/fakeLinkedin.js';

const dirs: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'platprofile-'))); dirs.push(d); return d; };
afterEach(async () => {
  await shutdownNaukri(); await shutdownWellfound();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SECRET = 'cookie-secret-value-zzz';
const liCookie = (value = SECRET) => ({ name: 'li_at', value, domain: '.linkedin.com', path: '/', expires: 4102444800, httpOnly: true, secure: true, sameSite: 'None' });
const nkCookie = { name: 'nauk_at', value: SECRET, domain: '.naukri.com', path: '/', expires: 4102444800, httpOnly: true, secure: true, sameSite: 'Lax' };
const wfCookie = { name: '_wellfound', value: SECRET, domain: '.wellfound.com', path: '/', expires: 4102444800, httpOnly: true, secure: true, sameSite: 'Lax' };

interface Fake {
  launcher: LiLauncher;
  persistentCalls: Array<{ dir: string; opts: Record<string, unknown> }>;
  plain: { n: number };
  added: unknown[][];
  closed: { n: number };
  stateToReturn: { cookies: unknown[]; origins: unknown[] };
  events: string[];
  onPersistent?: () => void;
}

function fake(o: { persistent?: boolean; persistentThrows?: boolean; state?: unknown[] } = {}): Fake {
  const f: Fake = { launcher: null as unknown as LiLauncher, persistentCalls: [], plain: { n: 0 }, added: [], closed: { n: 0 }, stateToReturn: { cookies: o.state ?? [liCookie()], origins: [] }, events: [] };
  let current = 'about:blank';
  const page = {
    goto: async (u: string) => { current = u; }, url: () => current, title: async () => 't', waitForTimeout: async () => undefined,
    evaluate: async () => ({ url: current, title: 't', bodyText: 'x'.repeat(300), profile: null, results: [], invitations: [], messages: [], messageHeaderName: null, notices: [], dialogText: null, hasPasswordInput: false }),
    locator: () => ({ count: async () => 0 }),
  } as unknown as LiPage;
  const ctx: LiContext = {
    newPage: async () => page,
    storageState: async () => f.stateToReturn,
    waitForEvent: async () => page,
    addCookies: async (c: unknown[]) => { f.added.push(c); },
  };
  const browser = { newContext: async () => ctx, close: async () => { f.closed.n += 1; } };
  const launcher: Record<string, unknown> = { launch: async () => { f.plain.n += 1; return browser; } };
  if (o.persistent !== false) {
    launcher['launchPersistentContext'] = async (dir: string, opts: Record<string, unknown>) => {
      f.onPersistent?.();
      if (o.persistentThrows) throw new Error('profile in use');
      f.persistentCalls.push({ dir, opts });
      return { ...ctx, close: async () => { f.closed.n += 1; } };
    };
  }
  f.launcher = launcher as unknown as LiLauncher;
  return f;
}

function layout() {
  const root = tmp();
  const profileDir = path.join(root, 'browser-profile-linkedin-main');
  return { root, profileDir, statePath: path.join(root, 'linkedin-main-state.json'), lockPath: path.join(root, 'linkedin.lock') };
}
function writeState(p: string, cookies: unknown[]) { fs.writeFileSync(p, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 }); }

const URL_ = 'https://www.linkedin.com/in/jane-example/';
const li = (f: Fake, l: ReturnType<typeof layout>, extra: Record<string, unknown> = {}) =>
  createRuntime({ db: openDb(':memory:'), launcher: f.launcher, sessionPath: l.statePath, lockPath: l.lockPath, profileDir: l.profileDir, settleMs: 0, env: {}, ...extra });

describe('LinkedIn main runtime: persistent profile', () => {
  it('opens the profile headless (extensions allowed) when the directory exists, and the lock is taken BEFORE the launch', async () => {
    const f = fake(); const l = layout();
    writeState(l.statePath, [liCookie()]); fs.mkdirSync(l.profileDir, { recursive: true });
    f.onPersistent = () => f.events.push(fs.existsSync(l.lockPath) ? 'lock_held_at_launch' : 'no_lock_at_launch');
    const rt = li(f, l);
    expect((await rt.open(URL_)).ok).toBe(true);
    expect(f.events).toEqual(['lock_held_at_launch']);
    expect(f.persistentCalls).toHaveLength(1);
    const { dir, opts } = f.persistentCalls[0];
    expect(dir).toBe(l.profileDir);
    expect(opts.headless).toBe(true);
    expect(opts.args).toEqual(expect.arrayContaining(['--headless=new']));
    expect(opts.ignoreDefaultArgs).toEqual(['--disable-extensions']);
    expect(f.plain.n).toBe(0);
    await rt.close();
    expect(fs.existsSync(l.lockPath)).toBe(false);
  });

  it('a locked profile yields session_locked and launches nothing', async () => {
    const f = fake(); const l = layout();
    writeState(l.statePath, [liCookie()]); fs.mkdirSync(l.profileDir, { recursive: true });
    const held = acquireLock(l.lockPath);
    expect(held.ok).toBe(true);
    const r = await li(f, l).open(URL_);
    expect(r).toMatchObject({ ok: false, code: 'session_locked' });
    expect(f.persistentCalls).toHaveLength(0);
    expect(f.plain.n).toBe(0);
    if (held.ok) held.handle.release();
  });

  it('imports the state file cookies once (marker), never a second time', async () => {
    const f = fake(); const l = layout();
    writeState(l.statePath, [liCookie()]); fs.mkdirSync(l.profileDir, { recursive: true });
    const rt = li(f, l);
    await rt.open(URL_);
    expect(f.added).toHaveLength(1);
    expect(f.added[0]).toHaveLength(1);
    expect(fs.existsSync(path.join(l.profileDir, STATE_IMPORT_MARKER))).toBe(true);
    expect(fs.readFileSync(path.join(l.profileDir, STATE_IMPORT_MARKER), 'utf8')).not.toContain(SECRET);
    await rt.close();
    await rt.open(URL_);
    expect(f.added).toHaveLength(1);
    await rt.close();
  });

  it('refreshes the state file from the context on close (atomic, mode 600) and keeps the cookie value out of any log', async () => {
    const f = fake(); const l = layout();
    writeState(l.statePath, [liCookie('old-value')]); fs.mkdirSync(l.profileDir, { recursive: true });
    const rt = li(f, l);
    await rt.open(URL_);
    f.stateToReturn = { cookies: [liCookie('fresh-value')], origins: [] };
    await rt.close();
    expect(JSON.parse(fs.readFileSync(l.statePath, 'utf8')).cookies[0].value).toBe('fresh-value');
    expect(fs.statSync(l.statePath).mode & 0o777).toBe(0o600);
  });

  it('a state without li_at never overwrites the good state file', async () => {
    const f = fake(); const l = layout();
    writeState(l.statePath, [liCookie('good')]); fs.mkdirSync(l.profileDir, { recursive: true });
    const rt = li(f, l);
    await rt.open(URL_);
    f.stateToReturn = { cookies: [], origins: [] };
    await rt.close();
    expect(JSON.parse(fs.readFileSync(l.statePath, 'utf8')).cookies[0].value).toBe('good');
  });

  it('falls back to today\'s state-file launch: no profile directory, a launcher without profile support, or a profile that cannot be opened', async () => {
    for (const c of ['no_dir', 'unsupported', 'throws'] as const) {
      const f = fake({ persistent: c !== 'unsupported', persistentThrows: c === 'throws' }); const l = layout();
      writeState(l.statePath, [liCookie()]);
      if (c !== 'no_dir') fs.mkdirSync(l.profileDir, { recursive: true });
      const rt = li(f, l);
      expect((await rt.open(URL_)).ok, c).toBe(true);
      expect(f.plain.n, c).toBe(1);
      await rt.close();
      expect(fs.existsSync(l.lockPath)).toBe(false);
    }
  });

  it('the default profile directory is off when a custom session path is given (tests never touch secrets/)', async () => {
    const f = fake(); const l = layout();
    writeState(l.statePath, [liCookie()]);
    const rt = createRuntime({ db: openDb(':memory:'), launcher: f.launcher, sessionPath: l.statePath, lockPath: l.lockPath, settleMs: 0, env: {} });
    await rt.open(URL_);
    expect(f.persistentCalls).toHaveLength(0);
    await rt.close();
  });

  it('keeps working with the scripted fake launcher of the existing tests (no profile support)', async () => {
    const l = layout(); writeState(l.statePath, [liCookie()]); fs.mkdirSync(l.profileDir, { recursive: true });
    const launcher = makeFakeLauncher({ pages: { '/in/jane-example/': { bodyText: 'x'.repeat(300) } } } as never, []);
    const rt = createRuntime({ db: openDb(':memory:'), launcher, sessionPath: l.statePath, lockPath: l.lockPath, profileDir: l.profileDir, settleMs: 0, env: {} });
    expect((await rt.open(URL_)).ok).toBe(true);
    expect(launcher.launches).toBe(1);
    await rt.close();
  });
});

describe('openPlatformContext, importStateOnce, refreshStateFile', () => {
  it('Naukri: takes the profile lock before launching; a held lock means the state-file launch, never a second Chrome on the directory', async () => {
    const root = tmp(); const dir = platformProfileDir('naukri', root); fs.mkdirSync(dir);
    const statePath = path.join(root, 'naukri-state.json'); writeState(statePath, [nkCookie]);
    const lockPath = path.join(root, 'naukri-profile.lock');
    const f = fake(); f.onPersistent = () => f.events.push(fs.existsSync(lockPath) ? 'locked' : 'unlocked');
    const r1 = await openPlatformContext({ name: 'naukri', statePath, launcher: f.launcher, profileDir: dir, profileLockPath: lockPath });
    expect(r1).toMatchObject({ ok: true, persistent: true });
    expect(f.events).toEqual(['locked']);
    const r2 = await openPlatformContext({ name: 'naukri', statePath, launcher: f.launcher, profileDir: dir, profileLockPath: lockPath });
    expect(r2).toMatchObject({ ok: true, persistent: false });
    expect(f.persistentCalls).toHaveLength(1);
    expect(f.plain.n).toBe(1);
    if (r1.ok) r1.lock?.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('a failed persistent launch releases the lock it took and falls back', async () => {
    const root = tmp(); const dir = platformProfileDir('naukri', root); fs.mkdirSync(dir);
    const statePath = path.join(root, 'naukri-state.json'); writeState(statePath, [nkCookie]);
    const lockPath = path.join(root, 'naukri-profile.lock');
    const r = await openPlatformContext({ name: 'naukri', statePath, launcher: fake({ persistentThrows: true }).launcher, profileDir: dir, profileLockPath: lockPath });
    expect(r).toMatchObject({ ok: true, persistent: false, lock: null });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('importStateOnce skips a missing state file without a marker, drops malformed cookies, and refreshStateFile checks the platform cookie name', async () => {
    const root = tmp(); const dir = path.join(root, 'p'); fs.mkdirSync(dir);
    const f = fake(); const ctx = (await f.launcher.launch({})).newContext as unknown as () => Promise<LiContext>;
    const c = await ctx();
    expect(await importStateOnce(c, dir, path.join(root, 'none.json'))).toEqual({ imported: false, cookies: 0 });
    expect(fs.existsSync(path.join(dir, STATE_IMPORT_MARKER))).toBe(false);
    const sp = path.join(root, 's.json'); writeState(sp, [wfCookie, { name: 5 }, null]);
    expect((await importStateOnce(c, dir, sp)).cookies).toBe(1);
    f.stateToReturn = { cookies: [nkCookie], origins: [] };
    expect(await refreshStateFile(c, path.join(root, 'w.json'), 'wellfound')).toBe(false);
    expect(fs.existsSync(path.join(root, 'w.json'))).toBe(false);
    f.stateToReturn = { cookies: [wfCookie], origins: [] };
    expect(await refreshStateFile(c, path.join(root, 'w.json'), 'wellfound')).toBe(true);
  });

  it('launchPersistentChrome keeps extensions on (ignoreDefaultArgs) in headless and headed mode', async () => {
    const f = fake();
    await launchPersistentChrome({ userDataDir: '/x', launcher: f.launcher });
    await launchPersistentChrome({ userDataDir: '/x', headed: true, launcher: f.launcher });
    expect(f.persistentCalls.map((c) => c.opts.ignoreDefaultArgs)).toEqual([['--disable-extensions'], ['--disable-extensions']]);
    expect(f.persistentCalls.map((c) => c.opts.headless)).toEqual([true, false]);
  });
});

describe('Naukri and Wellfound MCP sessions', () => {
  const baseDeps = (root: string, f: Fake) => ({
    db: openDb(':memory:'), chromium: f.launcher, settleMs: 0, paceMs: () => 0, confirmTimeoutMs: 50, env: { JOBBER_DRY_RUN: 'false' } as NodeJS.ProcessEnv,
    layoutCfg: { enabled: false, dir: path.join(root, 'layout') } as never,
  });

  it('Naukri: the session runs in the profile, the state file is refreshed on close and the profile lock is released', async () => {
    const root = tmp(); const dir = platformProfileDir('naukri', root); fs.mkdirSync(dir);
    const statePath = path.join(root, 'naukri-state.json'); writeState(statePath, [nkCookie]);
    const lockPath = path.join(root, 'naukri-profile.lock');
    const f = fake({ state: [nkCookie] });
    await naukriOpen({ url: 'https://www.naukri.com/job-listings-x-1' }, { ...baseDeps(root, f), sessionStatePath: statePath, profileDir: dir, profileLockPath: lockPath } as never);
    expect(f.persistentCalls).toHaveLength(1);
    expect(f.plain.n).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(true);
    f.stateToReturn = { cookies: [{ ...nkCookie, value: 'rotated' }], origins: [] };
    await naukriClose();
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).cookies[0].value).toBe('rotated');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('Wellfound: a held wellfound lock is session_locked with no launch; a free one opens the profile', async () => {
    const root = tmp(); const dir = platformProfileDir('wellfound', root); fs.mkdirSync(dir);
    const statePath = path.join(root, 'wellfound-state.json'); writeState(statePath, [wfCookie]);
    const lockPath = path.join(root, 'wellfound.lock');
    const f = fake({ state: [wfCookie] });
    const held = acquireLock(lockPath);
    const r = await wellfoundOpen({ url: 'https://wellfound.com/jobs' }, { ...baseDeps(root, f), sessionStatePath: statePath, lockPath, profileDir: dir } as never);
    expect(JSON.parse(r.split('\n')[0])).toMatchObject({ ok: false, code: 'session_locked' });
    expect(f.persistentCalls).toHaveLength(0);
    expect(f.plain.n).toBe(0);
    if (held.ok) held.handle.release();
    await wellfoundOpen({ url: 'https://wellfound.com/jobs' }, { ...baseDeps(root, f), sessionStatePath: statePath, lockPath, profileDir: dir } as never);
    expect(f.persistentCalls).toHaveLength(1);
    f.stateToReturn = { cookies: [{ ...wfCookie, value: 'rotated' }], origins: [] };
    await wellfoundClose();
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).cookies[0].value).toBe('rotated');
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('npm run browser:open --profile', () => {
  const io = () => { const lines: string[] = []; return { lines, io: { ask: async () => '', log: (l: string) => { lines.push(l); } } }; };

  it('parses --profile (default web), a URL and rejects duplicates and unknown flags', () => {
    expect(parseArgs([])).toEqual({ profile: 'web', url: null });
    expect(parseArgs(['--profile', 'naukri'])).toEqual({ profile: 'naukri', url: null });
    expect(parseArgs(['--profile=wellfound', 'https://a.example/'])).toEqual({ profile: 'wellfound', url: 'https://a.example/' });
    expect(parseArgs(['https://a.example/', '--profile', 'web'])).toEqual({ profile: 'web', url: 'https://a.example/' });
    expect(parseArgs(['--profile'])).toBeNull();
    expect(parseArgs(['--profile', 'a', '--profile', 'b'])).toBeNull();
    expect(parseArgs(['--x'])).toBeNull();
    expect(parseArgs(['https://a/', 'https://b/'])).toBeNull();
  });

  it('opens the platform profile headed at the Chrome Web Store by default, saves nothing else, and reports the extension count', async () => {
    const root = tmp(); const f = fake(); const i = io();
    const dir = platformProfileDir('naukri', root);
    // an installed extension appears in the profile while the window is open
    const ask = async () => { fs.mkdirSync(path.join(dir, 'Default', 'Extensions', 'nngceckbapebfimnlniiiahkandclblb'), { recursive: true }); return ''; };
    const gotos: string[] = [];
    const launcher = f.launcher as unknown as { launchPersistentContext: (d: string, o: Record<string, unknown>) => Promise<LiContext> };
    const orig = launcher.launchPersistentContext;
    launcher.launchPersistentContext = async (d, o) => { const c = await orig(d, o); const np = c.newPage; c.newPage = async () => { const p = await np(); const g = p.goto; p.goto = async (u: string, ...a: []) => { gotos.push(u); return g(u, ...a); }; return p; }; return c; };
    const r = await browserOpen(['--profile', 'naukri'], { io: { ask, log: i.io.log }, launcher: f.launcher, root });
    expect(r.code).toBe(0);
    expect(r.lines[r.lines.length - 1]).toContain('1 extension installed');
    expect(f.persistentCalls[0].dir).toBe(dir);
    expect(f.persistentCalls[0].opts.headless).toBe(false);
    expect(gotos[0]).toBe(CHROME_WEB_STORE);
    expect(fs.existsSync(path.join(root, 'naukri-profile.lock'))).toBe(false);
  });

  it('refuses while the profile lock is held (no launch), and refuses an unknown or burner profile', async () => {
    const root = tmp(); const f = fake();
    const held = acquireLock(path.join(root, 'wellfound.lock'));
    const r = await browserOpen(['--profile', 'wellfound'], { io: io().io, launcher: f.launcher, root });
    expect(r.code).toBe(1);
    expect(r.lines[r.lines.length - 1]).toMatch(/busy/);
    expect(f.persistentCalls).toHaveLength(0);
    if (held.ok) held.handle.release();
    expect((await browserOpen(['--profile', 'linkedin-burner'], { io: io().io, launcher: f.launcher, root })).code).toBe(2);
    expect((await browserOpen(['--profile', 'nope'], { io: io().io, launcher: f.launcher, root })).code).toBe(2);
    expect((await browserOpen(['--profile', 'naukri', 'http://x.example/'], { io: io().io, launcher: f.launcher, root })).code).toBe(2);
    expect(f.persistentCalls).toHaveLength(0);
  });

  it('the web profile keeps its rule: own-platform hosts are refused there', async () => {
    const f = fake();
    expect((await browserOpen(['--profile', 'web', 'https://www.naukri.com/x'], { io: io().io, launcher: f.launcher })).code).toBe(1);
  });

  it('extensionIds keeps only extension-id shaped directory names', () => {
    expect(extensionIds(() => ['nngceckbapebfimnlniiiahkandclblb', 'Temp', '.DS_Store'], '/p')).toEqual(['nngceckbapebfimnlniiiahkandclblb']);
    expect(extensionIds(() => { throw new Error('x'); }, '/p')).toEqual([]);
  });
});

describe('doctor: browser-profiles line', () => {
  const R = '/proj';
  const ctxOf = (files: string[]): DoctorContext => ({
    root: R, env: {}, run: async () => ({ stdout: '', code: 1 }),
    fs: {
      exists: (p) => files.includes(p) || files.some((k) => k.startsWith(p + '/')),
      read: () => { throw new Error('no'); }, mode: () => 0o600,
      list: (p) => files.filter((k) => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')).map((k) => k.slice(p.length + 1)),
    },
  });
  const check = () => setupAccountChecks.find((c) => c.id === 'browser-profiles')!;

  it('lists which profiles exist and whether Default/Extensions has entries, ids only', async () => {
    const ID = 'nngceckbapebfimnlniiiahkandclblb';
    const r = await check().run(ctxOf([`${R}/secrets/browser-profile-naukri/Default/Extensions/${ID}`, `${R}/secrets/browser-profile-wellfound/Default/Preferences`]));
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('naukri: 1 extension (nngceckb)');
    expect(r.detail).toContain('wellfound: no extensions');
    expect(r.detail).toContain('web: no profile yet');
    expect(r.detail).toContain('linkedin-main: no profile yet');
    expect(r.detail).not.toContain('burner');
  });

  it('is a skip with the install hint when no profile exists yet', async () => {
    const r = await check().run(ctxOf([]));
    expect(r.status).toBe('skip');
    expect(r.fix).toContain('browser:open');
  });
});
