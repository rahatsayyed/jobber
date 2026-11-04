// src/platform/windowLock.ts
// The per-window lock shared by the WindowDispatcher (while it hands one item to a window), the manager `send` and
// `clear` commands and the recycle tick: whoever holds it is the only one typing into that window.
import path from 'node:path';
import { acquireLock, peekLock, type LockHandle } from './lock.js';
import { assertName } from './tmux.js';

export const WINDOW_LOCK_TTL_MS = 600_000;

export function windowLockName(window: string): string {
  assertName(window);
  return `win-${window.toLowerCase().replace(/[^a-z0-9]/g, '-')}`.slice(0, 32);
}

const lockRoot = (root: string): string => path.join(root, '.jobber');

/** True while a live holder owns the window lock (stale locks read as free). */
export function windowLockHeld(root: string, window: string, ttlMs: number = WINDOW_LOCK_TTL_MS): boolean {
  return peekLock(lockRoot(root), windowLockName(window), undefined, { ttlMs }) !== null;
}

/** Takes the window lock, or null when it is held. The caller releases it. */
export function takeWindowLock(root: string, window: string, owner: string, ttlMs: number = WINDOW_LOCK_TTL_MS): LockHandle | null {
  return acquireLock(lockRoot(root), windowLockName(window), owner, undefined, { ttlMs });
}
