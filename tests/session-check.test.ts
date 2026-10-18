import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkLinkedinSession, checkNaukriSession } from '../src/sessions/check.js';
import { acquireLock } from '../src/linkedin/session.js';
import { main as linkedinMain } from '../scripts/linkedin-check.js';
import { main as naukriMain } from '../scripts/naukri-check.js';
import type { LiLauncher } from '../src/linkedin/types.js';

const SECRET = 'COOKIE_VALUE_MUST_NOT_PRINT';
// The script mains read halts from the database; point them at a file that does not exist.
process.env.JOBAPPLIER_DB = path.join(tmpdir(), 'jobber-check-no-such-db.sqlite');

function tmp(): string { return mkdtempSync(path.join(tmpdir(), 'jobber-check-')); }
function sessionFile(dir: string, name: string, cookieName: string, mode = 0o600): string {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify({ cookies: [{ name: cookieName, value: SECRET }], origins: [] }), { mode });
  chmodSync(p, mode);
  return p;
}

const snap = (o: Record<string, unknown>) => ({
  url: 'https://www.linkedin.com/feed/', title: 'Feed | LinkedIn', profile: null, results: [], invitations: [], messages: [],
  messageHeaderName: null, notices: [], dialogText: null, hasPasswordInput: false, bodyText: 'x'.repeat(400), ...o,
});

function fake(opts: { url: string; evalResult: unknown; launchThrows?: boolean }) {
  const seen = { storageStateCalls: 0, closed: false, gotos: [] as string[], ctxOpts: undefined as Record<string, unknown> | undefined };
  const launcher = {
    launch: async () => {
      if (opts.launchThrows) throw new Error('no chrome');
      return {
        newContext: async (o: Record<string, unknown>) => {
          seen.ctxOpts = o;
          return {
            newPage: async () => ({
              goto: async (u: string) => { seen.gotos.push(u); },
              url: () => opts.url,
              title: async () => 'T',
              evaluate: async () => opts.evalResult,
              waitForTimeout: async () => undefined,
            }),
            storageState: async () => { seen.storageStateCalls++; return {}; },
          };
        },
        close: async () => { seen.closed = true; },
      };
    },
  } as unknown as LiLauncher;
  return { seen, launcher };
}

afterEach(() => undefined);

