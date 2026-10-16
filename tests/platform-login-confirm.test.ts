import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { confirmAccount, type LoginIo } from '../src/platform/loginConfirm.js';
import { main as linkedinLogin } from '../scripts/linkedin-login.js';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { LiLauncher } from '../src/linkedin/types.js';

const io = (isTTY: boolean, answer = ''): LoginIo & { asked: string[] } => {
  const asked: string[] = [];
  return { isTTY, asked, ask: async (q) => (asked.push(q), answer) };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('confirmAccount', () => {
  it('--account main passes without a TTY and without asking', async () => {
    const i = io(false);
    expect(await confirmAccount(['--account', 'main'], i, 'main')).toEqual({ ok: true });
    expect(await confirmAccount(['--account=main'], i, 'main')).toEqual({ ok: true });
    expect(i.asked).toEqual([]);
  });
  it('a different --account value is refused even on a TTY', async () => {
    expect((await confirmAccount(['--account', 'burner'], io(true, 'y'), 'main')).ok).toBe(false);
  });
  it('TTY y/yes passes, n and empty refuse', async () => {
    expect((await confirmAccount([], io(true, 'y'), 'main')).ok).toBe(true);
    expect((await confirmAccount([], io(true, ' YES '), 'main')).ok).toBe(true);
    expect((await confirmAccount([], io(true, 'n'), 'main')).ok).toBe(false);
    expect((await confirmAccount([], io(true, ''), 'main')).ok).toBe(false);
  });
  it('no flag and no TTY refuses without asking', async () => {
    const i = io(false, 'y');
    const r = await confirmAccount([], i, 'main');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('--account main');
    expect(i.asked).toEqual([]);
  });
  it('the environment value LINKEDIN_LOGIN_ACCOUNT=main has no effect', async () => {
    vi.stubEnv('LINKEDIN_LOGIN_ACCOUNT', 'main');
    expect((await confirmAccount([], io(false), 'main')).ok).toBe(false);
  });
});

describe('linkedin-login script', () => {
  it('refuses with exit 2 without the flag or a TTY, and never launches a browser', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const launch = vi.fn();
    const code = await linkedinLogin([], { io: io(false), launcher: { launch } as unknown as LiLauncher });
    expect(code).toBe(2);
    expect(launch).not.toHaveBeenCalled();
  });
  it('saves a 0600 session through the injected Chrome launcher', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = mkdtempSync(path.join(tmpdir(), 'jobber-'));
    const out = path.join(dir, 'secrets', 'linkedin-main-state.json');
    const state = { cookies: [{ name: 'li_at', value: 'SECRET_VALUE' }], origins: [] };
    let launchOpts: Record<string, unknown> = {};
    let closed = false;
    const launcher = {
      launch: async (o: Record<string, unknown>) => {
        launchOpts = o;
        return {
          newContext: async () => ({
            newPage: async () => ({ goto: async () => undefined }),
            storageState: async () => state,
          }),
          close: async () => { closed = true; },
        };
      },
    } as unknown as LiLauncher;
    const code = await linkedinLogin(['--account', 'main'], { io: io(false), launcher, outPath: out });
    expect(code).toBe(0);
    expect(launchOpts).toMatchObject({ channel: 'chrome', headless: false });
    expect(closed).toBe(true);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(out))).toEqual(['linkedin-main-state.json']);
  });
});

describe('no LINKEDIN_LOGIN_ACCOUNT gate left', () => {
  const root = path.resolve(__dirname, '..');
  it('is absent from .env.example and the login scripts', () => {
    for (const f of ['.env.example', 'scripts/linkedin-login.ts', 'scripts/naukri-login.ts', 'src/platform/loginConfirm.ts']) {
      expect(readFileSync(path.join(root, f), 'utf8')).not.toContain('LINKEDIN_LOGIN_ACCOUNT');
    }
  });
  it('the login scripts import no secrets reader and read no process env', () => {
    for (const f of ['scripts/linkedin-login.ts', 'scripts/naukri-login.ts']) {
      const t = readFileSync(path.join(root, f), 'utf8');
      expect(t).not.toMatch(/process\.env/);
      expect(t).not.toMatch(/readFileSync|dotenv/);
    }
  });
});
