// Owner-only: headed real Chrome login for the MAIN LinkedIn account. Not run by tests or the agent.
//   npm run linkedin:login
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { launchRealChrome, LINKEDIN_CONTEXT_OPTIONS } from '../src/webcore/launch.js';
import { DEFAULT_SESSION_PATH, saveStateAtomic } from '../src/linkedin/session.js';
import type { LiLauncher } from '../src/webcore/launch.js';

export interface LoginIo {
  ask(question: string): Promise<string>;
}

export interface LoginDeps {
  io?: LoginIo;
  launcher?: LiLauncher;
  outPath?: string;
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

export async function main(deps: LoginDeps = {}): Promise<number> {
  const io = deps.io ?? stdinIo();
  let browser;
  try {
    browser = await launchRealChrome({ headed: true, launcher: deps.launcher });
  } catch (e) {
    console.error(`Login failed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`);
    return 1;
  }
  try {
    const context = await browser.newContext({ ...LINKEDIN_CONTEXT_OPTIONS });
    const page = await context.newPage();
    await page.goto('https://www.linkedin.com/login');
    console.log('\nA Chrome window opened for the MAIN LinkedIn account.');
    console.log('Log in there yourself (2FA, CAPTCHA and device prompts are normal).');
    console.log('When you see your LinkedIn feed, come back here and press Enter to save the session.\n');
    await io.ask('');
    const state = (await context.storageState()) as { cookies?: unknown[] };
    saveStateAtomic(deps.outPath ?? DEFAULT_SESSION_PATH, state);
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
