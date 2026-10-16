import { z } from 'zod';
import type { Job } from '../db.js';
import type { Provider } from './provider.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { chromium as patchrightChromium } from 'patchright';

/**
 * Headless mode (`NAUKRI_HEADLESS=true`): Patchright driving the installed Google Chrome with a
 * real User-Agent. Akamai blocks on the `HeadlessChrome` UA token, so the UA override is what
 * unblocks it. Off by default: headed Playwright is
 * the known-good path.
 */
export const HEADLESS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const HEADLESS_CONTEXT_OPTIONS = {
  userAgent: HEADLESS_USER_AGENT,
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
  viewport: { width: 1440, height: 900 },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const DEFAULT_SESSION_STATE_PATH = path.join(projectRoot, 'secrets', 'naukri-state.json');
const CARD_SELECTOR = '.srp-jobtuple-wrapper';
const COMPANY_SITE_BUTTON_SELECTOR = '.company-site-button';
/**
 * Caps how many jobs go through the (slow, sequential, per-job ~40s worst case) apply-URL
 * resolution phase per fetch, so a large new-jobs batch can't hold up the whole `fetchAllJobs`
 * call (which awaits Naukri alongside the fast API sources via `Promise.all`). Jobs beyond the
 * cap simply keep the Naukri listing URL as `apply_url` — an already-supported fallback state.
 */
const MAX_APPLY_URL_RESOLUTIONS_PER_FETCH = 10;

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds a Naukri search-results URL from a role and optional location, matching Naukri's own
 * URL convention (e.g. https://www.naukri.com/full-stack-developer-jobs-in-india). Both segments
 * are slugified.
 */
export function buildNaukriSearchUrl(role: string, location?: string): string {
  const roleSlug = slugify(role);
  const locationSlug = location ? slugify(location) : '';
  const path = locationSlug ? `${roleSlug}-jobs-in-${locationSlug}` : `${roleSlug}-jobs`;
  return `https://www.naukri.com/${path}`;
}

/**
 * Extracts the trailing numeric id from a real Naukri job-listing URL (e.g.
 * `.../hyderabad-2-to-5-years-1504265` -> `1504265`), stripping any query string
 * first. Returns null if the URL has no trailing numeric segment.
 */
export function extractNaukriJobId(url: string): string | null {
  const withoutQuery = url.split('?')[0];
  const match = withoutQuery.match(/-(\d+)$/);
  return match ? match[1] : null;
}

export interface RawNaukriCard {
  titleText: string | null;
  companyText: string | null;
  hrefRaw: string | null;
  descriptionText: string | null;
}

export interface NaukriParseResult {
  jobs: Job[];
  found: number;
  parsed: number;
  skipped: number;
}

/**
 * Parses raw scraped card data into Job objects. A malformed card (missing title/href, or an
 * href with no extractable job id) is skipped and logged, never thrown — matches
 * `parseLinkedInJobCards`'s existing convention in `src/discover/linkedin-jobs.ts`.
 */
export function parseNaukriCards(rawCards: RawNaukriCard[]): NaukriParseResult {
  let parsed = 0;
  let skipped = 0;
  const jobs: Job[] = [];

  for (const card of rawCards) {
    try {
      if (!card.titleText || !card.hrefRaw) {
        throw new Error('missing title or href');
      }
      const jobId = extractNaukriJobId(card.hrefRaw);
      if (!jobId) {
        throw new Error('could not extract job id from href');
      }
      jobs.push({
        id: `naukri:${jobId}`,
        source: 'naukri',
        title: card.titleText.trim(),
        company: (card.companyText ?? '').trim(),
        url: card.hrefRaw,
        apply_url: card.hrefRaw,
        description: (card.descriptionText ?? '').trim(),
      });
      parsed++;
    } catch (err) {
      skipped++;
      console.error('[naukri] skipped malformed card:', err instanceof Error ? err.message : err);
    }
  }

  return { jobs, found: rawCards.length, parsed, skipped };
}

export interface NaukriDeps {
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
  /**
   * Injectable predicate deciding whether a job id is "new" — used ONLY to gate the expensive
   * apply-URL-resolution phase (skip re-resolving jobs the caller already knows about), never to
   * filter what this function returns and never to persist anything. Dedup/persistence is the
   * caller's responsibility (`src/mcp/job-fetch.ts`), matching `adzuna`/`remotive`/`remoteok`'s
   * convention — this module owns no db handle. Defaults to "treat every job as new" (resolve
   * apply-urls for everything returned by the search phase, capped by
   * `MAX_APPLY_URL_RESOLUTIONS_PER_FETCH`) if not given.
   */
  isNewJob?: (jobId: string) => boolean;
  /** Injectable session-state file path, for testing without touching the real secrets file. */
  sessionStatePath?: string;
}

/**
 * Clicks Naukri's "Apply on company site" button if present and returns the resulting new tab's
 * URL — navigation only, never a submission. Returns null if the button isn't present, if
 * waiting for the new tab times out, or if the resulting URL doesn't look like a real resolved
 * destination (still `about:blank`, an error page, or still on naukri.com — see
 * `isResolvedApplyUrl`).
 */
export async function resolveApplyUrl(
  page: Pick<Page, 'locator'>,
  context: Pick<BrowserContext, 'waitForEvent'>
): Promise<string | null> {
  const button = page.locator(COMPANY_SITE_BUTTON_SELECTOR).first();
  if ((await button.count()) === 0) return null;

  try {
    const [newPage] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), button.click()]);
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});
    const url = newPage.url();
    await newPage.close().catch(() => {});
    return isResolvedApplyUrl(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Rejects URLs that indicate `resolveApplyUrl`'s new-tab navigation didn't actually reach the
 * target site: `about:blank` (popup read before it navigated), non-http(s) schemes (e.g.
 * `chrome-error://...`), and anything still on the `naukri.com` domain (an intermediate
 * redirector or a mis-detected click target, not the employer's real ATS).
 */
function isResolvedApplyUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'naukri.com' || hostname.endsWith('.naukri.com')) return false;
  return true;
}

