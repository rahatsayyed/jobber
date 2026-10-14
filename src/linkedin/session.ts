// Session file validation, single-session lock and atomic save. Never returns or logs a cookie value.
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_SESSION_PATH = path.join(ROOT, 'secrets', 'linkedin-main-state.json');
export const DEFAULT_LOCK_PATH = path.join(ROOT, 'secrets', 'linkedin.lock');

export interface SessionCheck { ok: boolean; reason?: string; ageDays?: number }
const MAX_BYTES = 2 * 1024 * 1024;

function hasLiAt(state: unknown): boolean {
  const cookies = (state as { cookies?: unknown } | null)?.cookies;
  return Array.isArray(cookies) && cookies.some((c) => (c as { name?: unknown } | null)?.name === 'li_at');
}

export function checkSessionFile(
  p: string,
  opts: { now?: Date; maxAgeDays?: number; platform?: NodeJS.Platform } = {},
): SessionCheck {
  const fail = (reason: string): SessionCheck => ({ ok: false, reason });
  let st;
  try { st = lstatSync(p); } catch { return fail('session file missing'); }
  if (!st.isFile()) return fail('session file is not a regular file');
  if (st.size === 0 || st.size > MAX_BYTES) return fail('session file size out of range');
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' && (st.mode & 0o077) !== 0) return fail('session file permissions too open (chmod 600)');
  let state: unknown;
  try { state = JSON.parse(readFileSync(p, 'utf8')); } catch { return fail('session file is not valid JSON'); }
  const cookies = (state as { cookies?: unknown } | null)?.cookies;
  if (!Array.isArray(cookies)) return fail('session file has no cookies array');
  if (!hasLiAt(state)) return fail('session has no li_at cookie');
  const envMax = Number(process.env.LINKEDIN_SESSION_MAX_AGE_DAYS);
  const maxAge = opts.maxAgeDays ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : 45);
  const now = (opts.now ?? new Date()).getTime();
  const ageDays = (now - st.mtimeMs) / 86_400_000;
  if (ageDays > maxAge) return { ok: false, reason: `session older than ${maxAge} days`, ageDays };
  return { ok: true, ageDays };
}

export interface LockHandle { release(): void }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const FRESH_LOCK_MS = 5000;

function readHolder(lockPath: string): { pid?: number; raw: string | null; ageMs: number } {
  let raw: string | null = null;
  let ageMs = Infinity;
  try { ageMs = Date.now() - statSync(lockPath).mtimeMs; raw = readFileSync(lockPath, 'utf8'); } catch { /* gone */ }
  let pid: number | undefined;
  try {
    const cur = raw === null ? null : (JSON.parse(raw) as { pid?: unknown });
    if (cur && typeof cur.pid === 'number') pid = cur.pid;
  } catch { /* unparseable */ }
  return { pid, raw, ageMs };
}

// A pid that was reused by an unrelated process reads as alive: that fails safe (blocks until the
// lock file is removed by hand). The lock file is published with linkSync from a complete temp file,
// so it never exists empty, and a stale lock is taken over by an atomic rename-away (one winner).
export function acquireLock(
  lockPath: string,
  opts: { pid?: number; isAlive?: (pid: number) => boolean; beforeTakeover?: () => void } = {},
): { ok: true; handle: LockHandle } | { ok: false; reason: string; holderPid?: number } {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const uniq = `${pid}-${Math.random().toString(36).slice(2)}`;
  const tmp = `${lockPath}.tmp-${uniq}`;
  writeFileSync(tmp, JSON.stringify({ pid, started: new Date().toISOString() }), { mode: 0o600 });
  const cleanup = () => { try { unlinkSync(tmp); } catch { /* ignore */ } };
  const handle: LockHandle = {
    release() {
      try {
        const cur = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
        if (cur.pid === pid) unlinkSync(lockPath);
      } catch { /* already gone */ }
    },
  };
  const held = (holder?: number) => ({
    ok: false as const,
    reason: holder === undefined ? 'another LinkedIn session is starting' : `another LinkedIn session is open (pid ${holder})`,
    holderPid: holder,
  });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(tmp, lockPath);
        return { ok: true, handle };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, reason: 'lock_unavailable' };
      }
      const h = readHolder(lockPath);
      if (h.raw === null) continue; // vanished, retry publish
      if (h.pid !== undefined ? isAlive(h.pid) : h.ageMs < FRESH_LOCK_MS) return held(h.pid);
      opts.beforeTakeover?.();
      const claimed = `${lockPath}.stale-${uniq}`;
      try { renameSync(lockPath, claimed); } catch { continue; } // lost the race
      let claimedRaw = '';
      try { claimedRaw = readFileSync(claimed, 'utf8'); } catch { /* ignore */ }
      if (claimedRaw !== h.raw) {
        // we moved a different (possibly live) lock: put it back if we can and yield
        let other: number | undefined;
        try { other = (JSON.parse(claimedRaw) as { pid?: number }).pid; } catch { /* ignore */ }
        if (other !== undefined && isAlive(other)) {
          try { linkSync(claimed, lockPath); } catch { /* someone else published */ }
          try { unlinkSync(claimed); } catch { /* ignore */ }
          return held(other);
        }
      }
      try { unlinkSync(claimed); } catch { /* ignore */ }
    }
    return { ok: false, reason: 'lock_unavailable' };
  } finally {
    cleanup();
  }
}

export function saveStateAtomic(p: string, state: unknown): void {
  if (!hasLiAt(state)) throw new Error('refusing to save a session with no li_at cookie');
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}`;
  try { unlinkSync(tmp); } catch { /* none */ }
  try {
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, p);
  } catch (e) {
    if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* ignore */ } }
    throw e;
  }
}
