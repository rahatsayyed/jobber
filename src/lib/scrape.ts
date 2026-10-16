import { launchRealChrome, HEADLESS_CONTEXT_OPTIONS, type LiLauncher } from '../webcore/launch.js';
import { extractEmails } from './emails.js';

const PATHS = ['', '/careers', '/contact', '/about', '/jobs'];

// Page scripts are strings: the shared launcher's page type evaluates source text only.
const BODY_TEXT_SRC = 'document.body ? document.body.innerText : ""';
const MAILTO_SRC =
  'Array.from(document.querySelectorAll(\'a[href^="mailto:"]\')).map(function (a) { return a.getAttribute("href") || ""; })';

/** Company-site email scraping through the shared launcher (installed Chrome via patchright). */
export async function scrapeEmails(domain: string, opts: { launcher?: LiLauncher } = {}): Promise<string[]> {
  const base = `https://${domain}`;
  const urls = PATHS.map((p) => base + p);

  let browser;
  const found = new Set<string>();

  try {
    browser = await launchRealChrome({ launcher: opts.launcher });
    const context = await browser.newContext({ ...HEADLESS_CONTEXT_OPTIONS });
    const page = await context.newPage();

    for (const url of urls) {
      try {
        await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
        const bodyText = await page.evaluate<string>(BODY_TEXT_SRC);
        const mailtoHrefs = await page.evaluate<string[]>(MAILTO_SRC);
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
    if (browser) await browser.close().catch(() => undefined);
  }

  return [...found];
}
