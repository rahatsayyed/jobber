// A HEADED Chrome window for the owner, on the same shared profile the headless tasks use (the browser host switches to a window and
// back): the owner logs in, solves a CAPTCHA or completes MFA by hand, presses Enter, and the session persists (in the profile, and
// in the per-host session file kept as the fallback).
// Nothing the owner types or clicks is read, logged or returned: this code only opens the page, waits, and saves browser storage state.
import { existsSync } from 'node:fs';
import { HEADLESS_CONTEXT_OPTIONS, launchPersistentChrome, launchRealChrome, persistentSupported, type LiBrowser, type LiContext, type LiLauncher } from './launch.js';
import { DEFAULT_PROFILE_DIR, importLegacySessions, prepareProfileDir } from './profile.js';
import { resolveHost, type HostAttach } from './hostClient.js';
import { acquireLock, checkSiteSessionDir, checkSiteSessionFile, DEFAULT_SITE_SESSION_DIR, DEFAULT_WEB_LOCK_PATH, saveSiteStateAtomic, siteSessionPath } from './session.js';

export interface HeadedIo { ask(question: string): Promise<string>; log(line: string): void }

export interface HeadedDeps {
  io: HeadedIo;
  launcher?: LiLauncher;
  lockPath?: string;
  sessionDir?: string;
  /** null turns the persistent profile (and the shared host) off (per-host session file only). */
  profileDir?: string | null;
  /** Shared browser host: injected (tests), null (off), undefined (on by default with the real launcher). */
  host?: HostAttach | null;
}

export type HeadedResult =
  | { ok: true; host: string; cookies: number; profile: boolean }
  | { ok: false; code: 'session_locked' | 'session_invalid' | 'chrome_unavailable' | 'not_saved' | 'failed'; reason: string };

export const hostOf = (u: string): string => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

/** The owner part: open the page, wait for Enter, save the per-host fallback file. */
async function interact(url: string, host: string, context: LiContext, persistent: boolean, deps: HeadedDeps, sessionDir: string): Promise<HeadedResult> {
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
}

export async function runHeaded(url: string, deps: HeadedDeps): Promise<HeadedResult> {
  const host = hostOf(url);
  if (!host) return { ok: false, code: 'failed', reason: 'the address is not a valid URL' };
  const sessionDir = deps.sessionDir ?? DEFAULT_SITE_SESSION_DIR;
  const profileDir = deps.profileDir === undefined ? DEFAULT_PROFILE_DIR : deps.profileDir;
  const dirChk = checkSiteSessionDir(sessionDir);
  if (!dirChk.ok) return { ok: false, code: 'session_invalid', reason: dirChk.reason ?? 'session directory invalid' };
  // The shared browser host, switched to a window on the same profile (cookies and history in sync with the headless tasks); it is
  // stopped again when the window is done, and the next task starts it headless.
  const shared = profileDir ? resolveHost(deps.host, process.env, deps.launcher) : null;
  if (shared) {
    const r = await shared({ headed: true, contextOptions: HEADLESS_CONTEXT_OPTIONS });
    if (r.ok) {
      try { return await interact(url, host, r.context, true, deps, sessionDir); } catch { return { ok: false, code: 'failed', reason: 'the browser session failed' }; } finally { await r.browser.close().catch(() => undefined); }
    }
    if (r.code === 'busy' || r.code === 'busy_headed') return { ok: false, code: 'session_locked', reason: r.reason };
    if (r.code === 'halted') return { ok: false, code: 'failed', reason: 'the kill switch is on' };
  }
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
    return await interact(url, host, context, persistent, deps, sessionDir);
  } catch {
    return { ok: false, code: 'failed', reason: 'the browser session failed' };
  } finally {
    try { await browser?.close(); } catch { /* closing a window the owner already closed */ }
    lock.handle.release();
  }
}
