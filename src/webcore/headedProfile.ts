// A HEADED Chrome window on one PLATFORM profile (linkedin-main, naukri, wellfound), for `npm run browser:open -- --profile <name>`:
// the owner installs or configures a browser extension (Bitwarden) there once, from the Chrome Web Store. Extensions installed in
// the profile then load in the unattended headless runs too. It reads nothing the owner does, takes the platform's lock first (a
// running wake or another command holds it: refused, never a second Chrome on the directory) and never opens the LinkedIn burner.
import { launchPersistentChrome, persistentSupported, type LiLauncher } from './launch.js';
import { importStateOnce, platformLockPath, platformProfileDir, platformStatePath, refreshStateFile, PLATFORM_PROFILES, type PlatformProfileName } from './platformProfile.js';
import { prepareProfileDir } from './profile.js';
import { acquireLock } from '../linkedin/session.js';
import type { HeadedIo } from './headed.js';

export type HeadedProfileResult =
  | { ok: true; profileDir: string; stateRefreshed: boolean }
  | { ok: false; code: 'session_locked' | 'unsupported' | 'profile_refused' | 'chrome_unavailable' | 'failed'; reason: string };

export async function runHeadedProfile(url: string, deps: { name: PlatformProfileName; io: HeadedIo; launcher?: LiLauncher; root?: string }): Promise<HeadedProfileResult> {
  const info = PLATFORM_PROFILES[deps.name];
  if (!persistentSupported(deps.launcher)) return { ok: false, code: 'unsupported', reason: 'this Chrome launcher cannot open a profile' };
  const dir = platformProfileDir(deps.name, deps.root);
  const lock = acquireLock(platformLockPath(deps.name, deps.root));
  if (!lock.ok) return { ok: false, code: 'session_locked', reason: `the ${info.label} browser profile is busy (a wake or another command holds it); try again in a few minutes` };
  let pc: Awaited<ReturnType<typeof launchPersistentChrome>> | null = null;
  try {
    const prep = prepareProfileDir(dir);
    if (!prep.ok) return { ok: false, code: 'profile_refused', reason: prep.reason ?? 'profile directory refused' };
    const statePath = platformStatePath(deps.name, deps.root);
    try { pc = await launchPersistentChrome({ userDataDir: dir, headed: true, launcher: deps.launcher }); } catch { return { ok: false, code: 'chrome_unavailable', reason: 'could not open the profile in Chrome (is it open in another Chrome window?)' }; }
    await importStateOnce(pc, dir, statePath);
    const page = await pc.newPage();
    await page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
    deps.io.log(`A Chrome window opened on the ${info.label} profile (${url}).`);
    deps.io.log('Install or configure your extension there yourself. Nothing you type is read by this tool.');
    await deps.io.ask('When you are done, press Enter here to close the window: ');
    const stateRefreshed = await refreshStateFile(pc, statePath, deps.name);
    return { ok: true, profileDir: dir, stateRefreshed };
  } catch {
    return { ok: false, code: 'failed', reason: 'the browser session failed' };
  } finally {
    try { await pc?.close(); } catch { /* the owner already closed the window */ }
    lock.handle.release();
  }
}
