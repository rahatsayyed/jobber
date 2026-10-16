import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, writeFileSync, chmodSync, utimesSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkSessionFile, acquireLock, saveStateAtomic } from '../src/linkedin/session.js';
import { openDb } from '../src/db.js';
import { haltPlatform, haltReason } from '../src/outreach/limits.js';
import { run } from '../scripts/linkedin-clear-halt.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'li-'));
const good = { cookies: [{ name: 'li_at', value: 'SENTINEL_SECRET_VALUE' }], origins: [] };
function mk(dir: string, state: unknown, mode = 0o600) {
  const p = path.join(dir, 's.json');
  writeFileSync(p, typeof state === 'string' ? state : JSON.stringify(state));
  chmodSync(p, mode);
  return p;
}

describe('checkSessionFile', () => {
  it('passes a 600 file with li_at and leaks no value', () => {
    const r = checkSessionFile(mk(tmp(), good));
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain('SENTINEL_SECRET_VALUE');
  });
  it('refuses open permissions', () => {
    const r = checkSessionFile(mk(tmp(), good, 0o644), { platform: 'linux' });
    expect(r).toMatchObject({ ok: false, reason: 'session file permissions too open (chmod 600)' });
    expect(JSON.stringify(r)).not.toContain('SENTINEL_SECRET_VALUE');
  });
  it('refuses missing li_at, bad json, missing file', () => {
    expect(checkSessionFile(mk(tmp(), { cookies: [{ name: 'x', value: 'SENTINEL_SECRET_VALUE' }] })).ok).toBe(false);
    expect(checkSessionFile(mk(tmp(), '{nope')).ok).toBe(false);
    expect(checkSessionFile(path.join(tmp(), 'none.json')).ok).toBe(false);
  });
  it('refuses a stale file', () => {
    const p = mk(tmp(), good);
    const old = new Date(Date.now() - 60 * 86_400_000);
    utimesSync(p, old, old);
    expect(checkSessionFile(p)).toMatchObject({ ok: false, reason: 'session older than 45 days' });
  });
});

describe('acquireLock', () => {
  it('second acquire fails with holder pid; stale lock is taken over; release only own', () => {
    const lp = path.join(tmp(), 'l.lock');
    const a = acquireLock(lp, { pid: 111, isAlive: () => true });
    expect(a.ok).toBe(true);
    const b = acquireLock(lp, { pid: 222, isAlive: () => true });
    expect(b).toMatchObject({ ok: false, holderPid: 111 });
    const c = acquireLock(lp, { pid: 333, isAlive: () => false });
    expect(c.ok).toBe(true);
    if (a.ok) a.handle.release();
    expect(JSON.parse(readFileSync(lp, 'utf8')).pid).toBe(333);
    if (c.ok) c.handle.release();
    expect(() => readFileSync(lp)).toThrow();
  });
});

describe('saveStateAtomic', () => {
  it('writes mode 600, no tmp left; refuses cookie-less state without touching file', () => {
    const d = tmp();
    const p = path.join(d, 's.json');
    saveStateAtomic(p, good);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(d).filter((f) => f.includes('.tmp-'))).toEqual([]);
    const before = readFileSync(p, 'utf8');
    expect(() => saveStateAtomic(p, { cookies: [], origins: [] })).toThrow();
    expect(readFileSync(p, 'utf8')).toBe(before);
    expect(readdirSync(d)).toEqual(['s.json']);
  });
});

describe('owner scripts', () => {
  it('clear-halt needs --yes', () => {
    const db = openDb(':memory:');
    haltPlatform(db, 'linkedin', 'captcha', new Date());
    expect(run(db, []).code).toBe(1);
    expect(haltReason(db, 'linkedin')).toBe('captcha');
    expect(run(db, ['--yes']).code).toBe(0);
    expect(haltReason(db, 'linkedin')).toBeNull();
  });
});

