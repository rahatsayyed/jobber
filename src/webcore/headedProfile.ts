// A HEADED Chrome window for one PLATFORM (linkedin-main, naukri, wellfound), for `npm run browser:open -- --profile <name>`: the owner
// installs or configures a browser extension there once, from the Chrome Web Store, or fixes something by hand. Extensions are
// allowed in general: what is installed in the profile also loads in the unattended headless runs. With the shared browser host this
// is the ONE shared profile (secrets/browser-profile/; the host switches to a window and back); without it, the platform's own old
// profile (secrets/browser-profile-<name>/). It reads nothing the owner does and takes the platform's lock first (a running wake or
// another command holds it: refused, never a second Chrome on a profile directory).
import { launchPersistentChrome, persistentSupported, HEADLESS_CONTEXT_OPTIONS, type LiContext, type LiLauncher } from './launch.js';
import { importStateOnce, platformLockPath, platformProfileDir, platformStatePath, refreshStateFile, PLATFORM_PROFILES, type PlatformProfileName } from './platformProfile.js';
import { DEFAULT_PROFILE_DIR, prepareProfileDir } from './profile.js';
import { acquireLock } from '../linkedin/session.js';
import { resolveHost, OWNER_WAIT_MS, type HostAttach } from './hostClient.js';
import { hostProcessExists } from './hostFile.js';
import type { HeadedIo } from './headed.js';

export type HeadedProfileResult =
  | { ok: true; profileDir: string; stateRefreshed: boolean; shared: boolean }
  | { ok: false; code: 'session_locked' | 'unsupported' | 'profile_refused' | 'chrome_unavailable' | 'failed'; reason: string };

async function interact(url: string, label: string, ctx: LiContext, statePath: string, name: PlatformProfileName, io: HeadedIo): Promise<boolean> {
  const page = await ctx.newPage();
  await page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
  io.log(`A Chrome window opened on the ${label} profile (${url}).`);
  io.log('Install or configure your extension there yourself. Nothing you type is read by this tool.');
  await io.ask('When you are done, press Enter here to close the window: ');
  return refreshStateFile(ctx, statePath, name);
}

export async function runHeadedProfile(
  url: string,
  deps: { name: PlatformProfileName; io: HeadedIo; launcher?: LiLauncher; root?: string; host?: HostAttach | null; sharedProfileDir?: string; hostPidPath?: string },
): Promise<HeadedProfileResult> {
  const info = PLATFORM_PROFILES[deps.name];
  const lock = acquireLock(platformLockPath(deps.name, deps.root));
  if (!lock.ok) return { ok: false, code: 'session_locked', reason: `the ${info.label} browser profile is busy (a wake or another command holds it); try again in a few minutes` };
  const statePath = platformStatePath(deps.name, deps.root);
  try {
    const shared = resolveHost(deps.host, process.env, deps.launcher);
    if (shared) {
      const r = await shared({ headed: true, waitForTasksMs: OWNER_WAIT_MS, contextOptions: HEADLESS_CONTEXT_OPTIONS });
      if (r.ok) {
        try {
          const stateRefreshed = await interact(url, `shared (${info.label})`, r.context, statePath, deps.name, deps.io);
          return { ok: true, profileDir: deps.sharedProfileDir ?? DEFAULT_PROFILE_DIR, stateRefreshed, shared: true };
        } catch {
          return { ok: false, code: 'failed', reason: 'the browser session failed' };
        } finally {
          await r.browser.close().catch(() => undefined);
        }
      }
      if (r.code === 'busy' || r.code === 'busy_headed') return { ok: false, code: 'session_locked', reason: r.reason };
      if (r.code === 'halted') return { ok: false, code: 'failed', reason: 'the kill switch is on' };
      if (r.code === 'unavailable' && hostProcessExists(deps.hostPidPath)) return { ok: false, code: 'session_locked', reason: 'the shared browser host is starting or not answering and holds the profile; try again in a few minutes' };
    }
    if (!persistentSupported(deps.launcher)) return { ok: false, code: 'unsupported', reason: 'this Chrome launcher cannot open a profile' };
    const dir = platformProfileDir(deps.name, deps.root);
    const prep = prepareProfileDir(dir);
    if (!prep.ok) return { ok: false, code: 'profile_refused', reason: prep.reason ?? 'profile directory refused' };
    let pc: Awaited<ReturnType<typeof launchPersistentChrome>> | null = null;
    try {
      try { pc = await launchPersistentChrome({ userDataDir: dir, headed: true, launcher: deps.launcher }); } catch { return { ok: false, code: 'chrome_unavailable', reason: 'could not open the profile in Chrome (is it open in another Chrome window?)' }; }
      await importStateOnce(pc, dir, statePath);
      const stateRefreshed = await interact(url, info.label, pc, statePath, deps.name, deps.io);
      return { ok: true, profileDir: dir, stateRefreshed, shared: false };
    } catch {
      return { ok: false, code: 'failed', reason: 'the browser session failed' };
    } finally {
      try { await pc?.close(); } catch { /* the owner already closed the window */ }
    }
  } finally {
    lock.handle.release();
  }
}
