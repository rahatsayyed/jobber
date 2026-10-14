// src/platform/lock.ts
// Shared exclusive lock: one directory per name, created atomically with mkdirSync.
// Names in use: `run` (wakes and AUTO_UPDATE), `daemon` (one scheduler daemon per project).
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface LockInfo {
  name: string;
  owner: string;
  pid: number;
  token: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface LockDeps {
  now: () => Date;
  pid: number;
  isAlive: (pid: number) => boolean;
}

export interface LockHandle {
  readonly info: LockInfo;
  heartbeat(): void;
  // Callers treat release() === false as "lock lost" (stale, reclaimed or re-taken).
  release(): boolean;
}

const DEFAULT_TTL_MS = 120000;
const GUARD_STALE_MS = 5000;
const NAME_RE = /^[a-z0-9-]{1,32}$/;

export const defaultLockDeps: LockDeps = {
  now: () => new Date(),
  pid: process.pid,
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM means the process exists but belongs to someone else.
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};

function lockDir(root: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid lock name: ${name}`);
  return path.join(root, `${name}.lock`);
}

function readInfo(dir: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(path.join(dir, 'info.json'), 'utf8')) as Partial<LockInfo>;
    if (
      v && typeof v.token === 'string' && Number.isInteger(v.pid) && (v.pid as number) > 0 &&
      typeof v.heartbeatAt === 'string' && Number.isFinite(Date.parse(v.heartbeatAt))
    ) {
      return v as LockInfo;
    }
  } catch {
    // missing or corrupt
  }
  return null;
}

function writeInfo(dir: string, info: LockInfo): void {
  const tmp = path.join(dir, `info.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(info));
  renameSync(tmp, path.join(dir, 'info.json'));
}

// True when the directory exists and its holder is gone or silent past the ttl.
function isStale(dir: string, deps: LockDeps, ttlMs: number): boolean {
  const info = readInfo(dir);
  if (info) {
    const age = deps.now().getTime() - Date.parse(info.heartbeatAt);
    if (age > ttlMs || age < -ttlMs) return true; // silent too long, or stamped far in the future
    return !deps.isAlive(info.pid);
  }
  try {
    return deps.now().getTime() - statSync(dir).mtimeMs > ttlMs;
  } catch {
    return false;
  }
}

function tryCreate(dir: string): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

// Short-lived guard that serialises stale reclaim, so one process cannot delete a
// lock another process just re-took. A guard left by a crash goes stale after seconds.
function takeGuard(guard: string, deps: LockDeps): boolean {
  if (tryCreate(guard)) return true;
  try {
    if (deps.now().getTime() - statSync(guard).mtimeMs <= GUARD_STALE_MS) return false;
    rmSync(guard, { recursive: true, force: true });
  } catch {
    return false;
  }
  return tryCreate(guard);
}

export function acquireLock(
  root: string,
  name: string,
  owner: string,
  deps: LockDeps = defaultLockDeps,
  opts: { ttlMs?: number } = {},
): LockHandle | null {
  const dir = lockDir(root, name);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  mkdirSync(root, { recursive: true });

  if (!tryCreate(dir)) {
    const judged = readInfo(dir)?.token ?? null;
    if (!isStale(dir, deps, ttlMs)) return null;
    const guard = `${dir}.reclaim`;
    if (!takeGuard(guard, deps)) return null;
    try {
      // Re-check inside the guard: only reclaim the exact holder judged stale.
      if ((readInfo(dir)?.token ?? null) !== judged || !isStale(dir, deps, ttlMs)) return null;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        return null;
      }
      if (!tryCreate(dir)) return null;
    } finally {
      rmSync(guard, { recursive: true, force: true });
    }
  }

  const at = deps.now().toISOString();
  const info: LockInfo = {
    name,
    owner,
    pid: deps.pid,
    token: `${owner}:${deps.pid}:${at}:${randomUUID()}`,
    acquiredAt: at,
    heartbeatAt: at,
  };
  try {
    writeInfo(dir, info);
  } catch {
    // the directory vanished under us: nothing of ours is left to clean up
    return null;
  }

  let current: LockInfo = info;
  const ours = (): boolean => readInfo(dir)?.token === info.token;
  return {
    get info() {
      return current;
    },
    heartbeat() {
      const tmp = path.join(dir, `info.json.${process.pid}.hb`);
      try {
        if (!ours()) return;
        const next = { ...current, heartbeatAt: deps.now().toISOString() };
        writeFileSync(tmp, JSON.stringify(next));
        if (!ours()) {
          rmSync(tmp, { force: true });
          return;
        }
        renameSync(tmp, path.join(dir, 'info.json'));
        current = next;
      } catch {
        // lock gone or replaced; release() will report it
      }
    },
    release() {
      const tomb = path.join(root, `${name}.lock.tomb-${randomUUID()}`);
      try {
        renameSync(dir, tomb);
      } catch {
        return false;
      }
      if (readInfo(tomb)?.token === info.token) {
        rmSync(tomb, { recursive: true, force: true });
        return true;
      }
      try {
        renameSync(tomb, dir); // not ours: put the live lock back untouched
      } catch {
        rmSync(tomb, { recursive: true, force: true });
      }
      return false;
    },
  };
}

// The live holder, or null when the lock is free or stale. A held lock whose info.json
// is missing or corrupt also reads as null, while acquireLock still refuses it until
// the directory mtime is older than the ttl.
export function peekLock(
  root: string,
  name: string,
  deps: LockDeps = defaultLockDeps,
  opts: { ttlMs?: number } = {},
): LockInfo | null {
  const dir = lockDir(root, name);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const info = readInfo(dir);
  if (!info) return null;
  return isStale(dir, deps, ttlMs) ? null : info;
}
