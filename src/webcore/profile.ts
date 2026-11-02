// The ONE persistent Chrome profile of the web runtime (scout, applier, search dork, apply:assist, browser:open): secrets/browser-profile/.
// It keeps cookies and Chrome's own history (Default/History) between runs. This file prepares the directory (mode 0700, no symlink,
// Chrome's password manager switched off: passwords live only in secrets/site-accounts.json) and imports the old per-host session
// files once. It never launches a browser (src/linkedin/browser.ts does) and never logs a cookie value.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LiContext } from './launch.js';
import { checkSiteSessionFile } from './session.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_PROFILE_DIR = path.join(ROOT, 'secrets', 'browser-profile');
export const IMPORT_MARKER = '.legacy-sessions-imported.json';

export interface ProfileCheck { ok: boolean; reason?: string }

/** Creates the directory 0700 when missing; refuses a symlink, a non-directory or a directory owned by someone else with wider access. */
export function prepareProfileDir(dir: string = DEFAULT_PROFILE_DIR): ProfileCheck {
  try {
    mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return { ok: false, reason: 'profile directory is a symlink' };
    if (!st.isDirectory()) return { ok: false, reason: 'profile path is not a directory' };
    if ((st.mode & 0o077) !== 0) {
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { ok: false, reason: 'profile directory is wider than 0700 and not owned by us' };
      chmodSync(dir, 0o700);
    }
    writePasswordPrefs(dir);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'profile directory could not be prepared' };
  }
}

/** Merges the "do not offer to save passwords" prefs into Default/Preferences (Chrome keeps the other keys). */
export function writePasswordPrefs(dir: string): void {
  const defDir = path.join(dir, 'Default');
  mkdirSync(defDir, { recursive: true, mode: 0o700 });
  const file = path.join(defDir, 'Preferences');
  let prefs: Record<string, unknown> = {};
  try { const p = JSON.parse(readFileSync(file, 'utf8')); if (p && typeof p === 'object') prefs = p as Record<string, unknown>; } catch { /* new profile */ }
  const profile = { ...((prefs.profile as Record<string, unknown> | undefined) ?? {}), password_manager_enabled: false };
  const next = { ...prefs, credentials_enable_service: false, credentials_enable_autosignin: false, profile };
  writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
}

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);

/** Playwright storage-state cookies reduced to the fields addCookies accepts; anything malformed is dropped. */
export function cleanCookies(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const c of raw) {
    const o = c as Record<string, unknown> | null;
    if (!o || typeof o.name !== 'string' || typeof o.value !== 'string' || typeof o.domain !== 'string' || !o.domain) continue;
    out.push({
      name: o.name, value: o.value, domain: o.domain, path: typeof o.path === 'string' && o.path ? o.path : '/',
      ...(typeof o.expires === 'number' && o.expires > 0 ? { expires: o.expires } : {}),
      httpOnly: o.httpOnly === true, secure: o.secure === true,
      ...(typeof o.sameSite === 'string' && SAME_SITE.has(o.sameSite) ? { sameSite: o.sameSite } : {}),
    });
  }
  return out;
}

/**
 * One-time import of secrets/site-sessions/*.json (the old per-host storage states) into the persistent profile, so nothing is lost.
 * A marker file in the profile makes it run once; the old files stay where they are as the fallback. Returns how many files and cookies
 * were imported (0, 0 when the marker exists or there is nothing). Never throws.
 */
export async function importLegacySessions(ctx: LiContext, profileDir: string, sessionDir: string): Promise<{ files: number; cookies: number }> {
  const marker = path.join(profileDir, IMPORT_MARKER);
  if (existsSync(marker) || typeof ctx.addCookies !== 'function') return { files: 0, cookies: 0 };
  let files = 0;
  let cookies = 0;
  try {
    const names = existsSync(sessionDir) ? readdirSync(sessionDir).filter((n) => n.endsWith('.json')).sort() : [];
    for (const n of names) {
      const p = path.join(sessionDir, n);
      if (!checkSiteSessionFile(p).ok) continue;
      try {
        const state = JSON.parse(readFileSync(p, 'utf8')) as { cookies?: unknown };
        const list = cleanCookies(state.cookies);
        if (!list.length) continue;
        await ctx.addCookies(list);
        files += 1;
        cookies += list.length;
      } catch { /* one bad file does not stop the others */ }
    }
    writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), files, cookies }), { mode: 0o600 });
  } catch { /* not marked: tried again next time */ }
  return { files, cookies };
}
