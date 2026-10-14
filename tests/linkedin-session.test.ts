import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, utimesSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkSessionFile, acquireLock, saveStateAtomic } from '../src/linkedin/session.js';
import { loginAllowed } from '../scripts/linkedin-login.js';
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
  it('login refuses unless account is main', () => {
    expect(loginAllowed({})).toBe(false);
    expect(loginAllowed({ LINKEDIN_LOGIN_ACCOUNT: 'burner' })).toBe(false);
    expect(loginAllowed({ LINKEDIN_LOGIN_ACCOUNT: 'main' })).toBe(true);
  });
  it('clear-halt needs --yes', () => {
    const db = openDb(':memory:');
    haltPlatform(db, 'linkedin', 'captcha', new Date());
    expect(run(db, []).code).toBe(1);
    expect(haltReason(db, 'linkedin')).toBe('captcha');
    expect(run(db, ['--yes']).code).toBe(0);
    expect(haltReason(db, 'linkedin')).toBeNull();
  });
});
