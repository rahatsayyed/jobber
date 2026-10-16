// Owner-only: headed real Chrome login for your Naukri account. Not run by tests or the agent.
//   npm run naukri:login
// Uses the same Chrome recipe and context options as the headless runtime so the saved session
// matches the fingerprint Akamai sees later.
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchRealChrome, HEADLESS_CONTEXT_OPTIONS } from '../src/webcore/launch.js';
import { writeStateAtomic } from '../src/linkedin/session.js';
import type { LiLauncher } from '../src/webcore/launch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NAUKRI_STATE_PATH = path.join(ROOT, 'secrets', 'naukri-state.json');

export interface LoginIo {
  ask(question: string): Promise<string>;
}

export interface NaukriLoginDeps {
  io?: LoginIo;
  launcher?: LiLauncher;
  outPath?: string;
}

// Cookie NAME check only (same rule as the doctor `sessions` check); values are never read.
export function hasNaukriAuthCookie(state: unknown): boolean {
  const cookies = (state as { cookies?: unknown } | null)?.cookies;
  return Array.isArray(cookies) && cookies.some((c) => {
    const n = (c as { name?: unknown } | null)?.name;
    return typeof n === 'string' && n.toLowerCase().startsWith('nauk');
  });
}

function stdinIo(): LoginIo {
  return {
    ask: (q) =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => { rl.close(); resolve(a); });
      }),
  };
}

export async function main(deps: NaukriLoginDeps = {}): Promise<number> {
  const io = deps.io ?? stdinIo();
  let browser;
  try {
    browser = await launchRealChrome({ headed: true, launcher: deps.launcher });
  } catch (e) {
    console.error(`Login failed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`);
    return 1;
  }
  try {
    const context = await browser.newContext({ ...HEADLESS_CONTEXT_OPTIONS });
    const page = await context.newPage();
    await page.goto('https://www.naukri.com/nlogin/login');
    console.log('\nA Chrome window opened for your Naukri account.');
    console.log('Log in there yourself (OTP and CAPTCHA prompts are normal).');
    console.log('When you see your Naukri homepage, come back here and press Enter to save the session.\n');
    await io.ask('');
    const state = (await context.storageState()) as { cookies?: unknown[] };
    if (!hasNaukriAuthCookie(state)) {
      console.error('Not saved: no Naukri login cookie found. Finish logging in, then run this again.');
      return 1;
    }
    writeStateAtomic(deps.outPath ?? NAUKRI_STATE_PATH, state);
    console.log(`Saved session (${Array.isArray(state.cookies) ? state.cookies.length : 0} cookies)`);
    return 0;
  } catch (e) {
    console.error(`Login failed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`);
    return 1;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((c) => process.exit(c));
}