describe('linkedin session check', () => {
  it('FAIL session_missing when the file does not exist', async () => {
    const d = tmp();
    const r = await checkLinkedinSession({ sessionPath: path.join(d, 'nope.json'), lockPath: path.join(d, 'l.lock') });
    expect(r.ok).toBe(false);
    expect(r.line).toBe('FAIL session_missing');
  });

  it('FAIL session_stale when older than the max age', async () => {
    const d = tmp();
    const p = sessionFile(d, 's.json', 'li_at');
    const r = await checkLinkedinSession({ sessionPath: p, lockPath: path.join(d, 'l.lock'), now: () => new Date(Date.now() + 90 * 86_400_000) });
    expect(r.line).toBe('FAIL session_stale');
  });

  it('FAIL session_invalid when the file has no li_at cookie', async () => {
    const d = tmp();
    const p = sessionFile(d, 's.json', 'other');
    expect((await checkLinkedinSession({ sessionPath: p, lockPath: path.join(d, 'l.lock') })).line).toBe('FAIL session_invalid');
  });

  it('FAIL halted when a linkedin halt is active, without launching', async () => {
    const d = tmp();
    const f = fake({ url: 'x', evalResult: snap({}) });
    const r = await checkLinkedinSession({ sessionPath: sessionFile(d, 's.json', 'li_at'), lockPath: path.join(d, 'l.lock'), launcher: f.launcher, halted: () => 'checkpoint: /feed/' });
    expect(r.line).toBe('FAIL halted');
    expect(f.seen.gotos).toEqual([]);
  });

  it('FAIL session_locked when another process holds the lock', async () => {
    const d = tmp();
    const lockPath = path.join(d, 'l.lock');
    const held = acquireLock(lockPath);
    expect(held.ok).toBe(true);
    const f = fake({ url: 'x', evalResult: snap({}) });
    const r = await checkLinkedinSession({ sessionPath: sessionFile(d, 's.json', 'li_at'), lockPath, launcher: f.launcher });
    expect(r.line).toBe('FAIL session_locked');
    expect(f.seen.gotos).toEqual([]);
    if (held.ok) held.handle.release();
  });

  it('FAIL chrome_unavailable and releases the lock when Chrome cannot start', async () => {
    const d = tmp();
    const lockPath = path.join(d, 'l.lock');
    const f = fake({ url: 'x', evalResult: snap({}), launchThrows: true });
    const r = await checkLinkedinSession({ sessionPath: sessionFile(d, 's.json', 'li_at'), lockPath, launcher: f.launcher });
    expect(r.line).toBe('FAIL chrome_unavailable');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('FAIL logged_out on the login wall, checkpoint on a checkpoint URL, captcha on a captcha page', async () => {
    const d = tmp();
    const base = { sessionPath: sessionFile(d, 's.json', 'li_at'), lockPath: path.join(d, 'l.lock') };
    const login = fake({ url: 'https://www.linkedin.com/login', evalResult: snap({ url: 'https://www.linkedin.com/login', hasPasswordInput: true }) });
    expect((await checkLinkedinSession({ ...base, launcher: login.launcher })).line).toBe('FAIL logged_out');
    const cp = fake({ url: 'https://www.linkedin.com/checkpoint/challenge/x', evalResult: snap({ url: 'https://www.linkedin.com/checkpoint/challenge/x' }) });
    expect((await checkLinkedinSession({ ...base, launcher: cp.launcher })).line).toBe('FAIL checkpoint');
    const cap = fake({ url: 'https://www.linkedin.com/feed/', evalResult: snap({ title: 'Quick security check', bodyText: 'verify you are human' }) });
    expect((await checkLinkedinSession({ ...base, launcher: cap.launcher })).line).toBe('FAIL captcha');
  });

  it('OK on the feed: no state saved, browser closed, lock released, no cookie value printed', async () => {
    const d = tmp();
    const lockPath = path.join(d, 'l.lock');
    const p = sessionFile(d, 's.json', 'li_at');
    const before = readFileSync(p, 'utf8');
    const f = fake({ url: 'https://www.linkedin.com/feed/', evalResult: snap({}) });
    const r = await checkLinkedinSession({ sessionPath: p, lockPath, launcher: f.launcher });
    expect(r).toEqual({ ok: true, line: 'OK session valid' });
    expect(f.seen.gotos).toEqual(['https://www.linkedin.com/feed/']);
    expect(f.seen.storageStateCalls).toBe(0);
    expect(f.seen.closed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe(before);
    expect(r.line).not.toContain(SECRET);
  });

  it('script main prints the one line and returns 0 on OK, 1 on FAIL', async () => {
    const d = tmp();
    const lines: string[] = [];
    const log = (s: string) => lines.push(s);
    const ok = fake({ url: 'https://www.linkedin.com/feed/', evalResult: snap({}) });
    expect(await linkedinMain({ sessionPath: sessionFile(d, 's.json', 'li_at'), lockPath: path.join(d, 'l.lock'), launcher: ok.launcher, log })).toBe(0);
    expect(await linkedinMain({ sessionPath: path.join(d, 'nope.json'), lockPath: path.join(d, 'l.lock'), log })).toBe(1);
    expect(lines).toEqual(['OK session valid', 'FAIL session_missing']);
  });
});

const nk = (o: Record<string, unknown>) => ({ url: 'https://www.naukri.com/mnjuser/homepage', title: 'Home | Mynaukri', hasPassword: false, head: 'welcome', ...o });

describe('naukri session check', () => {
  it('FAIL session_missing, session_invalid (no nauk cookie), session_stale', async () => {
    const d = tmp();
    expect((await checkNaukriSession({ sessionPath: path.join(d, 'nope.json') })).line).toBe('FAIL session_missing');
    expect((await checkNaukriSession({ sessionPath: sessionFile(d, 'a.json', 'other') })).line).toBe('FAIL session_invalid');
    const p = sessionFile(d, 'b.json', 'nauk_at');
    expect((await checkNaukriSession({ sessionPath: p, now: () => new Date(Date.now() + 90 * 86_400_000) })).line).toBe('FAIL session_stale');
  });

  it('FAIL halted without launching', async () => {
    const d = tmp();
    const f = fake({ url: 'x', evalResult: nk({}) });
    const r = await checkNaukriSession({ sessionPath: sessionFile(d, 's.json', 'nauk_at'), launcher: f.launcher, halted: () => 'send failures' });
    expect(r.line).toBe('FAIL halted');
    expect(f.seen.gotos).toEqual([]);
  });

  it('FAIL blocked on Access Denied, logged_out on the login page, chrome_unavailable', async () => {
    const d = tmp();
    const base = { sessionPath: sessionFile(d, 's.json', 'nauk_at') };
    const denied = fake({ url: 'https://www.naukri.com/', evalResult: nk({ title: 'Access Denied' }) });
    expect((await checkNaukriSession({ ...base, launcher: denied.launcher })).line).toBe('FAIL blocked');
    const out = fake({ url: 'https://www.naukri.com/nlogin/login', evalResult: nk({ url: 'https://www.naukri.com/nlogin/login', hasPassword: true }) });
    expect((await checkNaukriSession({ ...base, launcher: out.launcher })).line).toBe('FAIL logged_out');
    const nochrome = fake({ url: 'x', evalResult: nk({}), launchThrows: true });
    expect((await checkNaukriSession({ ...base, launcher: nochrome.launcher })).line).toBe('FAIL chrome_unavailable');
  });

  it('OK on the logged-in home: no state saved, browser closed, headless context options', async () => {
    const d = tmp();
    const f = fake({ url: 'https://www.naukri.com/mnjuser/homepage', evalResult: nk({}) });
    const r = await checkNaukriSession({ sessionPath: sessionFile(d, 's.json', 'nauk_at'), launcher: f.launcher });
    expect(r).toEqual({ ok: true, line: 'OK session valid' });
    expect(f.seen.storageStateCalls).toBe(0);
    expect(f.seen.closed).toBe(true);
    expect(f.seen.ctxOpts).toMatchObject({ locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
    expect(r.line).not.toContain(SECRET);
  });

  it('script main returns 0 on OK and 1 on FAIL', async () => {
    const d = tmp();
    const lines: string[] = [];
    const log = (s: string) => lines.push(s);
    const f = fake({ url: 'https://www.naukri.com/mnjuser/homepage', evalResult: nk({}) });
    expect(await naukriMain({ sessionPath: sessionFile(d, 's.json', 'nauk_at'), launcher: f.launcher, log })).toBe(0);
    expect(await naukriMain({ sessionPath: path.join(d, 'nope.json'), log })).toBe(1);
    expect(lines).toEqual(['OK session valid', 'FAIL session_missing']);
  });
});

describe('wiring', () => {
  it('package.json has linkedin:check and naukri:check', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['linkedin:check']).toBe('tsx scripts/linkedin-check.ts');
    expect(pkg.scripts['naukri:check']).toBe('tsx scripts/naukri-check.ts');
  });
});
