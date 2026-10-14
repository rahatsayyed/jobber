// Session file validation, single-session lock and atomic save. Never returns or logs a cookie value.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
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
  try { st = statSync(p); } catch { return fail('session file missing'); }
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

export function acquireLock(
  lockPath: string,
  opts: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): { ok: true; handle: LockHandle } | { ok: false; reason: string; holderPid?: number } {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const body = JSON.stringify({ pid, started: new Date().toISOString() });
  const handle: LockHandle = {
    release() {
      try {
        const cur = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
        if (cur.pid === pid) unlinkSync(lockPath);
      } catch { /* already gone */ }
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, body, { flag: 'wx', mode: 0o600 });
      return { ok: true, handle };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, reason: 'lock_unavailable' };
    }
    let holder: number | undefined;
    try {
      const cur = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
      if (typeof cur.pid === 'number') holder = cur.pid;
    } catch { /* corrupt lock is stale */ }
    if (holder !== undefined && isAlive(holder)) {
      return { ok: false, reason: `another LinkedIn session is open (pid ${holder})`, holderPid: holder };
    }
    try { unlinkSync(lockPath); } catch { /* raced */ }
  }
  return { ok: false, reason: 'lock_unavailable' };
}

export function saveStateAtomic(p: string, state: unknown): void {
  if (!hasLiAt(state)) throw new Error('refusing to save a session with no li_at cookie');
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, p);
  } catch (e) {
    if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* ignore */ } }
    throw e;
  }
}
