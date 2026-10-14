import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const account = process.argv[2];
if (account !== 'burner' && account !== 'main') {
  console.error('Usage: npx tsx scripts/save-linkedin-session.ts <burner|main>');
  process.exit(1);
}

const outPath = `secrets/linkedin-${account}-state.json`;
mkdirSync(dirname(outPath), { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('https://www.linkedin.com/login');

console.log(`\nA browser window opened for the ${account.toUpperCase()} account.`);
console.log('Log in manually (including any 2FA/CAPTCHA/"remember this device" prompts).');
console.log('Once you land on your LinkedIn feed, come back here and press Enter to save the session.\n');

await new Promise<void>((resolve) => {
  process.stdin.once('data', () => resolve());
});

await context.storageState({ path: outPath });
console.log(`Saved session to ${outPath}`);

await browser.close();
process.exit(0);
