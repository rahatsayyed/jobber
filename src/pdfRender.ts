// HTML file -> A4 PDF through the shared real-Chrome launcher (headless installed Google Chrome).
// The resume renderer (renderer/index.js) only writes resume.html; printing lives here so that no code
// outside the launcher imports a browser library (tests/browser-launch-lint.test.ts).
import { pathToFileURL } from 'node:url';
import { launchRealChrome } from './webcore/launch.js';
import type { LiLauncher } from './webcore/launch.js';

export async function htmlToPdf(htmlPath: string, pdfPath: string, deps: { launcher?: LiLauncher } = {}): Promise<void> {
  const browser = await launchRealChrome({ launcher: deps.launcher });
  try {
    // The page is local static HTML built from resume text (the template has no scripts): run none while printing.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    if (!page.pdf) throw new Error('chrome_pdf_unsupported');
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
