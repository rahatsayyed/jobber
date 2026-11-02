// Browser context of ONE platform session (LinkedIn main, Naukri, Wellfound). First choice: a tab in the shared browser host
// (src/webcore/hostClient.ts), the ONE profile secrets/browser-profile/ that every platform and the web group use. When the host is
// off or cannot be reached: the old per-platform profile secrets/browser-profile-<name>/ (headless, extensions allowed) when it
// exists, else a fresh browser plus the state file. The platform state file (secrets/<x>-state.json) stays the fallback and the
// source for the session checks: it is imported into a profile once, and refreshed from the context when a profile run ends.
// Never logs or returns a cookie value. Launches only through src/webcore/launch.ts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADLESS_CONTEXT_OPTIONS, launchPersistentChrome, launchRealChrome, persistentSupported, type LiBrowser, type LiContext, type LiLauncher } from './launch.js';
import { loginProfileDir } from './loginBrowser.js';
import { cleanCookies, prepareProfileDir } from './profile.js';
import { acquireLock, writeStateAtomic, type LockHandle } from '../linkedin/session.js';
import { resolveHost, type HostAttach } from './hostClient.js';
import { hostProcessExists } from './hostFile.js';

const SECRETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'secrets');

export type PlatformProfileName = 'linkedin-main' | 'naukri' | 'wellfound';
export const PLATFORM_PROFILE_NAMES: readonly PlatformProfileName[] = ['linkedin-main', 'naukri', 'wellfound'];
export const STATE_IMPORT_MARKER = '.platform-state-imported.json';

type Cookie = { name?: unknown };
const cookiesOf = (state: unknown): Cookie[] => {
  const c = (state as { cookies?: unknown } | null)?.cookies;
  return Array.isArray(c) ? (c as Cookie[]) : [];
};
const nameIs = (test: (n: string) => boolean) => (state: unknown): boolean =>
  cookiesOf(state).some((c) => typeof c?.name === 'string' && test(c.name));

export interface PlatformProfileInfo {
  label: string;
  stateFile: string;
  /** Lock file that guards the profile directory (one Chrome per directory). */
  lockFile: string;
  /** Cookie NAME check only; values are never read. */
  hasAuth: (state: unknown) => boolean;
}

export const PLATFORM_PROFILES: Record<PlatformProfileName, PlatformProfileInfo> = {
  'linkedin-main': { label: 'LinkedIn main', stateFile: 'linkedin-main-state.json', lockFile: 'linkedin.lock', hasAuth: nameIs((n) => n === 'li_at') },
  naukri: { label: 'Naukri', stateFile: 'naukri-state.json', lockFile: 'naukri-profile.lock', hasAuth: nameIs((n) => n.toLowerCase().startsWith('nauk')) },
  wellfound: { label: 'Wellfound', stateFile: 'wellfound-state.json', lockFile: 'wellfound.lock', hasAuth: nameIs((n) => /^_?(wellfound|angellist)/i.test(n)) },
};

export const isPlatformProfileName = (n: string): n is PlatformProfileName => (PLATFORM_PROFILE_NAMES as readonly string[]).includes(n);
export const platformProfileDir = (name: PlatformProfileName, root: string = SECRETS): string => loginProfileDir(name, root);
export const platformStatePath = (name: PlatformProfileName, root: string = SECRETS): string => path.join(root, PLATFORM_PROFILES[name].stateFile);
export const platformLockPath = (name: PlatformProfileName, root: string = SECRETS): string => path.join(root, PLATFORM_PROFILES[name].lockFile);

/**
 * One-time import of the platform state file's cookies into the persistent profile (marker file in the profile, like
 * importLegacySessions). localStorage origins are NOT imported (the platforms authenticate by cookie). Never throws.
 */
export async function importStateOnce(ctx: LiContext, profileDir: string, statePath: string, markerName: string = STATE_IMPORT_MARKER): Promise<{ imported: boolean; cookies: number }> {
  const marker = path.join(profileDir, markerName);
  if (existsSync(marker) || typeof ctx.addCookies !== 'function' || !existsSync(statePath)) return { imported: false, cookies: 0 };
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { cookies?: unknown };
    const list = cleanCookies(state.cookies);
    if (!list.length) return { imported: false, cookies: 0 };
    await ctx.addCookies(list);
    writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), cookies: list.length }), { mode: 0o600 });
    return { imported: true, cookies: list.length };
  } catch {
    return { imported: false, cookies: 0 };
  }
}

/**
 * Shared-host path: top up the live profile with the platform state file's cookies that the profile LACKS (matched by name, domain
 * and path; live cookies are never overwritten). Why: the one-time import only runs when the host starts, a state file refreshed
 * later (npm run naukri:login, a session check) never reached the profile, and cookies without an expiry (csrf and session ids)
 * are dropped whenever the host's Chrome exits after its idle time. Never throws; never logs a value.
 */
export async function topUpFromStateFile(ctx: LiContext, statePath: string): Promise<number> {
  try {
    if (typeof ctx.addCookies !== 'function' || typeof ctx.cookies !== 'function' || !existsSync(statePath)) return 0;
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { cookies?: unknown };
    const wanted = cleanCookies(state.cookies) as Array<{ name?: string; domain?: string; path?: string }>;
    if (!wanted.length) return 0;
    const key = (c: { name?: unknown; domain?: unknown; path?: unknown }): string => `${String(c.name)}|${String(c.domain ?? '').replace(/^\./, '')}|${String(c.path ?? '/')}`;
    const have = new Set((await ctx.cookies()).map((c) => key(c as { name?: unknown })));
    const missing = wanted.filter((c) => !have.has(key(c)));
    if (!missing.length) return 0;
    await ctx.addCookies(missing);
    return missing.length;
  } catch {
    return 0;
  }
}