/**
 * Scrapes Naukri's search-results page for a role/location, then (if a saved session exists)
 * resolves the real apply_url for up to `MAX_APPLY_URL_RESOLUTIONS_PER_FETCH` "new" jobs (per
 * `deps.isNewJob`) via `resolveApplyUrl`. One browser launch (headed by default, because Naukri's
 * Akamai bot protection blocks stock headless Chromium; `NAUKRI_HEADLESS=true` switches to
 * Patchright + real Chrome + a real UA, which passes), with two contexts:
 * an unauthenticated one for scraping the search-results page, and (if a saved session exists) an
 * authenticated one for the apply-url resolution phase.
 *
 * This function never touches a database — dedup and persistence are the caller's job (see
 * `NaukriDeps.isNewJob` above), matching the other `src/sources/` modules' convention.
 */
export async function fetchNaukri(
  params: { role: string; location?: string },
  deps: NaukriDeps = {}
): Promise<Job[]> {
  try {
    return (await searchNaukri(params, deps)).jobs;
  } catch (err) {
    console.error('[naukri] fetch failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

// What one scraped card must look like: all four keys present (null when the selector matched nothing). A changed card selector
// shows up as a missing key; per-card nulls are handled by parseNaukriCards.
export const shapeSpec = z.object({
  titleText: z.string().nullable(),
  companyText: z.string().nullable(),
  hrefRaw: z.string().nullable(),
  descriptionText: z.string().nullable(),
}).passthrough();

// Throws on any failure (the runner records it); fetchNaukri keeps the old never-throw contract.
export const provider: Provider = {
  id: 'naukri',
  shapeSpec,
  fetch: (ctx) => searchNaukri({ role: ctx.params?.role ?? '', location: ctx.params?.location }),
};

export async function searchNaukri(
  params: { role: string; location?: string },
  deps: NaukriDeps = {}
): Promise<{ jobs: Job[]; sample: unknown[] }> {
  const headless = process.env.NAUKRI_HEADLESS === 'true';
  const browserLauncher = deps.chromium ?? (headless ? (patchrightChromium as unknown as typeof chromium) : chromium);
  const contextOptions = headless ? HEADLESS_CONTEXT_OPTIONS : {};
  const isNewJob = deps.isNewJob ?? (() => true);
  const sessionStatePath = deps.sessionStatePath ?? DEFAULT_SESSION_STATE_PATH;
  const searchUrl = buildNaukriSearchUrl(params.role, params.location);

  let browser: Browser | undefined;
  try {
    browser = await browserLauncher.launch(
      headless ? { channel: 'chrome', headless: true, args: ['--headless=new'] } : { headless: false }
    );

    let jobs: Job[] = [];
    let sample: unknown[] = [];
    const searchContext = await browser.newContext(contextOptions);
    try {
      const page = await searchContext.newPage();
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(CARD_SELECTOR, { timeout: 15000 });

      const rawCards: RawNaukriCard[] = await page.locator(CARD_SELECTOR).evaluateAll((nodes: Element[]) =>
        nodes.map((n) => {
          const titleEl = n.querySelector('a.title') as HTMLAnchorElement | null;
          const companyEl = n.querySelector('.comp-name');
          const descEl = n.querySelector('.job-desc');
          return {
            titleText: titleEl?.textContent ?? null,
            companyText: companyEl?.textContent ?? null,
            hrefRaw: titleEl?.href ?? null,
            descriptionText: descEl?.textContent ?? null,
          };
        })
      );

      const parseResult = parseNaukriCards(rawCards);
      console.error(`[naukri] ${parseResult.parsed}/${parseResult.found} parsed, ${parseResult.skipped} skipped (malformed)`);
      jobs = parseResult.jobs;
      sample = rawCards.slice(0, 5);
    } catch (err) {
      console.error('[naukri] search fetch failed:', err instanceof Error ? err.message : err);
      throw err;
    } finally {
      await searchContext.close();
    }

    const jobsToResolve = jobs.filter((job) => isNewJob(job.id)).slice(0, MAX_APPLY_URL_RESOLUTIONS_PER_FETCH);

    if (jobsToResolve.length > 0 && existsSync(sessionStatePath)) {
      const applyContext = await browser.newContext({ ...contextOptions, storageState: sessionStatePath });
      try {
        for (const job of jobsToResolve) {
          try {
            const page = await applyContext.newPage();
            await page.goto(job.url, { waitUntil: 'domcontentloaded' });
            const resolvedUrl = await resolveApplyUrl(page, applyContext);
            if (resolvedUrl) job.apply_url = resolvedUrl;
            await page.close();
          } catch (err) {
            console.error(`[naukri] resolveApplyUrl failed for ${job.id}:`, err instanceof Error ? err.message : err);
          }
        }
      } finally {
        await applyContext.close();
      }
    } else if (jobsToResolve.length > 0) {
      console.error(
        `[naukri] session state not found at ${sessionStatePath} — using Naukri listing URLs as apply_url`
      );
    }

    return { jobs, sample };
  } finally {
    await browser?.close();
  }
}
