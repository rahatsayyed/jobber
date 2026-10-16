// Lock and per-host session file helpers for the web runtime. The lock reuses the LinkedIn
// helpers (parametrized path); a site session file is any Playwright storage state, so there is
// no li_at requirement. Never returns or logs a cookie value.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, type LockHandle } from '../linkedin/session.js';

export { acquireLock };
export type { LockHandle };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_WEB_LOCK_PATH = path.join(ROOT, 'secrets', 'webcore.lock');
export const DEFAULT_SITE_SESSION_DIR = path.join(ROOT, 'secrets', 'site-sessions');

const MAX_BYTES = 2 * 1024 * 1024;

/** `<dir>/<host>.json` with the host reduced to [a-z0-9.-] so it can never leave the directory. */
export function siteSessionPath(host: string, dir: string = DEFAULT_SITE_SESSION_DIR): string {
  const safe = host.toLowerCase().replace(/[^a-z0-9.-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || '_';
  return path.join(dir, `${safe}.json`);
}

export interface SiteSessionCheck { ok: boolean; reason?: string; missing?: boolean }

export function checkSiteSessionFile(p: string, opts: { platform?: NodeJS.Platform } = {}): SiteSessionCheck {
  let st;
  try { st = lstatSync(p); } catch { return { ok: false, missing: true, reason: 'session file missing' }; }
  if (!st.isFile()) return { ok: false, reason: 'session file is not a regular file' };
  if (st.size === 0 || st.size > MAX_BYTES) return { ok: false, reason: 'session file size out of range' };
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' && (st.mode & 0o077) !== 0) return { ok: false, reason: 'session file permissions too open (chmod 600)' };
  try {
    const state = JSON.parse(readFileSync(p, 'utf8')) as { cookies?: unknown } | null;
    if (!state || !Array.isArray(state.cookies)) return { ok: false, reason: 'session file has no cookies array' };
  } catch { return { ok: false, reason: 'session file is not valid JSON' }; }
  return { ok: true };
}

export function saveSiteStateAtomic(p: string, state: unknown): void {
  const cookies = (state as { cookies?: unknown } | null)?.cookies;
  if (!Array.isArray(cookies)) throw new Error('refusing to save a session with no cookies array');
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
