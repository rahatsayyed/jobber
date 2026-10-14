import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const outPath = 'secrets/naukri-state.json';
mkdirSync(dirname(outPath), { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('https://www.naukri.com/nlogin/login');

console.log('\nA browser window opened for your Naukri account.');
console.log('Log in manually (including any OTP/CAPTCHA prompts).');
console.log('Once you land on your Naukri homepage/dashboard, come back here and press Enter to save the session.\n');

await new Promise<void>((resolve) => {
  process.stdin.once('data', () => resolve());
});

await context.storageState({ path: outPath });
console.log(`Saved session to ${outPath}`);

await browser.close();
process.exit(0);
