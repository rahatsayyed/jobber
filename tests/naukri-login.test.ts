import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, hasNaukriAuthCookie } from '../scripts/naukri-login.js';
import { HEADLESS_CONTEXT_OPTIONS } from '../src/sources/naukri.js';
import type { LoginIo } from '../src/platform/loginConfirm.js';
import type { LiLauncher } from '../src/linkedin/types.js';

const io: LoginIo = { isTTY: false, ask: async () => '' };

function fake(state: unknown) {
  const seen: { launch?: Record<string, unknown>; ctx?: Record<string, unknown>; url?: string; closed: boolean } = { closed: false };
  const launcher = {
    launch: async (o: Record<string, unknown>) => {
      seen.launch = o;
      return {
        newContext: async (c: Record<string, unknown>) => {
          seen.ctx = c;
          return {
            newPage: async () => ({ goto: async (u: string) => { seen.url = u; } }),
            storageState: async () => state,
          };
        },
        close: async () => { seen.closed = true; },
      };
    },
  } as unknown as LiLauncher;
  return { seen, launcher };
}

afterEach(() => vi.restoreAllMocks());

describe('naukri:login', () => {
  it('refuses with exit 2 without --account main on a non-terminal, launching nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = fake({});
    expect(await main([], { io, launcher: f.launcher })).toBe(2);
    expect(f.seen.launch).toBeUndefined();
  });

  it('opens headed real Chrome with the Naukri context options and saves 0600', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = mkdtempSync(path.join(tmpdir(), 'jobber-'));
    const out = path.join(dir, 'secrets', 'naukri-state.json');
    const f = fake({ cookies: [{ name: 'nauk_at', value: 'SECRET_VALUE' }, { name: 'x', value: 'y' }], origins: [] });
    expect(await main(['--account', 'main'], { io, launcher: f.launcher, outPath: out })).toBe(0);
    expect(f.seen.launch).toMatchObject({ channel: 'chrome', headless: false });
    expect(f.seen.ctx).toMatchObject({ ...HEADLESS_CONTEXT_OPTIONS });
    expect(f.seen.url).toContain('naukri.com');
    expect(f.seen.closed).toBe(true);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(out))).toEqual(['naukri-state.json']);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Saved session (2 cookies)');
    expect(printed).not.toContain('SECRET_VALUE');
  });

  it('does not save a state without a Naukri login cookie', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = mkdtempSync(path.join(tmpdir(), 'jobber-'));
    const out = path.join(dir, 'naukri-state.json');
    const f = fake({ cookies: [{ name: 'tracking', value: 'z' }], origins: [] });
    expect(await main(['--account', 'main'], { io, launcher: f.launcher, outPath: out })).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(f.seen.closed).toBe(true);
  });

  it('hasNaukriAuthCookie checks names only', () => {
    expect(hasNaukriAuthCookie({ cookies: [{ name: 'nauk_sid' }] })).toBe(true);
    expect(hasNaukriAuthCookie({ cookies: [{ name: 'a', value: 'nauk' }] })).toBe(false);
    expect(hasNaukriAuthCookie(null)).toBe(false);
  });

  it('is registered as an npm script', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.scripts['naukri:login']).toBe('tsx scripts/naukri-login.ts');
    expect(Object.values(pkg.scripts).join(' ')).not.toMatch(/save-(naukri|linkedin)-session/);
  });
});
