import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb, isSeen, saveJob, type Job } from '../db.js';
import { dbPath } from '../dbPath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const CONFIG_PATH = path.join(projectRoot, 'config', 'discover-linkedin.json');
const BURNER_STATE_PATH = path.join(projectRoot, 'secrets', 'linkedin-burner-state.json');

export interface JobSearchEntry {
  name: string;
  search_url?: string;
  keyword?: string;
  location?: string;
  posted_within_seconds?: number;
  remote_only?: boolean;
  easy_apply_only?: boolean;
  experience_level?:
    | 'internship'
    | 'entry'
    | 'associate'
    | 'mid-senior'
    | 'director'
    | 'executive';
  limit: number;
}

export interface DiscoverLinkedInConfig {
  jobs: JobSearchEntry[];
  posts: { role: string; geo: string; limit: number };
}

const EXPERIENCE_LEVEL_CODES: Record<string, string> = {
  internship: '1',
  entry: '2',
  associate: '3',
  'mid-senior': '4',
  director: '5',
  executive: '6',
};

export function buildLinkedInJobsSearchUrl(entry: JobSearchEntry): string {
  const params = new URLSearchParams();
  if (entry.keyword) {
    params.set('keywords', entry.keyword);
  }
  if (entry.location) {
    params.set('location', entry.location);
  }
  if (entry.posted_within_seconds !== undefined) {
    params.set('f_TPR', `r${entry.posted_within_seconds}`);
  }
  if (entry.remote_only) {
    params.set('f_WT', '2');
  }
  if (entry.easy_apply_only) {
    params.set('f_AL', 'true');
  }
  if (entry.experience_level) {
    params.set('f_E', EXPERIENCE_LEVEL_CODES[entry.experience_level]);
  }
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

export function loadDiscoverConfig(): DiscoverLinkedInConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

export interface RawJobCard {
  titleText: string | null;
  companyText: string | null;
  hrefRaw: string | null;
  snippetText: string | null;
  easyApply: boolean;
}

export interface ParseResult {
  jobs: Job[];
  found: number;
  parsed: number;
  skipped: number;
}

export function extractLinkedInJobId(href: string): string | null {
  const match = href.match(/\/jobs\/view\/(\d+)/);
  return match ? match[1] : null;
}

export function parseLinkedInJobCards(rawCards: RawJobCard[]): ParseResult {
  let parsed = 0;
  let skipped = 0;
  const jobs: Job[] = [];

  for (const card of rawCards) {
    try {
      if (!card.titleText || !card.hrefRaw) {
        throw new Error('missing title or href');
      }
      const jobId = extractLinkedInJobId(card.hrefRaw);
      if (!jobId) {
        throw new Error('could not extract job id from href');
      }
      jobs.push({
        id: `li-job:${jobId}`,
        source: 'linkedin-jobs',
        title: card.titleText.trim(),
        company: (card.companyText ?? '').trim(),
        url: card.hrefRaw,
        apply_url: card.hrefRaw,
        description: (card.snippetText ?? '').trim(),
      });
      parsed++;
    } catch (err) {
      skipped++;
      console.error(
        '[discover] linkedin_jobs: skipped malformed card:',
        err instanceof Error ? err.message : err
      );
    }
  }

  return { jobs, found: rawCards.length, parsed, skipped };
}

export interface LinkedInJobsDeps {
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
  /** Injectable db handle, for testing without touching data.sqlite. */
  db?: BetterSqlite3.Database;
  /** Injectable config, for testing without touching config/discover-linkedin.json. */
  configOverride?: DiscoverLinkedInConfig;
  /** Injectable burner session state path, for testing without touching the real secrets file. */
  burnerStatePath?: string;
}

const JOB_CARD_SELECTOR = '.job-card-container, .jobs-search-results__list-item';

export async function fetchLinkedInJobs(deps: LinkedInJobsDeps = {}): Promise<Job[]> {
  const config = deps.configOverride ?? loadDiscoverConfig();
  const db = deps.db ?? openDb(dbPath());
  const browserLauncher = deps.chromium ?? chromium;
  const burnerStatePath = deps.burnerStatePath ?? BURNER_STATE_PATH;

  const resolvedEntries: Array<{ entry: JobSearchEntry; url: string }> = [];
  for (const entry of config.jobs) {
    const hasUsableSearchUrl =
      !!entry.search_url && !entry.search_url.startsWith('REPLACE_WITH_');
    if (hasUsableSearchUrl) {
      resolvedEntries.push({ entry, url: entry.search_url as string });
    } else if (entry.keyword) {
      resolvedEntries.push({ entry, url: buildLinkedInJobsSearchUrl(entry) });
    } else if (entry.search_url) {
      console.error(
        `[discover] linkedin_jobs (${entry.name}): search_url is still the placeholder and no structured fields (keyword) are set — skipping, replace search_url or fill in structured fields to enable this entry`
      );
    } else {
      console.error(
        `[discover] linkedin_jobs (${entry.name}): no search_url and no keyword set — skipping`
      );
    }
  }

  if (resolvedEntries.length === 0) {
    return [];
  }

  if (!existsSync(burnerStatePath)) {
    console.error(`[discover] linkedin_jobs: burner session state not found at ${burnerStatePath}`);
    return [];
  }

  let browser: Browser | undefined;
  const allJobs: Job[] = [];
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: burnerStatePath });

    for (const { entry, url } of resolvedEntries) {
      try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(JOB_CARD_SELECTOR, { timeout: 15000 });

        const rawCards: RawJobCard[] = await page.locator(JOB_CARD_SELECTOR).evaluateAll((nodes: Element[]) =>
          nodes.map((n) => {
            const titleEl = n.querySelector('a.job-card-list__title, .job-card-container__link') as HTMLAnchorElement | null;
            const companyEl = n.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle');
            const snippetEl = n.querySelector('.job-card-list__insight, .job-card-container__metadata-wrapper');
            return {
              titleText: titleEl?.getAttribute('aria-label') ?? titleEl?.textContent ?? null,
              companyText: companyEl?.textContent ?? null,
              hrefRaw: titleEl?.href ?? null,
              snippetText: snippetEl?.textContent ?? null,
              easyApply: !!n.querySelector('[aria-label*="Easy Apply" i]'),
            };
          })
        );

        const capped = rawCards.slice(0, entry.limit);
        const { jobs, found, parsed, skipped } = parseLinkedInJobCards(capped);
        console.error(`[discover] linkedin_jobs (${entry.name}): ${parsed}/${found} parsed, ${skipped} skipped (malformed)`);
        allJobs.push(...jobs);
      } catch (err) {
        console.error(
          `[discover] linkedin_jobs (${entry.name}): fetch failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    const newJobs = allJobs.filter((job) => !isSeen(db, job.id));
    for (const job of newJobs) {
      saveJob(db, job);
    }
    return newJobs;
  } catch (err) {
    console.error('[discover] linkedin_jobs: fetch failed:', err instanceof Error ? err.message : err);
    return [];
  } finally {
    await browser?.close();
  }
}
