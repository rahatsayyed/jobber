import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createWebRuntime } from '../src/webcore/runtime.js';
import { acquireLock, saveSiteStateAtomic, siteSessionPath } from '../src/webcore/session.js';
import { IMPORT_MARKER } from '../src/webcore/profile.js';
import { run as assist } from '../scripts/apply-assist.js';
import { run as browserOpen } from '../scripts/browser-open.js';
import { chromeTimeToIso, run as history } from '../scripts/browser-history.js';
import { addEscalation } from '../src/outreach/service.js';
import { threadRefFor } from '../src/applier/escalate.js';
import type { LiContext, LiLauncher, LiPage } from '../src/linkedin/types.js';

const dirs: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webprofile-'))); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const COOKIE = { name: 'sid', value: 'v-secret', domain: '.acme.example.com', path: '/', expires: 4102444800, httpOnly: true, secure: true, sameSite: 'Lax' };

interface Fake {
  launcher: LiLauncher;
  persistentCalls: Array<{ dir: string; opts: Record<string, unknown> }>;
  plainLaunches: Array<Record<string, unknown>>;
  added: unknown[][];
  gotos: string[];
  closed: { n: number };
}

function fake(o: { persistent?: boolean; persistentThrows?: boolean; stateCookies?: unknown[] } = {}): Fake {
  const f: Fake = { launcher: null as unknown as LiLauncher, persistentCalls: [], plainLaunches: [], added: [], gotos: [], closed: { n: 0 } };
  let current = 'about:blank';
  const page = {
    goto: async (u: string) => { current = u; f.gotos.push(u); },
    url: () => current, title: async () => 't', evaluate: async () => ({}), locator: () => ({}), waitForTimeout: async () => undefined,
  } as unknown as LiPage;
  const ctx: LiContext = {
    newPage: async () => page,
    storageState: async () => ({ cookies: o.stateCookies ?? [COOKIE], origins: [] }),
    waitForEvent: async () => page,
    addCookies: async (c: unknown[]) => { f.added.push(c); },
  };
  const browser = { newContext: async () => ctx, close: async () => { f.closed.n += 1; } };
  const launcher: Record<string, unknown> = { launch: async (opts: Record<string, unknown>) => { f.plainLaunches.push(opts); return browser; } };
  if (o.persistent !== false) {
    launcher['launchPersistentContext'] = async (dir: string, opts: Record<string, unknown>) => {
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
  return { root, lockPath: path.join(root, 'web.lock'), sessionDir: path.join(root, 'site-sessions'), profileDir: path.join(root, 'browser-profile') };
}

const rt = (f: Fake, l: ReturnType<typeof layout>, profileDir: string | null = l.profileDir) =>
  createWebRuntime({ db: openDb(':memory:'), launcher: f.launcher, lockPath: l.lockPath, sessionDir: l.sessionDir, profileDir, config: { minGapSec: 0, settleMs: 0 }, env: {} });
const OPEN = { allowedHosts: ['acme.example.com'], jobId: 'j1' };

describe('web runtime: one persistent profile', () => {
  it('launches the persistent profile headless with the password manager off, directory 0700', async () => {
    const f = fake(); const l = layout();
    const r = rt(f, l);
    expect((await r.open('https://jobs.acme.example.com/apply/1', OPEN)).ok).toBe(true);
    expect(f.persistentCalls).toHaveLength(1);
    const { dir, opts } = f.persistentCalls[0];
    expect(dir).toBe(l.profileDir);
    expect(opts.headless).toBe(true);
    expect(opts.channel).toBe('chrome');
    expect(opts.args).toEqual(expect.arrayContaining(['--headless=new', '--disable-save-password-bubble']));
    expect(f.plainLaunches).toHaveLength(0);
    expect(fs.statSync(l.profileDir).mode & 0o777).toBe(0o700);
    const prefs = JSON.parse(fs.readFileSync(path.join(l.profileDir, 'Default', 'Preferences'), 'utf8'));
    expect(prefs.credentials_enable_service).toBe(false);
    expect(prefs.profile.password_manager_enabled).toBe(false);
    await r.close();
    expect(f.closed.n).toBe(1);
  });

  it('imports the old per-host session cookies once and keeps the files', async () => {
    const f = fake(); const l = layout();
    saveSiteStateAtomic(siteSessionPath('acme.example.com', l.sessionDir), { cookies: [COOKIE, { name: 'bad' }], origins: [] });
    const r = rt(f, l);
    await r.open('https://jobs.acme.example.com/apply/1', OPEN);
    expect(f.added).toHaveLength(1);
    expect(f.added[0]).toEqual([{ name: 'sid', value: 'v-secret', domain: '.acme.example.com', path: '/', expires: 4102444800, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    expect(fs.existsSync(path.join(l.profileDir, IMPORT_MARKER))).toBe(true);
    await r.close();
    await r.open('https://jobs.acme.example.com/apply/2', OPEN);
    expect(f.added).toHaveLength(1); // not imported twice
    expect(fs.existsSync(siteSessionPath('acme.example.com', l.sessionDir))).toBe(true);
    await r.close();
  });

  it('falls back to a fresh browser plus the per-host file when the profile cannot be opened or is unsupported', async () => {
    for (const o of [{ persistentThrows: true }, { persistent: false }]) {
      const f = fake(o); const l = layout();
      saveSiteStateAtomic(siteSessionPath('acme.example.com', l.sessionDir), { cookies: [COOKIE], origins: [] });
      const r = rt(f, l);
      expect((await r.open('https://jobs.acme.example.com/apply/1', OPEN)).ok).toBe(true);
      expect(f.plainLaunches).toHaveLength(1);
      await r.close();
    }
  });

  it('keeps the one-lock behaviour: a second session is refused while the first is open', async () => {
    const f = fake(); const l = layout();
    const a = rt(f, l); const b = rt(fake(), l);
    expect((await a.open('https://jobs.acme.example.com/a', OPEN)).ok).toBe(true);
    expect(await b.open('https://jobs.acme.example.com/b', OPEN)).toMatchObject({ ok: false, code: 'session_locked' });
    await a.close();
    expect((await b.open('https://jobs.acme.example.com/b', OPEN)).ok).toBe(true);
    await b.close();
  });
});

function seedAssistDb(l: ReturnType<typeof layout>) {
  const db = openDb(':memory:');
  const job = (id: string, host: string, status: string | null) => {
    db.prepare('INSERT INTO jobs (id, source, title, company, apply_url) VALUES (?,?,?,?,?)').run(id, 'x', 'Engineer', 'Acme', `https://${host}/apply/${id}`);
    db.prepare('INSERT INTO outreach_queue (job_id, apply_platform, apply_status, apply_note) VALUES (?,?,?,?)').run(id, 'browser', status, status ? 'assist:captcha' : null);
  };
  job('j1', 'careers.acme.example.com', 'needs_human');
  job('j2', 'careers.acme.example.com', 'needs_human');
  job('j3', 'other.example.org', 'needs_human');
  db.prepare("INSERT INTO apply_host_blocks (host, kind, at, run_id) VALUES ('careers.acme.example.com','captcha','2026-11-01T00:00:00Z','r1')").run();
  db.prepare("INSERT INTO apply_host_blocks (host, kind, at, run_id) VALUES ('careers.acme.example.com','bot_wall','2026-11-01T00:00:00Z','r1')").run();
  addEscalation(db, { runId: null, platform: 'apply', reason: 'apply:needs_human', threadRef: threadRefFor('assist', 'careers.acme.example.com'), detail: 'needs you on careers.acme.example.com (captcha): run npm run apply:assist -- j1' }, new Date());
  return db;
}
const io = () => { const asked: string[] = []; return { asked, io: { log: () => undefined, ask: async (q: string) => { asked.push(q); return ''; } } }; };

describe('apply:assist', () => {
  it('opens the job page headed in the profile, saves the host session, releases every job parked on that host and resolves its escalation', async () => {
    const l = layout(); const f = fake(); const db = seedAssistDb(l); const i = io();
    const r = await assist(['j1'], { db, io: i.io, launcher: f.launcher, lockPath: l.lockPath, sessionDir: l.sessionDir, profileDir: l.profileDir, env: {}, stopFile: path.join(l.root, 'STOP') });
    expect(r.code).toBe(0);
    expect(f.persistentCalls[0].opts.headless).toBe(false);
    expect(f.gotos).toEqual(['https://careers.acme.example.com/apply/j1']);
    expect(i.asked).toHaveLength(1); // one Enter prompt; what the owner typed is never read
    const file = siteSessionPath('careers.acme.example.com', l.sessionDir);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).cookies).toHaveLength(1);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const st = (id: string) => (db.prepare('SELECT apply_status FROM outreach_queue WHERE job_id = ?').get(id) as { apply_status: string | null }).apply_status;
    expect([st('j1'), st('j2'), st('j3')]).toEqual([null, null, 'needs_human']);
    // the owner's pass clears the captcha block but never the bot_wall record
    expect(db.prepare("SELECT kind FROM apply_host_blocks WHERE host = 'careers.acme.example.com'").all()).toEqual([{ kind: 'bot_wall' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM escalations WHERE resolved_at IS NULL').get()).toEqual({ n: 0 });
    expect(r.lines.join('\n')).not.toContain('v-secret');
    expect(acquireLock(l.lockPath).ok).toBe(true); // the lock was released
  });

  it('refuses a platform host, a busy browser, the kill switch and a missing job; saves nothing when the state cannot be read', async () => {
    const l = layout(); const db = seedAssistDb(l); const stopFile = path.join(l.root, 'STOP');
    const base = { db, io: io().io, launcher: fake().launcher, lockPath: l.lockPath, sessionDir: l.sessionDir, profileDir: l.profileDir, env: {}, stopFile };
    db.prepare("UPDATE jobs SET apply_url = 'https://www.linkedin.com/jobs/view/1' WHERE id = 'j3'").run();
    expect((await assist(['j3'], base)).lines[0]).toContain('own login command');
    expect((await assist(['nope'], base)).code).toBe(1);
    const held = acquireLock(l.lockPath);
    expect(held.ok && (await assist(['j1'], base)).lines.join(' ')).toContain('busy');
    if (held.ok) held.handle.release();
    fs.writeFileSync(stopFile, '');
    expect((await assist(['j1'], base)).lines[0]).toContain('kill switch');
    fs.rmSync(stopFile);
    const broken = fake({ stateCookies: undefined });
    broken.launcher = { ...(broken.launcher as object), launchPersistentContext: async () => ({ newPage: async () => ({ goto: async () => undefined }), storageState: async () => null, close: async () => undefined }) } as unknown as LiLauncher;
    const r = await assist(['j1'], { ...base, launcher: broken.launcher });
    expect(r.code).toBe(1);
    expect((db.prepare("SELECT apply_status FROM outreach_queue WHERE job_id = 'j1'").get() as { apply_status: string }).apply_status).toBe('needs_human');
  });

  it('falls back to the per-host session file when the launcher has no persistent profile', async () => {
    const l = layout(); const f = fake({ persistent: false }); const db = seedAssistDb(l);
    const r = await assist(['j2'], { db, io: io().io, launcher: f.launcher, lockPath: l.lockPath, sessionDir: l.sessionDir, profileDir: l.profileDir, env: {}, stopFile: path.join(l.root, 'STOP') });
    expect(r.code).toBe(0);
    expect(f.plainLaunches[0]).toMatchObject({ headless: false });
    expect(fs.existsSync(siteSessionPath('careers.acme.example.com', l.sessionDir))).toBe(true);
  });
});

describe('browser:open and browser:history', () => {
  it('browser:open opens an https page headed in the profile and saves; platform hosts and bad URLs are refused', async () => {
    const l = layout(); const f = fake();
    const r = await browserOpen(['https://www.google.com/'], { io: io().io, launcher: f.launcher, lockPath: l.lockPath, sessionDir: l.sessionDir, profileDir: l.profileDir });
    expect(r.code).toBe(0);
    expect(f.persistentCalls[0].opts.headless).toBe(false);
    expect((await browserOpen(['http://x.example.com'], { io: io().io, launcher: f.launcher })).code).toBe(2);
    expect((await browserOpen(['https://www.naukri.com/x'], { io: io().io, launcher: f.launcher })).code).toBe(1);
  });

  it('browser:history copies Chrome\'s History file, filters by host, newest first, strips query strings, and says so when there is no profile', () => {
    const l = layout();
    expect(history([], l.profileDir)).toMatchObject({ code: 1 });
    fs.mkdirSync(path.join(l.profileDir, 'Default'), { recursive: true });
    const h = new Database(path.join(l.profileDir, 'Default', 'History'));
    h.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER)');
    const chrome = (iso: string) => (Date.parse(iso) + 11_644_473_600_000) * 1000;
    const ins = h.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?,?,?,?)');
    ins.run('https://careers.acme.example.com/apply/1?token=SECRET', 'Apply', 3, chrome('2026-11-01T10:00:00Z'));
    ins.run('https://www.google.com/search?q=acme', 'acme - Google', 1, chrome('2026-11-02T10:00:00Z'));
    h.close();
    expect(chromeTimeToIso(chrome('2026-11-02T10:00:00Z'))).toBe('2026-11-02T10:00:00.000Z');
    const all = history(['--limit', '10'], l.profileDir);
    expect(all.lines[0]).toContain('www.google.com');
    expect(all.lines.join('\n')).not.toContain('SECRET');
    const one = history(['--host', 'acme.example.com'], l.profileDir);
    expect(one.lines).toHaveLength(1);
    expect(one.lines[0]).toContain('x3');
    expect(vi.isMockFunction(history)).toBe(false);
  });
});
