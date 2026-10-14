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
  release(): boolean;
}

const DEFAULT_TTL_MS = 120000;
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
      v && typeof v.token === 'string' && typeof v.pid === 'number' &&
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
    if (deps.now().getTime() - Date.parse(info.heartbeatAt) > ttlMs) return true;
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

  let created = tryCreate(dir);
  if (!created) {
    if (!isStale(dir, deps, ttlMs)) return null;
    rmSync(dir, { recursive: true, force: true });
    created = tryCreate(dir); // one retry only; a lost race means someone else holds it
    if (!created) return null;
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
  writeInfo(dir, info);

  let current: LockInfo = info;
  return {
    get info() {
      return current;
    },
    heartbeat() {
      const stored = readInfo(dir);
      if (!stored || stored.token !== info.token) return; // no longer ours
      current = { ...current, heartbeatAt: deps.now().toISOString() };
      writeInfo(dir, current);
    },
    release() {
      const stored = readInfo(dir);
      if (!stored || stored.token !== info.token) return false;
      rmSync(dir, { recursive: true, force: true });
      return true;
    },
  };
}

// The live holder, or null when the lock is free or stale.
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
