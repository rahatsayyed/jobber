// The ONLY place in src/linkedin/* and scripts/linkedin-*.ts that launches a browser: real
// installed Google Chrome through patchright (the Naukri headless recipe), never bundled Chromium.
import { chromium as patchrightChromium } from 'patchright';
import { HEADLESS_CONTEXT_OPTIONS } from '../sources/naukri.js'; // reuse, do not duplicate the UA
import type { LiBrowser, LiLauncher } from './types.js';

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
