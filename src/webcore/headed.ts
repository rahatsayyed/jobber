// A HEADED Chrome window for the owner, on the same web profile the headless tasks use: the owner logs in, solves a CAPTCHA or completes
// MFA by hand, presses Enter, and the session persists (in the profile, and in the per-host session file kept as the fallback).
// Nothing the owner types or clicks is read, logged or returned: this code only opens the page, waits, and saves browser storage state.
import { existsSync } from 'node:fs';
import { HEADLESS_CONTEXT_OPTIONS, launchPersistentChrome, launchRealChrome, persistentSupported, type LiBrowser, type LiContext, type LiLauncher } from './launch.js';
import { DEFAULT_PROFILE_DIR, importLegacySessions, prepareProfileDir } from './profile.js';
import { acquireLock, checkSiteSessionDir, checkSiteSessionFile, DEFAULT_SITE_SESSION_DIR, DEFAULT_WEB_LOCK_PATH, saveSiteStateAtomic, siteSessionPath } from './session.js';

export interface HeadedIo { ask(question: string): Promise<string>; log(line: string): void }

export interface HeadedDeps {
  io: HeadedIo;
  launcher?: LiLauncher;
  lockPath?: string;
  sessionDir?: string;
  /** null turns the persistent profile off (per-host session file only). */
  profileDir?: string | null;
}

export type HeadedResult =
  | { ok: true; host: string; cookies: number; profile: boolean }
  | { ok: false; code: 'session_locked' | 'session_invalid' | 'chrome_unavailable' | 'not_saved' | 'failed'; reason: string };

export const hostOf = (u: string): string => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

export async function runHeaded(url: string, deps: HeadedDeps): Promise<HeadedResult> {
  const host = hostOf(url);
  if (!host) return { ok: false, code: 'failed', reason: 'the address is not a valid URL' };
  const sessionDir = deps.sessionDir ?? DEFAULT_SITE_SESSION_DIR;
  const profileDir = deps.profileDir === undefined ? DEFAULT_PROFILE_DIR : deps.profileDir;
  const dirChk = checkSiteSessionDir(sessionDir);
  if (!dirChk.ok) return { ok: false, code: 'session_invalid', reason: dirChk.reason ?? 'session directory invalid' };
  const lock = acquireLock(deps.lockPath ?? DEFAULT_WEB_LOCK_PATH);
  if (!lock.ok) return { ok: false, code: 'session_locked', reason: 'the web browser is busy (a wake or another command holds it); try again in a few minutes' };
  let browser: LiBrowser | null = null;
  let context: LiContext | null = null;
  let persistent = false;
  try {
    if (profileDir && persistentSupported(deps.launcher) && prepareProfileDir(profileDir).ok) {
      try {
        const pc = await launchPersistentChrome({ userDataDir: profileDir, headed: true, launcher: deps.launcher });
        browser = { newContext: async () => pc, close: () => pc.close() };
        context = pc;
        persistent = true;
        await importLegacySessions(pc, profileDir, sessionDir);
      } catch { browser = null; context = null; persistent = false; }
    }
    if (!browser) {
      try { browser = await launchRealChrome({ headed: true, launcher: deps.launcher }); } catch { return { ok: false, code: 'chrome_unavailable', reason: 'could not launch Chrome' }; }
    }
    if (!context) {
      const file = siteSessionPath(host, sessionDir);
      const storageState = existsSync(file) && checkSiteSessionFile(file).ok ? file : undefined;
      context = await browser.newContext({ ...HEADLESS_CONTEXT_OPTIONS, ...(storageState ? { storageState } : {}) });
    }
    const page = await context.newPage();
    await page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
    deps.io.log(`A Chrome window opened on ${host}.`);
    deps.io.log('Log in, solve the check or finish the verification there yourself. Nothing you type is read by this tool.');
    await deps.io.ask('When the page shows you are in (or the check is done), press Enter here to save the session: ');
    const state = (await context.storageState()) as { cookies?: unknown[] } | null;
    const cookies = Array.isArray(state?.cookies) ? state!.cookies!.length : -1;
    if (cookies < 0) return { ok: false, code: 'not_saved', reason: 'the browser state could not be read (was the window closed?)' };
    // The per-host file stays current as the fallback when the profile cannot be opened.
    try { saveSiteStateAtomic(siteSessionPath(host, sessionDir), state); } catch { if (!persistent) return { ok: false, code: 'not_saved', reason: 'the session file could not be written' }; }
    return { ok: true, host, cookies, profile: persistent };
  } catch {
    return { ok: false, code: 'failed', reason: 'the browser session failed' };
  } finally {
    try { await browser?.close(); } catch { /* closing a window the owner already closed */ }
    lock.handle.release();
  }
}
