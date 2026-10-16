import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main as linkedinLogin, type LoginIo } from '../scripts/linkedin-login.js';
import type { LiLauncher } from '../src/linkedin/types.js';

const io = (): LoginIo & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, ask: async (q) => (asked.push(q), '') };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('linkedin-login script', () => {
  it('opens headed real Chrome, waits for Enter, then saves a 0600 session (no account question)', async () => {
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
    const i = io();
    const code = await linkedinLogin({ io: i, launcher, outPath: out });
    expect(code).toBe(0);
    expect(i.asked).toEqual(['']);
    expect(launchOpts).toMatchObject({ channel: 'chrome', headless: false });
    expect(closed).toBe(true);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(out))).toEqual(['linkedin-main-state.json']);
  });

  it('returns 1 and saves nothing when Chrome cannot launch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = mkdtempSync(path.join(tmpdir(), 'jobber-'));
    const out = path.join(dir, 'linkedin-main-state.json');
    const launcher = { launch: async () => { throw new Error('no chrome'); } } as unknown as LiLauncher;
    expect(await linkedinLogin({ io: io(), launcher, outPath: out })).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('no LINKEDIN_LOGIN_ACCOUNT gate and no account flag left', () => {
  const root = path.resolve(__dirname, '..');
  it('is absent from .env.example and the login scripts', () => {
    for (const f of ['.env.example', 'scripts/linkedin-login.ts', 'scripts/naukri-login.ts']) {
      expect(readFileSync(path.join(root, f), 'utf8')).not.toContain('LINKEDIN_LOGIN_ACCOUNT');
    }
  });
  it('the login scripts read no process env, import no secrets reader and take no --account flag', () => {
    for (const f of ['scripts/linkedin-login.ts', 'scripts/naukri-login.ts']) {
      const t = readFileSync(path.join(root, f), 'utf8');
      expect(t).not.toMatch(/process\.env/);
      expect(t).not.toMatch(/readFileSync|dotenv/);
      expect(t).not.toMatch(/--account|loginConfirm/);
    }
  });
});
