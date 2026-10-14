// tests/platform-lock.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock, peekLock, type LockDeps } from '../src/platform/lock.js';

let root: string;
let nowMs: number;
let alive: Set<number>;
const deps = (pid: number): LockDeps => ({ now: () => new Date(nowMs), pid, isAlive: (p) => alive.has(p) });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobber-lock-'));
  nowMs = Date.UTC(2026, 9, 14, 6, 0, 0);
  alive = new Set([100, 200]);
});

describe('lock', () => {
  it('is exclusive while the holder is alive and fresh', () => {
    const a = acquireLock(root, 'run', 'wake', deps(100));
    expect(a).not.toBeNull();
    expect(acquireLock(root, 'run', 'auto-update', deps(200))).toBeNull();
    expect(peekLock(root, 'run', deps(200))?.owner).toBe('wake');
  });

  it('release frees it, and only for the holder token', () => {
    const a = acquireLock(root, 'run', 'wake', deps(100))!;
    expect(a.release()).toBe(true);
    const b = acquireLock(root, 'run', 'auto-update', deps(200))!;
    expect(a.release()).toBe(false); // stale handle must not remove b's lock
    expect(peekLock(root, 'run', deps(200))?.owner).toBe('auto-update');
    expect(b.release()).toBe(true);
  });

  it('reclaims a lock whose process is dead', () => {
    acquireLock(root, 'run', 'wake', deps(100));
    alive.delete(100);
    expect(acquireLock(root, 'run', 'wake', deps(200))).not.toBeNull();
  });

  it('reclaims a lock whose heartbeat is older than the ttl even if the pid is alive (pid reuse)', () => {
    acquireLock(root, 'run', 'wake', deps(100), { ttlMs: 60000 });
    nowMs += 61000;
    expect(acquireLock(root, 'run', 'wake', deps(200), { ttlMs: 60000 })).not.toBeNull();
  });

  it('heartbeat keeps a lock fresh', () => {
    const a = acquireLock(root, 'run', 'wake', deps(100), { ttlMs: 60000 })!;
    nowMs += 50000;
    a.heartbeat();
    nowMs += 50000;
    expect(acquireLock(root, 'run', 'x', deps(200), { ttlMs: 60000 })).toBeNull();
  });

  it('treats a directory with corrupt info as held until ttl passes', () => {
    mkdirSync(path.join(root, 'run.lock'));
    writeFileSync(path.join(root, 'run.lock', 'info.json'), '{not json');
    expect(acquireLock(root, 'run', 'wake', deps(100))).toBeNull();
  });

  it('rejects invalid names', () => {
    expect(() => acquireLock(root, '../x', 'wake', deps(100))).toThrow();
  });

  it('peekLock is null when the holder is stale', () => {
    acquireLock(root, 'run', 'wake', deps(100));
    alive.delete(100);
    expect(peekLock(root, 'run', deps(200))).toBeNull();
  });

  it('reclaims a corrupt-info dir once its mtime is older than the ttl', () => {
    const dir = path.join(root, 'run.lock');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'info.json'), '{not json');
    const t = (nowMs - 61000) / 1000;
    utimesSync(dir, t, t);
    expect(acquireLock(root, 'run', 'wake', deps(100), { ttlMs: 60000 })).not.toBeNull();
  });

  it('heartbeat after losing the lock does not overwrite the new holder', () => {
    const a = acquireLock(root, 'run', 'wake', deps(100), { ttlMs: 60000 })!;
    alive.delete(100);
    const b = acquireLock(root, 'run', 'new', deps(200), { ttlMs: 60000 })!;
    nowMs += 1000;
    a.heartbeat();
    expect(peekLock(root, 'run', deps(200))?.token).toBe(b.info.token);
    expect(peekLock(root, 'run', deps(200))?.heartbeatAt).toBe(b.info.heartbeatAt);
  });

  it('release of a stale handle leaves the new holder lock in place', () => {
    const a = acquireLock(root, 'run', 'wake', deps(100))!;
    alive.delete(100);
    acquireLock(root, 'run', 'new', deps(200))!;
    expect(a.release()).toBe(false);
    expect(peekLock(root, 'run', deps(200))?.owner).toBe('new');
  });

  it('a lost reclaim race yields exactly one holder', () => {
    acquireLock(root, 'run', 'old', deps(100));
    alive.delete(100);
    let inner: ReturnType<typeof acquireLock> = null;
    let fired = false;
    const racing: LockDeps = {
      now: () => new Date(nowMs),
      pid: 300,
      isAlive: (p) => {
        if (!fired) {
          fired = true;
          inner = acquireLock(root, 'run', 'rival', deps(200));
        }
        return alive.has(p);
      },
    };
    expect(acquireLock(root, 'run', 'loser', racing)).toBeNull();
    expect(inner).not.toBeNull();
    expect(peekLock(root, 'run', deps(200))?.owner).toBe('rival');
  });
});