/** Writes the context's storage state to the platform state file, atomically, only when it still holds the auth cookie. Never throws. */
export async function refreshStateFile(ctx: LiContext, statePath: string, name: PlatformProfileName): Promise<boolean> {
  try {
    const state = await ctx.storageState();
    if (!PLATFORM_PROFILES[name].hasAuth(state)) return false;
    writeStateAtomic(statePath, state);
    return true;
  } catch {
    return false;
  }
}

export type PlatformContextResult =
  | { ok: true; browser: LiBrowser; context: LiContext; persistent: boolean; lock: LockHandle | null; /** A tab in the shared host. */ shared?: boolean }
  | { ok: false; code: 'chrome_unavailable' | 'failed' | 'session_locked' | 'halted'; reason?: string };

export interface PlatformContextOpts {
  name: PlatformProfileName;
  statePath: string;
  launcher?: LiLauncher;
  contextOptions?: Record<string, unknown>;
  /** Profile directory; null turns the persistent launch off. Default: secrets/browser-profile-<name>. */
  profileDir?: string | null;
  /**
   * When set, this call takes that lock BEFORE launching the persistent profile (callers whose session already holds the platform
   * lock leave it unset). A held lock means no persistent launch at all (never a second Chrome on the directory): the state-file
   * launch below runs instead.
   */
  profileLockPath?: string;
  /** Shared browser host: injected (tests), null (off), or undefined (on by default with the real launcher, see resolveHost). */
  host?: HostAttach | null;
  /** Pidfile of the shared host (tests); default is the real one. */
  hostPidPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The headless context of a platform session: the persistent profile when its directory exists, the launcher supports profiles and
 * Chrome opens it; otherwise today's fresh browser plus the state file. The caller has already checked the state file and holds
 * the session lock where one exists.
 */
export async function openPlatformContext(opts: PlatformContextOpts): Promise<PlatformContextResult> {
  const dir = opts.profileDir === undefined ? platformProfileDir(opts.name) : opts.profileDir;
  // A null profile directory (tests, an explicit state file) keeps the shared host out too.
  const host = dir === null ? null : resolveHost(opts.host, opts.env ?? process.env, opts.launcher);
  if (host) {
    let lock: LockHandle | null = null;
    let lockHeld = false;
    if (opts.profileLockPath) {
      const l = acquireLock(opts.profileLockPath);
      if (l.ok) lock = l.handle; else lockHeld = true;
    }
    if (!lockHeld) {
      const r = await host({ contextOptions: opts.contextOptions ?? HEADLESS_CONTEXT_OPTIONS });
      if (r.ok) {
        await topUpFromStateFile(r.context, opts.statePath);
        return { ok: true, browser: r.browser, context: r.context, persistent: true, lock, shared: true };
      }
      lock?.release();
      if (r.code === 'halted') return { ok: false, code: 'halted', reason: r.reason };
      if (r.code === 'busy_headed' || r.code === 'busy') return { ok: false, code: 'session_locked', reason: r.reason };
      // A host process that exists (starting or hung) may hold the profile lock: never open the same profile a second time.
      if (r.code === 'unavailable' && hostProcessExists(opts.hostPidPath)) return { ok: false, code: 'session_locked', reason: 'the shared browser host is starting or not answering and holds the profile; try again in a few minutes' };
      // disabled, or unavailable with no host process: the old path below.
    }
  }
  if (dir && existsSync(dir) && persistentSupported(opts.launcher) && prepareProfileDirSafe(dir)) {
    let lock: LockHandle | null = null;
    let locked = false;
    if (opts.profileLockPath) {
      const l = acquireLock(opts.profileLockPath);
      if (l.ok) lock = l.handle; else locked = true;
    }
    if (!locked) {
      try {
        const pc = await launchPersistentChrome({ userDataDir: dir, launcher: opts.launcher });
        await importStateOnce(pc, dir, opts.statePath);
        return { ok: true, browser: { newContext: async () => pc, close: () => pc.close() }, context: pc, persistent: true, lock };
      } catch {
        /* fall through to the state-file launch */
      }
      lock?.release();
    }
  }
  let browser: LiBrowser;
  try {
    browser = await launchRealChrome({ launcher: opts.launcher });
  } catch {
    return { ok: false, code: 'chrome_unavailable' };
  }
  try {
    const context = await browser.newContext({ ...(opts.contextOptions ?? HEADLESS_CONTEXT_OPTIONS), storageState: opts.statePath });
    return { ok: true, browser, context, persistent: false, lock: null };
  } catch {
    await browser.close().catch(() => undefined);
    return { ok: false, code: 'failed' };
  }
}

function prepareProfileDirSafe(dir: string): boolean {
  try { return prepareProfileDir(dir).ok; } catch { return false; }
}

/** Extension ids installed in a profile (names of the Default/Extensions entries), for the doctor and the owner CLI. */
export function extensionIds(list: (p: string) => string[], profileDir: string): string[] {
  try { return list(path.join(profileDir, 'Default', 'Extensions')).filter((n) => /^[a-p]{32}$/.test(n)); } catch { return []; }
}