describe('fix round 1', () => {
  const lockBody = (pid: number) => JSON.stringify({ pid, started: 'x' });
  it('lock never published empty and only one taker wins a stale lock', () => {
    const lp = path.join(tmp(), 'l.lock');
    writeFileSync(lp, lockBody(1));
    const alive = (p: number) => p === 222;
    let inner: ReturnType<typeof acquireLock> | undefined;
    const a = acquireLock(lp, {
      pid: 111, isAlive: alive,
      beforeTakeover: () => { inner = acquireLock(lp, { pid: 222, isAlive: alive }); },
    });
    expect(inner?.ok).toBe(true);
    expect(a).toMatchObject({ ok: false, holderPid: 222 });
    expect(JSON.parse(readFileSync(lp, 'utf8')).pid).toBe(222);
    expect(readdirSync(path.dirname(lp)).sort()).toEqual(['l.lock']);
  });
  it('unparseable fresh lock is held, old one is stale', () => {
    const lp = path.join(tmp(), 'l.lock');
    writeFileSync(lp, '');
    expect(acquireLock(lp, { pid: 5, isAlive: () => false }).ok).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lp, old, old);
    expect(acquireLock(lp, { pid: 5, isAlive: () => false }).ok).toBe(true);
  });
  it('refuses a symlink and a directory', () => {
    const d = tmp();
    const real = mk(d, good);
    const ln = path.join(d, 'ln.json');
    symlinkSync(real, ln);
    expect(checkSessionFile(ln)).toMatchObject({ ok: false, reason: 'session file is not a regular file' });
    mkdirSync(path.join(d, 'dir'));
    expect(checkSessionFile(path.join(d, 'dir')).ok).toBe(false);
  });
  it('size, shape, sentinel, platform, age options', () => {
    const d = tmp();
    expect(checkSessionFile(mk(d, '')).ok).toBe(false);
    expect(checkSessionFile(mk(tmp(), JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024 + 1), cookies: good.cookies }))).ok).toBe(false);
    expect(checkSessionFile(mk(tmp(), { origins: [] })).ok).toBe(false);
    for (const st of [{ cookies: [{ name: 'a', value: 'SENTINEL_SECRET_VALUE' }] }, '{SENTINEL_SECRET_VALUE']) {
      expect(JSON.stringify(checkSessionFile(mk(tmp(), st)))).not.toContain('SENTINEL_SECRET_VALUE');
    }
    expect(checkSessionFile(mk(tmp(), good, 0o644), { platform: 'win32' }).ok).toBe(true);
    const p = mk(tmp(), good);
    const old = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(p, old, old);
    expect(checkSessionFile(p, { maxAgeDays: 5 })).toMatchObject({ ok: false, reason: 'session older than 5 days' });
    const prev = process.env.LINKEDIN_SESSION_MAX_AGE_DAYS;
    process.env.LINKEDIN_SESSION_MAX_AGE_DAYS = '3';
    try {
      expect(checkSessionFile(p)).toMatchObject({ ok: false, reason: 'session older than 3 days' });
    } finally {
      if (prev === undefined) delete process.env.LINKEDIN_SESSION_MAX_AGE_DAYS; else process.env.LINKEDIN_SESSION_MAX_AGE_DAYS = prev;
    }
  });
  it('saveStateAtomic failure cleans its temp file and replaces a pre-existing temp', () => {
    const d = tmp();
    const p = path.join(d, 'target');
    mkdirSync(p); // rename of a file over a directory fails
    writeFileSync(`${p}.tmp-${process.pid}`, 'old');
    expect(() => saveStateAtomic(p, good)).toThrow();
    expect(existsSync(`${p}.tmp-${process.pid}`)).toBe(false);
  });
});

describe('fix round 2: takeover mutex', () => {
  const alive = (p: number) => [111, 222, 333].includes(p);
  const stale = JSON.stringify({ pid: 1, started: 'x' });
  it('3-actor race: exactly one winner and the lock is present at every observation', () => {
    const d = tmp();
    const lp = path.join(d, 'l.lock');
    writeFileSync(lp, stale);
    const results: boolean[] = [];
    const seen: boolean[] = [];
    const a = acquireLock(lp, {
      pid: 111, isAlive: alive,
      beforeTakeover: () => {
        const c = acquireLock(lp, { pid: 222, isAlive: alive });
        results.push(c.ok); seen.push(existsSync(lp));
        const dd = acquireLock(lp, { pid: 333, isAlive: alive });
        results.push(dd.ok); seen.push(existsSync(lp));
      },
    });
    results.push(a.ok); seen.push(existsSync(lp));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(seen.every(Boolean)).toBe(true);
    expect(JSON.parse(readFileSync(lp, 'utf8')).pid).toBe(222);
    expect(readdirSync(d).sort()).toEqual(['l.lock']);
  });
  it('other acquirers are refused while a live takeover mutex is held', () => {
    const d = tmp();
    const lp = path.join(d, 'l.lock');
    writeFileSync(lp, stale);
    let inner: ReturnType<typeof acquireLock> | undefined;
    const a = acquireLock(lp, {
      pid: 111, isAlive: alive,
      duringTakeover: () => { inner = acquireLock(lp, { pid: 222, isAlive: alive }); expect(existsSync(lp)).toBe(true); },
    });
    expect(inner).toMatchObject({ ok: false });
    expect((inner as unknown as { reason: string }).reason).toContain('takeover');
    expect(a.ok).toBe(true);
    expect(readdirSync(d).sort()).toEqual(['l.lock']);
  });
  it('a leftover mutex (any pid) fails closed and leaves the lock untouched', () => {
    const d = tmp();
    const lp = path.join(d, 'l.lock');
    writeFileSync(lp, stale);
    writeFileSync(`${lp}.takeover`, JSON.stringify({ pid: 999, started: 'x' }));
    const r = acquireLock(lp, { pid: 111, isAlive: alive });
    expect(r).toMatchObject({ ok: false, holderPid: 999 });
    expect(readFileSync(lp, 'utf8')).toBe(stale);
    expect(existsSync(`${lp}.takeover`)).toBe(true);
  });
  it('mutex is released after a takeover and after a throw in the critical section', () => {
    const d = tmp();
    const lp = path.join(d, 'l.lock');
    writeFileSync(lp, stale);
    expect(acquireLock(lp, { pid: 111, isAlive: alive }).ok).toBe(true);
    expect(existsSync(`${lp}.takeover`)).toBe(false);
    writeFileSync(lp, stale);
    expect(() => acquireLock(lp, {
      pid: 222, isAlive: alive,
      duringTakeover: () => { throw new Error('boom'); },
    })).toThrow('boom');
    expect(existsSync(`${lp}.takeover`)).toBe(false);
    expect(readFileSync(lp, 'utf8')).toBe(stale);
  });
});
