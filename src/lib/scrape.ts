import { chromium } from 'playwright';
import { extractEmails } from './emails.js';

const PATHS = ['', '/careers', '/contact', '/about', '/jobs'];

export async function scrapeEmails(domain: string): Promise<string[]> {
  const base = `https://${domain}`;
  const urls = PATHS.map((p) => base + p);

  let browser;
  const found = new Set<string>();

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    for (const url of urls) {
      try {
        await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
        const bodyText = await page.evaluate(() => document.body.innerText);
        const mailtoHrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href^="mailto:"]')).map(
            (a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''
          )
        );
        const combined = `${bodyText}\n${mailtoHrefs.join('\n')}`;
        for (const email of extractEmails(combined)) {
          found.add(email);
        }
      } catch {
        // skip failures for individual pages
      }
    }
  } catch {
    return [];
  } finally {
    if (browser) await browser.close();
  }

  return [...found];
}
