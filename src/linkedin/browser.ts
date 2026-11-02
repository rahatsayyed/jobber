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
      // Extensions are allowed: whatever the owner installed in the profile loads, also under --headless=new.
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [...(opts.headed ? [] : LINKEDIN_LAUNCH_OPTIONS.args), ...PERSISTENT_PROFILE_ARGS],
      ...HEADLESS_CONTEXT_OPTIONS,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`chrome_unavailable: ${msg.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}

// ---- Shared browser host (src/webcore/hostServer.ts owns it, src/webcore/hostClient.ts attaches) ----
// ONE long-lived Chrome on secrets/browser-profile/ for every platform and the web group. The host process launches it with a
// DevTools port that Chrome picks itself (port 0, loopback only; Chrome writes the port into <profile>/DevToolsActivePort, which is
// inside the 0700 profile directory); the MCP processes connect over CDP and open their own tab. The endpoint is never logged.
export const HOST_DEBUG_ARGS = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] as const;

/** A page of the host's context, as the host sees it (only what the host needs: count and close). */
export interface HostPage { close(): Promise<void>; isClosed(): boolean }
/** The host's persistent context: pages, page and close events. */
export type HostContext = LiPersistentContext & {
  pages(): HostPage[];
  on(event: 'page', fn: (p: HostPage) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
};

/** The host process only: the shared profile with extensions allowed (headless or headed) and the loopback DevTools port. */
export async function launchHostChrome(opts: { userDataDir: string; headed?: boolean; launcher?: LiLauncher }): Promise<HostContext> {
  const launcher = (opts.launcher ?? patchrightChromium) as unknown as PersistentCapable;
  if (typeof launcher.launchPersistentContext !== 'function') throw new Error('persistent_unsupported');
  try {
    return (await launcher.launchPersistentContext(opts.userDataDir, {
      channel: LINKEDIN_LAUNCH_OPTIONS.channel,
      headless: !opts.headed,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [...(opts.headed ? [] : LINKEDIN_LAUNCH_OPTIONS.args), ...PERSISTENT_PROFILE_ARGS, ...HOST_DEBUG_ARGS],
      ...HEADLESS_CONTEXT_OPTIONS,
    })) as unknown as HostContext;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`chrome_unavailable: ${msg.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}

/** A CDP connection to the host's Chrome. close() only disconnects this client (it never closes the browser). */
export interface CdpBrowser { contexts(): LiContext[]; close(): Promise<void> }
export type CdpConnector = { connectOverCDP(endpoint: string, opts?: Record<string, unknown>): Promise<CdpBrowser> };

export async function connectChromeOverCDP(wsEndpoint: string, opts: { connector?: CdpConnector; timeoutMs?: number } = {}): Promise<CdpBrowser> {
  if (!/^ws:\/\/127\.0\.0\.1:\d{2,5}\/devtools\/browser\/[A-Za-z0-9-]+$/.test(wsEndpoint)) throw new Error('cdp_endpoint_refused');
  const connector = opts.connector ?? (patchrightChromium as unknown as CdpConnector);
  return connector.connectOverCDP(wsEndpoint, { timeout: opts.timeoutMs ?? 15000 });
}
