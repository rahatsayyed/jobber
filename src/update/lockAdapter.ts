import { acquireLock } from '../platform/lock.js';

export interface LockHandle { release(): Promise<void> }
export interface LockPort { acquire(): Promise<LockHandle | null> }

const TTL_MS = 120_000;

export function runLock(lockRoot: string): LockPort {
  return {
    async acquire() {
      const h = acquireLock(lockRoot, 'run', 'auto-update', undefined, { ttlMs: TTL_MS });
      if (h === null) return null;
      const timer = setInterval(() => {
        try { h.heartbeat(); } catch { /* a lost lock is reported on release */ }
      }, TTL_MS / 4);
      timer.unref();
      return {
        async release() {
          clearInterval(timer);
          let ok = false;
          try { ok = h.release(); } catch { ok = false; }
          if (!ok) console.warn('auto-update: run lock was lost before release');
        },
      };
    },
  };
}
