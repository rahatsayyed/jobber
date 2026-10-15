// tests/setup-skips.test.ts
import { describe, expect, it } from 'vitest';
import { SKIP_SPECS, skippedFeatures } from '../src/setup/skips.js';
import { emptyState, loadState, saveState, type SetupState } from '../src/setup/state.js';

const fsNone = { exists: () => false };
const spec = (id: string) => SKIP_SPECS.find((s) => s.id === id)!;
const skipped = (...ids: string[]): SetupState => {
  const s = emptyState();
  for (const id of ids) s.steps[id] = { status: 'skipped', at: '2026-10-15T00:00:00Z' };
  return s;
};

describe('skip catalog', () => {
  it('telegram', () => {
    const t = spec('telegram');
    expect(t.stepId).toBe('telegram');
    expect(t.checkIds).toEqual(['telegram-api', 'ccgram-env', 'daemon']);
    expect(t.configured({}, fsNone, '/r')).toBe(false);
    expect(t.configured({ TELEGRAM_BOT_TOKEN: '' }, fsNone, '/r')).toBe(false);
    expect(t.configured({ TELEGRAM_BOT_TOKEN: '1:A' }, fsNone, '/r')).toBe(true);
  });
  it('dashboard', () => {
    const d = spec('dashboard');
    expect(d.checkIds).toEqual(['web', 'dashboard-login']);
    expect(d.configured({}, fsNone, '/r')).toBe(false);
    for (const k of ['WEB_AUTH_MODE', 'WEB_OIDC_CLIENT_ID', 'DASHBOARD_ALLOWED_EMAIL']) {
      expect(d.configured({ [k]: 'x' }, fsNone, '/r')).toBe(true);
    }
  });
  it('gmail uses GMAIL_OAUTH_PATH or the default', () => {
    const g = spec('gmail');
    expect(g.checkIds).toEqual(['gmail-oauth']);
    const seen: string[] = [];
    const fs = {
      exists: (p: string) => {
        seen.push(p);
        return p === '/r/secrets/gcp-oauth.keys.json';
      },
    };
    expect(g.configured({}, fs, '/r')).toBe(true);
    expect(g.configured({ GMAIL_OAUTH_PATH: './k.json' }, fs, '/r')).toBe(false);
    expect(seen).toContain('/r/k.json');
    expect(
      g.configured({ GMAIL_OAUTH_PATH: '/abs/k.json' }, { exists: (p) => p === '/abs/k.json' }, '/r'),
    ).toBe(true);
  });
  it('apikeys: any complete provider', () => {
    const a = spec('apikeys');
    expect(a.checkIds).toEqual(['api-keys']);
    expect(a.configured({}, fsNone, '/r')).toBe(false);
    expect(a.configured({ ADZUNA_APP_ID: 'x' }, fsNone, '/r')).toBe(false);
    expect(a.configured({ ADZUNA_APP_ID: 'x', ADZUNA_APP_KEY: 'y' }, fsNone, '/r')).toBe(true);
    expect(a.configured({ SERPER_API_KEY: 'x' }, fsNone, '/r')).toBe(true);
    expect(a.configured({ HUNTER_API_KEY: 'x' }, fsNone, '/r')).toBe(true);
  });
  it('skippedFeatures needs skipped status and unconfigured', () => {
    const base = { env: {}, fs: fsNone, root: '/r' };
    expect(skippedFeatures({ ...base, state: emptyState() })).toEqual([]);
    expect(skippedFeatures({ ...base, state: skipped('telegram', 'gmail') })).toEqual(['telegram', 'gmail']);
    expect(
      skippedFeatures({ ...base, env: { TELEGRAM_BOT_TOKEN: '1:A' }, state: skipped('telegram') }),
    ).toEqual([]);
    const done = emptyState();
    done.steps.telegram = { status: 'done', at: 'x' };
    expect(skippedFeatures({ ...base, state: done })).toEqual([]);
  });
  it('lose lines are short ASCII', () => {
    for (const s of SKIP_SPECS) {
      expect(s.lose.length).toBeGreaterThan(0);
      expect(s.lose.length).toBeLessThanOrEqual(2);
      for (const l of s.lose) {
        expect(l.length).toBeLessThanOrEqual(110);
        expect(l).toMatch(/^[\x20-\x7e]+$/);
      }
    }
  });
});

describe('state mode', () => {
  const mem = () => {
    const files = new Map<string, string>();
    return {
      files,
      exists: (p: string) => files.has(p),
      read: (p: string) => files.get(p) ?? '',
      write: (p: string, d: string) => void files.set(p, d),
      chmod: () => {},
      rename: (a: string, b: string) => {
        files.set(b, files.get(a)!);
        files.delete(a);
      },
    };
  };
  const now = () => new Date('2026-10-15T00:00:00Z');
  it('round trips mode and mode_at', () => {
    const fs = mem();
    const s = emptyState();
    s.mode = 'agent';
    s.mode_at = '2026-10-15T00:00:00Z';
    saveState('s', s, fs as never, now);
    const l = loadState('s', fs);
    expect(l.mode).toBe('agent');
    expect(l.mode_at).toBe('2026-10-15T00:00:00Z');
  });
  it('drops unknown mode and loads an 8E file unchanged', () => {
    const fs = mem();
    fs.files.set('a', JSON.stringify({ version: 1, steps: {}, answers: {}, mode: 'robot', mode_at: 5 }));
    const l = loadState('a', fs);
    expect(l.mode).toBeUndefined();
    expect(l.mode_at).toBeUndefined();
    fs.files.set('b', JSON.stringify({ version: 1, steps: {}, answers: {}, guide_offered: true }));
    expect(loadState('b', fs)).toEqual({ version: 1, steps: {}, answers: {}, guide_offered: true });
  });
  it('saveState still refuses secret answer keys', () => {
    const s = emptyState();
    s.mode = 'terminal';
    s.answers.api_key = 'x';
    expect(() => saveState('s', s, mem() as never, now)).toThrow();
  });
});
