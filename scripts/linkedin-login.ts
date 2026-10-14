// Owner-only: headed real Chrome login for the MAIN LinkedIn account. Not run by tests or the agent.
import { fileURLToPath } from 'node:url';
import { launchRealChrome, LINKEDIN_CONTEXT_OPTIONS } from '../src/linkedin/browser.js';
import { DEFAULT_SESSION_PATH, saveStateAtomic } from '../src/linkedin/session.js';

export function loginAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LINKEDIN_LOGIN_ACCOUNT === 'main';
}

export async function main(): Promise<number> {
  if (!loginAllowed()) {
    console.error('Refusing: set LINKEDIN_LOGIN_ACCOUNT=main to log in the main account.');
    return 1;
  }
  const browser = await launchRealChrome({ headed: true });
  try {
    const context = await browser.newContext({ ...LINKEDIN_CONTEXT_OPTIONS });
    const page = await context.newPage();
    await page.goto('https://www.linkedin.com/login');
    console.log('Log in manually in the opened window, then press Enter here to save the session.');
    await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
    const state = (await context.storageState()) as { cookies?: unknown[] };
    saveStateAtomic(DEFAULT_SESSION_PATH, state);
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
