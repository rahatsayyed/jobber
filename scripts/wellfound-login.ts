// Owner-only: headed real Chrome login for your Wellfound account. Not run by tests or the agent.
//   npm run wellfound:login
// Uses the same Chrome recipe and context options as the headless runtime so the saved session
// matches the fingerprint the site sees later. No flag.
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchRealChrome, HEADLESS_CONTEXT_OPTIONS } from '../src/webcore/launch.js';
import { writeStateAtomic } from '../src/linkedin/session.js';
import type { LiLauncher } from '../src/webcore/launch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WELLFOUND_STATE_PATH = path.join(ROOT, 'secrets', 'wellfound-state.json');

export interface LoginIo {
  ask(question: string): Promise<string>;
}

export interface WellfoundLoginDeps {
  io?: LoginIo;
  launcher?: LiLauncher;
  outPath?: string;
}

// Cookie NAME check only (values are never read). The auth cookie name is UNVERIFIED (no live login has run):
// the rule accepts a cookie whose name starts with `_wellfound` or `_angellist`, and the doctor `sessions` check uses the same rule.
export function hasWellfoundAuthCookie(state: unknown): boolean {
  const cookies = (state as { cookies?: unknown } | null)?.cookies;
  return Array.isArray(cookies) && cookies.some((c) => {
    const n = (c as { name?: unknown } | null)?.name;
    return typeof n === 'string' && /^_?(wellfound|angellist)/i.test(n);
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

export async function main(deps: WellfoundLoginDeps = {}): Promise<number> {
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
    await page.goto('https://wellfound.com/login');
    console.log('\nA Chrome window opened for your Wellfound account.');
    console.log('Log in there yourself (verification prompts and CAPTCHA are normal).');
    console.log('When you see your Wellfound jobs page, come back here and press Enter to save the session.\n');
    await io.ask('');
    const state = (await context.storageState()) as { cookies?: unknown[] };
    if (!hasWellfoundAuthCookie(state)) {
      console.error('Not saved: no Wellfound login cookie found. Finish logging in, then run this again.');
      return 1;
    }
    writeStateAtomic(deps.outPath ?? WELLFOUND_STATE_PATH, state);
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
