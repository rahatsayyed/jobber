import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { haltPlatform } from '../src/outreach/limits.js';
import { acquireLock } from '../src/linkedin/session.js';
import { createWebRuntime, hostAllowed } from '../src/webcore/runtime.js';
import { siteSessionPath, checkSiteSessionFile, saveSiteStateAtomic } from '../src/webcore/session.js';
import type { LiBrowser, LiContext, LiLauncher, LiPage } from '../src/linkedin/types.js';

interface Fake {
  launcher: LiLauncher;
  launches: number;
  closes: number;
  gotos: string[];
  contextOpts: Array<Record<string, unknown>>;
  redirect: Record<string, string>;
}

function fake(): Fake {
  const f: Fake = { launches: 0, closes: 0, gotos: [], contextOpts: [], redirect: {}, launcher: null as unknown as LiLauncher };
  f.launcher = {
    async launch(): Promise<LiBrowser> {
      f.launches++;
      return {
        async newContext(opts): Promise<LiContext> {
          f.contextOpts.push(opts);
          let cur = 'about:blank';
          const page = {
            async goto(u: string) { f.gotos.push(u); cur = f.redirect[u] ?? u; },
            url: () => cur,
            title: async () => 't',
            evaluate: async () => null,
            waitForTimeout: async () => undefined,
          } as unknown as LiPage;
          return { newPage: async () => page, storageState: async () => ({ cookies: [] }), waitForEvent: async () => page } as unknown as LiContext;
        },
        async close() { f.closes++; },
      };
    },
  };
  return f;
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function mk(f: Fake, extra: Record<string, unknown> = {}) {
  const sleeps: number[] = [];
  let t = 1_000_000;
  const rt = createWebRuntime({
    db: openDb(':memory:'),
    launcher: f.launcher,
    lockPath: path.join(dir, 'webcore.lock'),
    sessionDir: path.join(dir, 'site-sessions'),
    config: { minGapSec: 20, maxCallsPerJob: 80, maxJobMin: 15, idleMs: 600000, settleMs: 0 },
    now: () => new Date(t),
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    random: () => 0.5,
    ...extra,
  });
  return { rt, sleeps, advance: (ms: number) => { t += ms; } };
}

const OPEN = { allowedHosts: ['boards.example.com'], jobId: 'j1' };

describe('hostAllowed', () => {
  it('exact or subdomain over http(s) only', () => {
    expect(hostAllowed('https://a.example.com/x', ['example.com'])).toBe(true);
    expect(hostAllowed('https://example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('https://evilexample.com', ['example.com'])).toBe(false);
    expect(hostAllowed('javascript:alert(1)', ['example.com'])).toBe(false);
    expect(hostAllowed('https://user:pw@example.com', ['example.com'])).toBe(false);
    expect(hostAllowed('not a url', ['example.com'])).toBe(false);
  });
});

describe('web runtime', () => {
  it('opens through the fake launcher with the shared headless context options', async () => {
    const f = fake();
    const { rt } = mk(f);
    const r = await rt.open('https://boards.example.com/a', OPEN);
    expect(r.ok).toBe(true);
    expect(f.launches).toBe(1);
    expect(f.contextOpts[0]).toMatchObject({ locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
    expect(f.contextOpts[0]).not.toHaveProperty('storageState');
    await rt.close();
  });

  it('runs calls serially in order', async () => {
    const f = fake();
    const { rt } = mk(f);
    const order: number[] = [];
    const a = rt.serial(async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); });
    const b = rt.serial(async () => { order.push(2); });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2]);
  });

  it('closes after the idle time and releases the lock', async () => {
    const f = fake();
    const { rt } = mk(f, { idleMs: 30 });
    await rt.open('https://boards.example.com/a', OPEN);
    await new Promise((r) => setTimeout(r, 120));
    expect(f.closes).toBe(1);
    expect(rt.page()).toBeNull();
    const probe = acquireLock(path.join(dir, 'webcore.lock'));
    expect(probe.ok).toBe(true);
    if (probe.ok) probe.handle.release();
  });

  it('returns session_locked when another process holds the lock', async () => {
    const f = fake();
    const { rt } = mk(f);
    const held = acquireLock(path.join(dir, 'webcore.lock'));
    expect(held.ok).toBe(true);
    const r = await rt.open('https://boards.example.com/a', OPEN);
    expect(r).toMatchObject({ ok: false, code: 'session_locked' });
    expect(f.launches).toBe(0);
  });

  it('refuses while the web or apply platform is halted', async () => {
    for (const platform of ['web', 'apply', 'all']) {
      const f = fake();
      const db = openDb(':memory:');
      haltPlatform(db, platform, 'test', new Date());
      const { rt } = mk(f, { db });
      const r = await rt.open('https://boards.example.com/a', OPEN);
      expect(r, platform).toMatchObject({ ok: false, code: 'halted' });
      expect(f.launches).toBe(0);
    }
  });

  it('refuses an off-set URL before navigating and a redirect after', async () => {
    const f = fake();
    const { rt } = mk(f);
    expect(await rt.open('https://other.example.org/a', OPEN)).toMatchObject({ ok: false, code: 'refused', reason: 'host_change' });
    expect(f.gotos).toEqual([]);
    f.redirect['https://boards.example.com/go'] = 'https://tracker.example.net/x';
    const r = await rt.open('https://boards.example.com/go', OPEN);
    expect(r).toMatchObject({ ok: false, code: 'refused', reason: 'host_change' });
    expect(f.closes).toBe(1);
    expect(rt.page()).toBeNull();
  });

  it('keeps a per-host minimum gap plus code-drawn jitter', async () => {
    const f = fake();
    const { rt, sleeps, advance } = mk(f);
    await rt.open('https://boards.example.com/a', OPEN);
    expect(sleeps).toEqual([]);
    advance(5000);
    await rt.navigate('https://boards.example.com/b');
    // gap 20000 + jitter floor(0.5 * 0.25 * 20000) = 22500, minus the 5000 already elapsed
    expect(sleeps).toEqual([17500]);
    // a different host is not delayed by the first host's gap
    sleeps.length = 0;
    await rt.close();
    await rt.open('https://x.example.org/a', { allowedHosts: ['x.example.org'], jobId: 'j2' });
    expect(sleeps).toEqual([]);
  });

  it('cuts off at the per-job call budget and resets for a new job', async () => {
    const f = fake();
    const { rt } = mk(f, { config: { minGapSec: 0, maxCallsPerJob: 2, maxJobMin: 15, idleMs: 600000, settleMs: 0 } });
    expect((await rt.open('https://boards.example.com/a', OPEN)).ok).toBe(true);
    expect((await rt.navigate('https://boards.example.com/b')).ok).toBe(true);
    expect(await rt.navigate('https://boards.example.com/c')).toMatchObject({ ok: false, code: 'budget_calls' });
    expect((await rt.open('https://boards.example.com/a', { ...OPEN, jobId: 'j2' })).ok).toBe(true);
  });

  it('cuts off at the per-job wall budget', async () => {
    const f = fake();
    const { rt, advance } = mk(f, { config: { minGapSec: 0, maxCallsPerJob: 80, maxJobMin: 1, idleMs: 600000, settleMs: 0 } });
    await rt.open('https://boards.example.com/a', OPEN);
    advance(61_000);
    expect(await rt.navigate('https://boards.example.com/b')).toMatchObject({ ok: false, code: 'budget_time' });
  });

  it('refuses a session file with open permissions and loads a private one', async () => {
    const f = fake();
    const { rt } = mk(f);
    const p = siteSessionPath('boards.example.com', path.join(dir, 'site-sessions'));
    saveSiteStateAtomic(p, { cookies: [{ name: 's', value: 'x' }] });
    expect(checkSiteSessionFile(p).ok).toBe(true);
    fs.chmodSync(p, 0o644);
    expect(checkSiteSessionFile(p)).toMatchObject({ ok: false });
    const r = await rt.open('https://boards.example.com/a', OPEN);
    expect(r).toMatchObject({ ok: false, code: 'session_invalid' });
    expect(f.launches).toBe(0);
    const probe = acquireLock(path.join(dir, 'webcore.lock'));
    expect(probe.ok).toBe(true);
    if (probe.ok) probe.handle.release();
    fs.chmodSync(p, 0o600);
    const ok = await rt.open('https://boards.example.com/a', OPEN);
    expect(ok.ok).toBe(true);
    expect(f.contextOpts[0]).toHaveProperty('storageState', p);
  });

  it('sanitizes the host used in the session path', () => {
    const p = siteSessionPath('../../etc/passwd', path.join(dir, 's'));
    expect(path.dirname(p)).toBe(path.join(dir, 's'));
  });
});
