// tests/onboarding-fixes.test.ts
// Onboarding review fixes: user-data init step, fact-gate doctor check, session auth cookies,
// gmail file mode and token age, dry-run banner.
import { describe, expect, it } from 'vitest';
import { hasLinkedinAuthCookie } from '../scripts/linkedin-login.js';
import { hasNaukriAuthCookie } from '../scripts/naukri-login.js';
import { setupAccountChecks, setupToolingChecks } from '../src/platform/checksSetup.js';
import type { DoctorContext } from '../src/platform/doctor.js';
import { scriptedIO } from '../src/setup/io.js';
import { DRY_RUN_BANNER, isDryRun } from '../src/setup/steps/final.js';
import { userdataStep } from '../src/setup/steps/userdata.js';
import type { SetupContext } from '../src/setup/runner.js';
import { emptyState } from '../src/setup/state.js';

type F = Record<string, { text?: string; mode?: number; mtimeMs?: number }>;
const R = '/proj';
function ctxOf(files: F, now = new Date('2026-10-14T00:00:00Z')): DoctorContext {
  return {
    root: R,
    env: {},
    run: async () => ({ stdout: '', code: 1 }),
    fs: {
      exists: (p) => p in files,
      read: (p) => {
        if (files[p]?.text === undefined) throw new Error('ENOENT');
        return files[p].text as string;
      },
      mode: (p) => (p in files ? (files[p].mode ?? 0o600) : null),
      mtimeMs: (p) => (p in files ? (files[p].mtimeMs ?? now.getTime()) : null),
      list: () => [],
    },
    now: () => now,
  };
}
const find = (list: { id: string; run: (c: DoctorContext) => Promise<{ status: string; detail: string }> }[], id: string) => {
  const c = list.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};

describe('userdata step', () => {
  function setup(existing: string[]) {
    const store = new Set<string>(existing);
    const copies: string[] = [];
    const ctx = {
      io: scriptedIO([]),
      root: R,
      env: {},
      fs: {
        exists: (p: string) => store.has(p) || p.startsWith('/proj/user-data.example/'),
        mkdirp: () => undefined,
        copy: (_f: string, to: string) => void copies.push(to),
        list: () => [],
      },
      state: emptyState(),
    } as unknown as SetupContext;
    return { ctx, copies };
  }
  it('copies every missing template and never overwrites', async () => {
    const t = setup(['/proj/user-data/resume.json']);
    expect(await userdataStep.run(t.ctx)).toBe('done');
    expect(t.copies).toContain('/proj/user-data/fact-gate.json');
    expect(t.copies).toContain('/proj/user-data/account.json');
    expect(t.copies).not.toContain('/proj/user-data/resume.json');
  });
});

describe('fact-gate-present check', () => {
  it('warns when missing and passes when present', async () => {
    const c = find(setupToolingChecks, 'fact-gate-present');
    expect((await c.run(ctxOf({}))).status).toBe('warn');
    expect((await c.run(ctxOf({ '/proj/user-data/fact-gate.json': { text: '{}' } }))).status).toBe('pass');
  });
});

describe('sessions check needs auth cookies', () => {
  const st = (cookies: unknown) => JSON.stringify({ cookies });
  const anon = { name: 'JSESSIONID', value: 'V', expires: 0 };
  it('fails an anonymous LinkedIn and Naukri session', async () => {
    const c = find(setupAccountChecks, 'sessions');
    const r = await c.run(
      ctxOf({
        '/proj/secrets/linkedin-main-state.json': { text: st([anon]) },
        '/proj/secrets/naukri-state.json': { text: st([anon]) },
      }),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('no auth cookie');
  });
  it('login helpers detect the auth cookie by name only', () => {
    expect(hasLinkedinAuthCookie({ cookies: [anon] })).toBe(false);
    expect(hasLinkedinAuthCookie({ cookies: [{ name: 'li_at' }] })).toBe(true);
    expect(hasNaukriAuthCookie({ cookies: [anon] })).toBe(false);
  });
});

describe('gmail-oauth file mode and token age', () => {
  const base = (over: F = {}): F => ({
    '/proj/secrets/gcp-oauth.keys.json': { text: '{}' },
    '/proj/secrets/gmail-credentials.json': { text: '{"refresh_token":"x"}' },
    ...over,
  });
  const c = find(setupToolingChecks.concat(setupAccountChecks), 'gmail-oauth');
  it('fails a world-readable credentials file', async () => {
    const r = await c.run(ctxOf(base({ '/proj/secrets/gmail-credentials.json': { text: '{"refresh_token":"x"}', mode: 0o644 } })));
    expect(r.status).toBe('fail');
  });
  it('warns when credentials are older than 6 days, passes when fresh', async () => {
    const now = new Date('2026-10-14T00:00:00Z');
    const old = now.getTime() - 7 * 86400000;
    const r = await c.run(ctxOf(base({ '/proj/secrets/gmail-credentials.json': { text: '{"refresh_token":"x"}', mtimeMs: old } }), now));
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('7 days');
    expect((await c.run(ctxOf(base(), now))).status).toBe('pass');
  });
});

describe('dry-run banner', () => {
  it('detects the flag like the runtime and has the owner-only wording', () => {
    expect(isDryRun({ JOBBER_DRY_RUN: ' TRUE ' })).toBe(true);
    expect(isDryRun({ JOBBER_DRY_RUN: '1' })).toBe(true);
    expect(isDryRun({ JOBBER_DRY_RUN: 'false' })).toBe(false);
    expect(isDryRun({})).toBe(false);
    expect(DRY_RUN_BANNER).toContain('DRY RUN is ON');
    expect(DRY_RUN_BANNER).toContain('yourself');
  });
});
