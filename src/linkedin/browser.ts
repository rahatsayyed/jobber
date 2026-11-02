// The ONLY place in src/linkedin/* and scripts/linkedin-*.ts that launches a browser: real
// installed Google Chrome through patchright (the Naukri headless recipe), never bundled Chromium.
import { chromium as patchrightChromium } from 'patchright';
import type { LiBrowser, LiContext, LiLauncher } from './types.js';

/** Akamai blocks the `HeadlessChrome` UA token; a real Chrome UA with en-IN/Asia/Kolkata passes. */
export const HEADLESS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const HEADLESS_CONTEXT_OPTIONS = {
  userAgent: HEADLESS_USER_AGENT,
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
  viewport: { width: 1440, height: 900 },
};

export const LINKEDIN_LAUNCH_OPTIONS = { channel: 'chrome', headless: true, args: ['--headless=new'] } as const;
/** Owner login script only. */
export const LINKEDIN_HEADED_LAUNCH_OPTIONS = { channel: 'chrome', headless: false } as const;
export const LINKEDIN_CONTEXT_OPTIONS = HEADLESS_CONTEXT_OPTIONS;

export async function launchRealChrome(opts: { headed?: boolean; launcher?: LiLauncher } = {}): Promise<LiBrowser> {
  const launcher = opts.launcher ?? (patchrightChromium as unknown as LiLauncher);
  try {
    return await launcher.launch(
      opts.headed
        ? { ...LINKEDIN_HEADED_LAUNCH_OPTIONS }
        : { channel: LINKEDIN_LAUNCH_OPTIONS.channel, headless: true, args: [...LINKEDIN_LAUNCH_OPTIONS.args] },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`chrome_unavailable: ${msg.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}

// ---- Persistent profile (web runtime only: scout, applier, search dork, apply:assist, browser:open) ----
// ONE real Chrome profile directory holds the cookies and the browser's own history of everything the web runtime does. The platform
// sessions (LinkedIn main, Naukri, Wellfound) use their OWN profile directory (secrets/browser-profile-<name>/, see
// src/webcore/platformProfile.ts); there is only one LinkedIn identity (the main account). This is the only file allowed to start a persistent context.
export type LiPersistentContext = LiContext & { close(): Promise<void> };
type PersistentCapable = { launchPersistentContext?: (dir: string, opts: Record<string, unknown>) => Promise<LiPersistentContext> };

/** Chrome switches that keep its own password manager quiet: passwords live only in secrets/site-accounts.json. */
export const PERSISTENT_PROFILE_ARGS = ['--disable-save-password-bubble', '--password-store=basic', '--disable-features=PasswordLeakDetection,PasswordManagerOnboarding'] as const;

/** True when this launcher (default: patchright's) can open a persistent profile. Fakes in tests usually cannot. */
export function persistentSupported(launcher?: LiLauncher): boolean {
  return typeof ((launcher ?? patchrightChromium) as unknown as PersistentCapable).launchPersistentContext === 'function';
}

export async function launchPersistentChrome(opts: { userDataDir: string; headed?: boolean; launcher?: LiLauncher }): Promise<LiPersistentContext> {
  const launcher = (opts.launcher ?? patchrightChromium) as unknown as PersistentCapable;
  if (typeof launcher.launchPersistentContext !== 'function') throw new Error('persistent_unsupported');
  try {
    return await launcher.launchPersistentContext(opts.userDataDir, {
      channel: LINKEDIN_LAUNCH_OPTIONS.channel,
      headless: !opts.headed,
      // Extensions installed in the profile (a password manager) must load, also under --headless=new.
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [...(opts.headed ? [] : LINKEDIN_LAUNCH_OPTIONS.args), ...PERSISTENT_PROFILE_ARGS],
      ...HEADLESS_CONTEXT_OPTIONS,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`chrome_unavailable: ${msg.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}
