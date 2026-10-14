# LinkedIn Job & Hiring-Post Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `discover` MCP server with two burner-account, Playwright-based tools — `linkedin_jobs` and `linkedin_posts` — that scrape LinkedIn's own job search and content search (not just what Google has indexed), feeding into the same `jobs` table every other discovery source already uses.

**Architecture:** `src/mcp/discover.ts` registers the two tools; each delegates to a dedicated module (`src/discover/linkedin-jobs.ts`, `src/discover/linkedin-posts.ts`) that owns config loading, the Playwright scrape, pure card parsing/normalization, and the `isSeen`/`saveJob` dedup call. Card extraction happens in-page via Playwright's `locator(...).evaluateAll(...)` (returns plain serializable JS objects — no new HTML-parsing dependency needed); the pure `parseLinkedIn*Cards()` functions then normalize those plain objects into `Job[]`, which is what fixture-based unit tests exercise.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `playwright` (already a dependency), `better-sqlite3` via the existing `src/db.ts` helpers, `vitest`.

## Global Constraints

- Burner account only: `secrets/linkedin-burner-state.json` (same file `src/apply/linkedin.ts` uses). **Never** load `secrets/linkedin-main-state.json` (that's `connect.ts`'s file) — this is a hardcoded path, not a parameter, matching the existing hard rule in `src/apply/linkedin.ts`.
- `config/discover-linkedin.json` is committed to the repo (not gitignored), read fresh via `readFileSync` on every call (same pattern as `config/easy-apply-answers.json` — no MCP reconnect needed to pick up config edits, only needed for actual `.ts` source changes).
- `jobs.limit` and `posts.limit` are independent config values — never a single shared limit.
- Every card-parsing loop must tolerate a malformed individual card (skip + count + log) rather than throwing and losing the whole page's results.
- No daily/session rate limit on these tools (read-only, no messages to real people) — per-run `limit` values are the only volume control.
- Job IDs: `li-job:<linkedin-job-id>` for jobs, `li-post:<activity-urn>` for posts — both flow through the existing `isSeen`/`saveJob` from `src/db.ts`, unchanged.
- `Job` shape (from `src/db.ts`): `{ id, source, title, company, url, apply_url, description, score?, status? }` — every produced object must match this exactly.

---

### Task 1: Config loader + job-parsing pure functions

**Files:**
- Create: `config/discover-linkedin.json`
- Create: `src/discover/linkedin-jobs.ts`
- Test: `tests/discover-linkedin-jobs.test.ts`

**Interfaces:**
- Produces: `DiscoverLinkedInConfig` type, `loadDiscoverConfig(): DiscoverLinkedInConfig`, `RawJobCard` type, `ParseResult` type, `extractLinkedInJobId(href: string): string | null`, `parseLinkedInJobCards(rawCards: RawJobCard[]): ParseResult` — all exported from `src/discover/linkedin-jobs.ts`. Task 2 adds `fetchLinkedInJobs` to this same file.

- [ ] **Step 1: Create the config template**

```json
{
  "jobs": {
    "search_url": "REPLACE_WITH_YOUR_LINKEDIN_JOBS_SEARCH_URL",
    "limit": 25
  },
  "posts": {
    "role": "full stack developer / react",
    "geo": "in",
    "limit": 25
  }
}
```

Save as `config/discover-linkedin.json`. `search_url` is a placeholder — the user builds their own filtered LinkedIn Jobs search in a browser (any date-posted/remote/experience-level filters they want) and pastes the resulting URL in before first real use. This is user-provided data, not a plan placeholder — `discover.linkedin_jobs()` will fail loudly (see Task 2) if it's never replaced.

- [ ] **Step 2: Write the failing tests for config loading and job-ID extraction**

Create `tests/discover-linkedin-jobs.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  loadDiscoverConfig,
  extractLinkedInJobId,
  parseLinkedInJobCards,
  type RawJobCard,
} from '../src/discover/linkedin-jobs.js';

describe('loadDiscoverConfig', () => {
  it('reads jobs and posts config from config/discover-linkedin.json', () => {
    const config = loadDiscoverConfig();
    expect(typeof config.jobs.search_url).toBe('string');
    expect(typeof config.jobs.limit).toBe('number');
    expect(typeof config.posts.role).toBe('string');
    expect(typeof config.posts.geo).toBe('string');
    expect(typeof config.posts.limit).toBe('number');
  });
});

describe('extractLinkedInJobId', () => {
  it('extracts the numeric job id from a standard job view URL', () => {
    expect(extractLinkedInJobId('https://www.linkedin.com/jobs/view/3891234567/')).toBe('3891234567');
  });

  it('extracts the id when the URL has query params after it', () => {
    expect(
      extractLinkedInJobId('https://www.linkedin.com/jobs/view/3891234567/?refId=abc&trackingId=xyz')
    ).toBe('3891234567');
  });

  it('returns null for a URL with no job id', () => {
    expect(extractLinkedInJobId('https://www.linkedin.com/jobs/search/?keywords=react')).toBeNull();
  });
});

describe('parseLinkedInJobCards', () => {
  it('parses well-formed cards into Job objects', () => {
    const rawCards: RawJobCard[] = [
      {
        titleText: '  Senior React Developer  ',
        companyText: '  Acme Corp  ',
        hrefRaw: 'https://www.linkedin.com/jobs/view/1111111111/',
        snippetText: '  Remote, India  ',
        easyApply: true,
      },
      {
        titleText: 'Full Stack Engineer',
        companyText: 'Widgets Inc',
        hrefRaw: 'https://www.linkedin.com/jobs/view/2222222222/?refId=x',
        snippetText: 'Bengaluru, India',
        easyApply: false,
      },
    ];

    const result = parseLinkedInJobCards(rawCards);

    expect(result.found).toBe(2);
    expect(result.parsed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.jobs).toEqual([
      {
        id: 'li-job:1111111111',
        source: 'linkedin-jobs',
        title: 'Senior React Developer',
        company: 'Acme Corp',
        url: 'https://www.linkedin.com/jobs/view/1111111111/',
        apply_url: 'https://www.linkedin.com/jobs/view/1111111111/',
        description: 'Remote, India',
      },
      {
        id: 'li-job:2222222222',
        source: 'linkedin-jobs',
        title: 'Full Stack Engineer',
        company: 'Widgets Inc',
        url: 'https://www.linkedin.com/jobs/view/2222222222/?refId=x',
        apply_url: 'https://www.linkedin.com/jobs/view/2222222222/?refId=x',
        description: 'Bengaluru, India',
      },
    ]);
  });

  it('skips a card with no title without failing the rest of the page', () => {
    const rawCards: RawJobCard[] = [
      { titleText: null, companyText: 'Acme', hrefRaw: 'https://www.linkedin.com/jobs/view/111/', snippetText: null, easyApply: false },
      { titleText: 'Good Job', companyText: 'Acme', hrefRaw: 'https://www.linkedin.com/jobs/view/222/', snippetText: null, easyApply: false },
    ];

    const result = parseLinkedInJobCards(rawCards);

    expect(result.found).toBe(2);
    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe('li-job:222');
  });

  it('skips a card whose href has no extractable job id', () => {
    const rawCards: RawJobCard[] = [
      { titleText: 'Mystery Job', companyText: 'Acme', hrefRaw: 'https://www.linkedin.com/jobs/search/?keywords=x', snippetText: null, easyApply: false },
    ];

    const result = parseLinkedInJobCards(rawCards);

    expect(result.parsed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.jobs).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/discover-linkedin-jobs.test.ts`
Expected: FAIL — `src/discover/linkedin-jobs.ts` does not exist yet.

- [ ] **Step 4: Implement the config loader and pure parsing functions**

Create `src/discover/linkedin-jobs.ts`:

```typescript
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const CONFIG_PATH = path.join(projectRoot, 'config', 'discover-linkedin.json');

export interface DiscoverLinkedInConfig {
  jobs: { search_url: string; limit: number };
  posts: { role: string; geo: string; limit: number };
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/discover-linkedin-jobs.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add config/discover-linkedin.json src/discover/linkedin-jobs.ts tests/discover-linkedin-jobs.test.ts
git commit -m "feat: add discover-linkedin config and job-card parsing"
```

---

### Task 2: `fetchLinkedInJobs` — the Playwright scrape + dedup

**Files:**
- Modify: `src/discover/linkedin-jobs.ts` (append to the file from Task 1)
- Modify: `tests/discover-linkedin-jobs.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 1 (`loadDiscoverConfig`, `RawJobCard`, `parseLinkedInJobCards`), plus `openDb`, `isSeen`, `saveJob` from `src/db.js` (existing, exact signatures: `openDb(path?: string): Database`, `isSeen(db, id: string): boolean`, `saveJob(db, job: Job): void`).
- Produces: `LinkedInJobsDeps` type, `fetchLinkedInJobs(deps?: LinkedInJobsDeps): Promise<Job[]>` — this is what Task 5's MCP tool calls directly.

- [ ] **Step 1: Write the failing tests for the scrape function**

Append to `tests/discover-linkedin-jobs.test.ts`:

```typescript
import { vi } from 'vitest';
import { fetchLinkedInJobs } from '../src/discover/linkedin-jobs.js';
import { openDb, isSeen } from '../src/db.js';

function makeFakePage(rawCards: RawJobCard[]) {
  const locator = {
    evaluateAll: vi.fn().mockResolvedValue(rawCards),
  };
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue(locator),
  };
}

describe('fetchLinkedInJobs', () => {
  it('scrapes cards, dedups against the db, and returns only new jobs', async () => {
    const db = openDb(':memory:');
    const rawCards: RawJobCard[] = [
      { titleText: 'New Job', companyText: 'Acme', hrefRaw: 'https://www.linkedin.com/jobs/view/999999999/', snippetText: 'Remote', easyApply: true },
    ];
    const page = makeFakePage(rawCards);
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchLinkedInJobs({ chromium: chromiumStub, db });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('li-job:999999999');
    expect(isSeen(db, 'li-job:999999999')).toBe(true);
    expect(browser.close).toHaveBeenCalled();
  });

  it('excludes a job already marked seen in the db', async () => {
    const db = openDb(':memory:');
    const { saveJob } = await import('../src/db.js');
    saveJob(db, {
      id: 'li-job:888888888',
      source: 'linkedin-jobs',
      title: 'Already Seen',
      company: 'Acme',
      url: 'https://www.linkedin.com/jobs/view/888888888/',
      apply_url: 'https://www.linkedin.com/jobs/view/888888888/',
      description: '',
    });
    const rawCards: RawJobCard[] = [
      { titleText: 'Already Seen', companyText: 'Acme', hrefRaw: 'https://www.linkedin.com/jobs/view/888888888/', snippetText: null, easyApply: false },
    ];
    const page = makeFakePage(rawCards);
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchLinkedInJobs({ chromium: chromiumStub, db });

    expect(jobs).toHaveLength(0);
  });

  it('caps results at config.jobs.limit before parsing', async () => {
    const db = openDb(':memory:');
    const rawCards: RawJobCard[] = Array.from({ length: 30 }, (_, i) => ({
      titleText: `Job ${i}`,
      companyText: 'Acme',
      hrefRaw: `https://www.linkedin.com/jobs/view/${1000000 + i}/`,
      snippetText: null,
      easyApply: false,
    }));
    const page = makeFakePage(rawCards);
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchLinkedInJobs({ chromium: chromiumStub, db, configOverride: { jobs: { search_url: 'https://example.com', limit: 5 }, posts: { role: 'x', geo: 'in', limit: 5 } } });

    expect(jobs).toHaveLength(5);
  });

  it('returns an empty array (not a throw) if the page fails to load', async () => {
    const db = openDb(':memory:');
    const page = {
      goto: vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_RESET')),
      waitForSelector: vi.fn(),
      locator: vi.fn(),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchLinkedInJobs({ chromium: chromiumStub, db });

    expect(jobs).toEqual([]);
    expect(browser.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/discover-linkedin-jobs.test.ts`
Expected: FAIL — `fetchLinkedInJobs` is not exported, `LinkedInJobsDeps` doesn't accept `db`/`configOverride`.

- [ ] **Step 3: Implement `fetchLinkedInJobs`**

Append to `src/discover/linkedin-jobs.ts`:

```typescript
import { chromium, type Browser } from 'playwright';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb, isSeen, saveJob } from '../db.js';

const BURNER_STATE_PATH = path.join(projectRoot, 'secrets', 'linkedin-burner-state.json');

export interface LinkedInJobsDeps {
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
  /** Injectable db handle, for testing without touching data.sqlite. */
  db?: BetterSqlite3.Database;
  /** Injectable config, for testing without touching config/discover-linkedin.json. */
  configOverride?: DiscoverLinkedInConfig;
}

const JOB_CARD_SELECTOR = '.job-card-container, .jobs-search-results__list-item';

export async function fetchLinkedInJobs(deps: LinkedInJobsDeps = {}): Promise<Job[]> {
  const config = deps.configOverride ?? loadDiscoverConfig();
  const db = deps.db ?? openDb('data.sqlite');
  const browserLauncher = deps.chromium ?? chromium;

  let browser: Browser | undefined;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: BURNER_STATE_PATH });
    const page = await context.newPage();
    await page.goto(config.jobs.search_url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(JOB_CARD_SELECTOR, { timeout: 15000 });

    const rawCards: RawJobCard[] = await page.locator(JOB_CARD_SELECTOR).evaluateAll((nodes: Element[]) =>
      nodes.map((n) => {
        const titleEl = n.querySelector('a.job-card-list__title, .job-card-container__link') as HTMLAnchorElement | null;
        const companyEl = n.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle');
        const snippetEl = n.querySelector('.job-card-list__insight, .job-card-container__metadata-wrapper');
        return {
          titleText: titleEl?.textContent ?? null,
          companyText: companyEl?.textContent ?? null,
          hrefRaw: titleEl?.href ?? null,
          snippetText: snippetEl?.textContent ?? null,
          easyApply: !!n.querySelector('[aria-label*="Easy Apply" i]'),
        };
      })
    );

    const capped = rawCards.slice(0, config.jobs.limit);
    const { jobs, found, parsed, skipped } = parseLinkedInJobCards(capped);
    console.error(`[discover] linkedin_jobs: ${parsed}/${found} parsed, ${skipped} skipped (malformed)`);

    const newJobs = jobs.filter((job) => !isSeen(db, job.id));
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
```

Note: move the `import { chromium, ... } from 'playwright'` and `import type BetterSqlite3 ...` lines to the top of the file alongside the Task 1 imports rather than leaving them mid-file — this snippet shows what's new, but when writing the file keep all imports together at the top.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/discover-linkedin-jobs.test.ts`
Expected: PASS (11 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/discover/linkedin-jobs.ts tests/discover-linkedin-jobs.test.ts
git commit -m "feat: implement fetchLinkedInJobs scrape with dedup and graceful failure"
```

---

### Task 3: Hiring-post pure functions (URN extraction, keyword filter, parsing)

**Files:**
- Create: `src/discover/linkedin-posts.ts`
- Create: `tests/discover-linkedin-posts.test.ts`

**Interfaces:**
- Consumes: `loadDiscoverConfig`, `DiscoverLinkedInConfig` from `../discover/linkedin-jobs.js` (Task 1 — reused, not redefined).
- Produces: `RawPostCard` type, `extractActivityUrn(href: string): string | null`, `isHiringIntent(text: string): boolean`, `parseLinkedInPostCards(rawCards: RawPostCard[]): ParseResult` (same `ParseResult` shape as Task 1, re-exported or redefined identically), `buildLinkedInPostSearchUrl(role: string, geo: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `tests/discover-linkedin-posts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  extractActivityUrn,
  isHiringIntent,
  parseLinkedInPostCards,
  buildLinkedInPostSearchUrl,
  type RawPostCard,
} from '../src/discover/linkedin-posts.js';

describe('extractActivityUrn', () => {
  it('extracts the activity id from a permalink href', () => {
    expect(
      extractActivityUrn('https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/')
    ).toBe('7123456789012345678');
  });

  it('returns null when there is no activity urn', () => {
    expect(extractActivityUrn('https://www.linkedin.com/in/someone/')).toBeNull();
  });
});

describe('isHiringIntent', () => {
  it('matches common hiring phrasing', () => {
    expect(isHiringIntent("We're hiring a Senior React Developer!")).toBe(true);
    expect(isHiringIntent('Join our team as a Backend Engineer')).toBe(true);
    expect(isHiringIntent('Looking for a Full Stack Developer')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(isHiringIntent('Excited to share my new certification!')).toBe(false);
  });
});

describe('buildLinkedInPostSearchUrl', () => {
  it('builds a content-search URL with role keywords, sorted by latest', () => {
    const url = buildLinkedInPostSearchUrl('full stack developer', 'in');
    expect(url).toContain('linkedin.com/search/results/content/');
    expect(url).toContain('full+stack+developer');
    expect(decodeURIComponent(url)).toContain('date_posted');
  });
});

describe('parseLinkedInPostCards', () => {
  it('parses a hiring-intent card into a Job', () => {
    const rawCards: RawPostCard[] = [
      {
        textContent: "We're hiring a Senior React Developer, remote, India.",
        hrefRaw: 'https://www.linkedin.com/feed/update/urn:li:activity:1111111111111111111/',
        authorText: 'Jane Recruiter',
      },
    ];

    const result = parseLinkedInPostCards(rawCards);

    expect(result.found).toBe(1);
    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.jobs).toEqual([
      {
        id: 'li-post:1111111111111111111',
        source: 'linkedin-posts',
        title: 'Jane Recruiter',
        company: '',
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:1111111111111111111/',
        apply_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1111111111111111111/',
        description: "We're hiring a Senior React Developer, remote, India.",
      },
    ]);
  });

  it('silently excludes a non-hiring post without counting it as skipped', () => {
    const rawCards: RawPostCard[] = [
      {
        textContent: 'Just got a new certification, excited!',
        hrefRaw: 'https://www.linkedin.com/feed/update/urn:li:activity:2222222222222222222/',
        authorText: 'Someone',
      },
    ];

    const result = parseLinkedInPostCards(rawCards);

    expect(result.found).toBe(1);
    expect(result.parsed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.jobs).toHaveLength(0);
  });

  it('skips a malformed card (no href) without failing the rest of the page', () => {
    const rawCards: RawPostCard[] = [
      { textContent: "We're hiring!", hrefRaw: null, authorText: 'Someone' },
      {
        textContent: "We're hiring a Backend Engineer",
        hrefRaw: 'https://www.linkedin.com/feed/update/urn:li:activity:3333333333333333333/',
        authorText: 'Other Recruiter',
      },
    ];

    const result = parseLinkedInPostCards(rawCards);

    expect(result.found).toBe(2);
    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe('li-post:3333333333333333333');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/discover-linkedin-posts.test.ts`
Expected: FAIL — `src/discover/linkedin-posts.ts` does not exist yet.

- [ ] **Step 3: Implement the pure functions**

Create `src/discover/linkedin-posts.ts`:

```typescript
import type { Job } from '../db.js';
import { loadDiscoverConfig, type DiscoverLinkedInConfig, type ParseResult } from './linkedin-jobs.js';

export { loadDiscoverConfig };
export type { DiscoverLinkedInConfig, ParseResult };

export interface RawPostCard {
  textContent: string | null;
  hrefRaw: string | null;
  authorText: string | null;
}

export function extractActivityUrn(href: string): string | null {
  const match = href.match(/urn:li:activity:(\d+)/);
  return match ? match[1] : null;
}

const HIRING_KEYWORDS = /\b(hiring|we're hiring|we are hiring|join our team|open position|looking for)\b/i;

export function isHiringIntent(text: string): boolean {
  return HIRING_KEYWORDS.test(text);
}

export function buildLinkedInPostSearchUrl(role: string, geo: string): string {
  const keywords = `(hiring OR "we're hiring" OR "we are hiring" OR "join our team") (${role})`;
  const params = new URLSearchParams({
    keywords,
    origin: 'GLOBAL_SEARCH_HEADER',
    sortBy: '"date_posted"',
  });
  void geo; // geo is not part of LinkedIn's content-search URL today; kept as a param for parity with fetchLinkedInPosts and future use
  return `https://www.linkedin.com/search/results/content/?${params.toString()}`;
}

export function parseLinkedInPostCards(rawCards: RawPostCard[]): ParseResult {
  let parsed = 0;
  let skipped = 0;
  const jobs: Job[] = [];

  for (const card of rawCards) {
    try {
      if (!card.textContent || !card.hrefRaw) {
        throw new Error('missing text or href');
      }
      const urn = extractActivityUrn(card.hrefRaw);
      if (!urn) {
        throw new Error('could not extract activity urn from href');
      }
      if (!isHiringIntent(card.textContent)) {
        continue; // not malformed, just not a hiring post — silently excluded, not counted as skipped
      }
      jobs.push({
        id: `li-post:${urn}`,
        source: 'linkedin-posts',
        title: (card.authorText ?? 'LinkedIn hiring post').trim(),
        company: '',
        url: card.hrefRaw,
        apply_url: card.hrefRaw,
        description: card.textContent.trim(),
      });
      parsed++;
    } catch (err) {
      skipped++;
      console.error(
        '[discover] linkedin_posts: skipped malformed card:',
        err instanceof Error ? err.message : err
      );
    }
  }

  return { jobs, found: rawCards.length, parsed, skipped };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/discover-linkedin-posts.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/discover/linkedin-posts.ts tests/discover-linkedin-posts.test.ts
git commit -m "feat: add hiring-post URN extraction, keyword filter, and card parsing"
```

---

### Task 4: `fetchLinkedInPosts` — the Playwright scrape + dedup

**Files:**
- Modify: `src/discover/linkedin-posts.ts` (append)
- Modify: `tests/discover-linkedin-posts.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 3, plus `openDb`, `isSeen`, `saveJob` from `../db.js` (same as Task 2).
- Produces: `LinkedInPostsDeps` type, `fetchLinkedInPosts(params: { role?: string; geo?: string }, deps?: LinkedInPostsDeps): Promise<Job[]>` — this is what Task 5's MCP tool calls directly.

- [ ] **Step 1: Write the failing tests**

Append to `tests/discover-linkedin-posts.test.ts`:

```typescript
import { vi } from 'vitest';
import { fetchLinkedInPosts } from '../src/discover/linkedin-posts.js';
import { openDb, isSeen } from '../src/db.js';

function makeFakePostPage(rawCards: RawPostCard[]) {
  const locator = {
    evaluateAll: vi.fn().mockResolvedValue(rawCards),
  };
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue(locator),
  };
}

describe('fetchLinkedInPosts', () => {
  it('scrapes hiring-post cards, dedups against the db, and returns only new ones', async () => {
    const db = openDb(':memory:');
    const rawCards: RawPostCard[] = [
      {
        textContent: "We're hiring a Backend Engineer",
        hrefRaw: 'https://www.linkedin.com/feed/update/urn:li:activity:4444444444444444444/',
        authorText: 'Recruiter A',
      },
    ];
    const page = makeFakePostPage(rawCards);
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchLinkedInPosts({ role: 'backend engineer', geo: 'in' }, { chromium: chromiumStub, db });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('li-post:4444444444444444444');
    expect(isSeen(db, 'li-post:4444444444444444444')).toBe(true);
  });

  it('falls back to config.posts.role/geo when params are omitted', async () => {
    const db = openDb(':memory:');
    const page = makeFakePostPage([]);
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };
    const configOverride = { jobs: { search_url: 'https://example.com', limit: 5 }, posts: { role: 'devops engineer', geo: 'in', limit: 5 } };

    await fetchLinkedInPosts({}, { chromium: chromiumStub, db, configOverride });

    expect(page.goto).toHaveBeenCalledWith(expect.stringContaining('devops+engineer'), expect.anything());
  });

  it('returns an empty array (not a throw) if the page fails to load', async () => {
    const db = openDb(':memory:');
    const page = {
      goto: vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_RESET')),
      waitForSelector: vi.fn(),
      locator: vi.fn(),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchLinkedInPosts({}, { chromium: chromiumStub, db });

    expect(jobs).toEqual([]);
    expect(browser.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/discover-linkedin-posts.test.ts`
Expected: FAIL — `fetchLinkedInPosts` is not exported.

- [ ] **Step 3: Implement `fetchLinkedInPosts`**

Append to `src/discover/linkedin-posts.ts` (add these imports to the top of the file alongside the existing ones):

```typescript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb, isSeen, saveJob } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const BURNER_STATE_PATH = path.join(projectRoot, 'secrets', 'linkedin-burner-state.json');

export interface LinkedInPostsDeps {
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
  /** Injectable db handle, for testing without touching data.sqlite. */
  db?: BetterSqlite3.Database;
  /** Injectable config, for testing without touching config/discover-linkedin.json. */
  configOverride?: DiscoverLinkedInConfig;
}

const POST_CARD_SELECTOR = '.feed-shared-update-v2, .reusable-search__result-container';

export async function fetchLinkedInPosts(
  params: { role?: string; geo?: string },
  deps: LinkedInPostsDeps = {}
): Promise<Job[]> {
  const config = deps.configOverride ?? loadDiscoverConfig();
  const role = params.role ?? config.posts.role;
  const geo = params.geo ?? config.posts.geo;
  const db = deps.db ?? openDb('data.sqlite');
  const browserLauncher = deps.chromium ?? chromium;

  let browser: Browser | undefined;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: BURNER_STATE_PATH });
    const page = await context.newPage();
    const searchUrl = buildLinkedInPostSearchUrl(role, geo);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(POST_CARD_SELECTOR, { timeout: 15000 });

    const rawCards: RawPostCard[] = await page.locator(POST_CARD_SELECTOR).evaluateAll((nodes: Element[]) =>
      nodes.map((n) => {
        const textEl = n.querySelector('.feed-shared-update-v2__description, .update-components-text');
        const linkEl = n.querySelector('a[href*="urn:li:activity"]') as HTMLAnchorElement | null;
        const authorEl = n.querySelector('.update-components-actor__name, .entity-result__title-text');
        return {
          textContent: textEl?.textContent ?? null,
          hrefRaw: linkEl?.href ?? null,
          authorText: authorEl?.textContent ?? null,
        };
      })
    );

    const capped = rawCards.slice(0, config.posts.limit);
    const { jobs, found, parsed, skipped } = parseLinkedInPostCards(capped);
    console.error(`[discover] linkedin_posts: ${parsed}/${found} parsed, ${skipped} skipped (malformed)`);

    const newJobs = jobs.filter((job) => !isSeen(db, job.id));
    for (const job of newJobs) {
      saveJob(db, job);
    }
    return newJobs;
  } catch (err) {
    console.error('[discover] linkedin_posts: fetch failed:', err instanceof Error ? err.message : err);
    return [];
  } finally {
    await browser?.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/discover-linkedin-posts.test.ts`
Expected: PASS (11 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/discover/linkedin-posts.ts tests/discover-linkedin-posts.test.ts
git commit -m "feat: implement fetchLinkedInPosts scrape with dedup and graceful failure"
```

---

### Task 5: `discover` MCP server + registration

**Files:**
- Create: `src/mcp/discover.ts`
- Modify: `.mcp.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `fetchLinkedInJobs` from `../discover/linkedin-jobs.js` (Task 2), `fetchLinkedInPosts` from `../discover/linkedin-posts.js` (Task 4).
- Produces: two MCP tools, `discover.linkedin_jobs` and `discover.linkedin_posts`, callable by name once `.mcp.json` registers the server (this is what Task 6's `discoverer` subagent update depends on).

- [ ] **Step 1: Create the MCP server**

Create `src/mcp/discover.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetchLinkedInJobs } from '../discover/linkedin-jobs.js';
import { fetchLinkedInPosts } from '../discover/linkedin-posts.js';

const server = new McpServer({ name: 'discover', version: '0.1.0' });

server.registerTool(
  'linkedin_jobs',
  {
    description:
      'Scrape LinkedIn job search results (from the URL configured in config/discover-linkedin.json) for new postings not seen before. Burner account only.',
    inputSchema: {},
  },
  async () => {
    const jobs = await fetchLinkedInJobs();
    return { content: [{ type: 'text', text: JSON.stringify(jobs) }] };
  }
);

server.registerTool(
  'linkedin_posts',
  {
    description:
      'Scrape LinkedIn content search for hiring-intent posts not seen before. Burner account only.',
    inputSchema: {
      role: z.string().optional(),
      geo: z.string().optional(),
    },
  },
  async ({ role, geo }) => {
    const jobs = await fetchLinkedInPosts({ role, geo });
    return { content: [{ type: 'text', text: JSON.stringify(jobs) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[discover] fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Register the server in `.mcp.json`**

Modify `.mcp.json` to add the `discover` entry (keep every existing entry unchanged):

```json
{
  "mcpServers": {
    "job-fetch": { "command": "npx", "args": ["tsx", "src/mcp/job-fetch.ts"] },
    "resume": { "command": "npx", "args": ["tsx", "src/mcp/resume.ts"] },
    "contacts": { "command": "npx", "args": ["tsx", "src/mcp/contacts.ts"] },
    "sqlite": { "command": "npx", "args": ["tsx", "src/mcp/sqlite.ts"] },
    "gmail": { "command": "npx", "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"] },
    "apply": { "command": "npx", "args": ["tsx", "src/mcp/apply.ts"] },
    "connect": { "command": "npx", "args": ["tsx", "src/mcp/connect.ts"] },
    "discover": { "command": "npx", "args": ["tsx", "src/mcp/discover.ts"] }
  }
}
```

- [ ] **Step 3: Add the `mcp:discover` script to `package.json`**

Modify the `"scripts"` block in `package.json` to add one line after `"mcp:connect"`:

```json
    "mcp:connect": "tsx src/mcp/connect.ts",
    "mcp:discover": "tsx src/mcp/discover.ts"
```

- [ ] **Step 4: Verify the server starts and lists both tools**

Run: `npx tsc -p . --noEmit`
Expected: no new type errors (only the pre-existing known `linkedin-apply.ts` errors, if any — check against the baseline before this task).

Run: `timeout 5 npx tsx src/mcp/discover.ts <<< '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
Expected: the process starts without throwing (it will hang waiting for more stdio input after the one line, which is expected for a stdio MCP server — the `timeout 5` just prevents the terminal from hanging; a clean start with no immediate stack trace is the pass condition here, not a parsed response).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/discover.ts .mcp.json package.json
git commit -m "feat: add discover MCP server exposing linkedin_jobs and linkedin_posts"
```

---

### Task 6: Pipeline integration — `discoverer` subagent + `CLAUDE.md`

**Files:**
- Modify: `.claude/agents/discoverer.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the two tools registered in Task 5 (`mcp__discover__linkedin_jobs`, `mcp__discover__linkedin_posts`) plus the existing `mcp__job-fetch__list_new_jobs`.
- Produces: no new code interfaces — this task only changes what tools the `discoverer` subagent is allowed to call and what `CLAUDE.md` documents about discovery, per spec §10.

- [ ] **Step 1: Update the `discoverer` subagent's tool allowlist and instructions**

Replace the full contents of `.claude/agents/discoverer.md`:

```markdown
---
name: discoverer
description: Fetches new, unseen job postings for the given role/location. Use as the first stage of every hunt run.
tools: mcp__job-fetch__list_new_jobs, mcp__discover__linkedin_jobs, mcp__discover__linkedin_posts
---

You are the discovery stage of the Jobber pipeline. You have exactly one job: call all
three discovery tools and return the combined, unmodified list of Job objects.

## Steps

1. Call `list_new_jobs({role, location})` using the exact `role` and `location` values passed to
   you in the prompt. This covers Adzuna, Remotive, RemoteOK, and the Serper Google-dork hiring
   post search.
2. Call `linkedin_jobs()` — no parameters. This scrapes LinkedIn's own job search results
   (using the search URL configured in `config/discover-linkedin.json`).
3. Call `linkedin_posts({role, geo})` using the `role` value passed to you, and pass `location`
   as `geo`. This scrapes LinkedIn's content search for hiring-intent posts.
4. Concatenate the three arrays into one JSON array and return it — do not summarize, filter,
   deduplicate, or editorialize. The caller (the orchestrating session) needs the full,
   unmodified combined list of Job objects `{id, source, title, company, url, apply_url,
   description}`. Cross-source duplicates are expected and tolerated (each source uses a
   distinct ID prefix), not something you need to reconcile.
5. If any single tool call errors, log it and continue with the other two — return
   `{"error": "<message>"}` only if ALL THREE calls fail. A failure in one discovery source
   should not block the others.

Do not call any other tool. Do not attempt to match, score, contact, or draft anything — that is
handled by later stages.
```

- [ ] **Step 2: Update `CLAUDE.md`'s "Running the hunt" step 1**

Read the current step 1 text in `CLAUDE.md` (the "Discover" bullet under `## Running the hunt (subagent-per-stage)`), and replace it with:

```markdown
1. **Discover** — dispatch `subagent_type: discoverer` with the Role and Location from
   Preferences. It calls `job-fetch.list_new_jobs` (Adzuna/Remotive/RemoteOK/Serper) plus
   `discover.linkedin_jobs` and `discover.linkedin_posts` (LinkedIn job search + hiring-post
   search, burner account, see `docs/superpowers/specs/2026-07-17-linkedin-discovery-design.md`),
   and returns the combined JSON array of new Job objects. If empty, skip to step 6 and report
   zero new jobs.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/discoverer.md CLAUDE.md
git commit -m "docs: wire LinkedIn discovery into the discoverer subagent and hunt pipeline"
```

---

### Task 7: Full test suite + typecheck verification

**Files:** none (verification-only task)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass, including the new `tests/discover-linkedin-jobs.test.ts` (11 tests) and `tests/discover-linkedin-posts.test.ts` (11 tests) alongside every pre-existing test file.

- [ ] **Step 2: Run the typechecker**

Run: `npx tsc -p . --noEmit`
Expected: no new errors compared to the pre-Task-1 baseline (record that baseline before starting Task 1 if it isn't already known — this project has previously documented pre-existing known errors in `linkedin-apply.ts`; confirm the count hasn't grown).

- [ ] **Step 3: Note the deferred live-verification gap**

No code change — this is a documentation note only, since neither this plan nor the spec includes a live scrape against real LinkedIn pages (matching the project's existing precedent of documenting, not silently ignoring, an untested-live gap — see `external-apply.ts`'s equivalent caveat in `CLAUDE.md`). Add one line to `CLAUDE.md` immediately after the step 1 text edited in Task 6:

```markdown
   Neither `discover.linkedin_jobs` nor `discover.linkedin_posts` has been live-tested against
   real LinkedIn search results yet — selectors were written from the design spec, not verified
   live. The first real hunt run after this lands should be watched closely (check the
   `[discover]` console logs for parsed/skipped counts) before trusting it unattended.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: flag LinkedIn discovery selectors as not yet live-verified"
```

---

## Self-Review

**Spec coverage:**
- §5 config shape → Task 1 Step 1. ✓
- §6 `discover.linkedin_jobs()` steps 1-7 → Task 1 (parsing) + Task 2 (scrape/dedup). ✓
- §6 `discover.linkedin_posts({role, geo})` steps 1-7 → Task 3 (parsing) + Task 4 (scrape/dedup). ✓
- §7 uniqueness/dedup (`li-job:`, `li-post:` prefixes, `isSeen`/`saveJob` reuse) → Tasks 1-4. ✓
- §8 partial scraping tolerance (per-card try/catch, skip+count+log) → Tasks 1 & 3 parsing functions, verified by dedicated tests in both. ✓
- §9 auth/safety (burner-only path, no daily rate limit) → Tasks 2 & 4 (`BURNER_STATE_PATH` hardcoded, no rate-limit import). ✓
- §10 pipeline integration (`discoverer` subagent, `CLAUDE.md` step 1) → Task 6. ✓
- §11 testing (pure-function fixture tests, no live hits) → Tasks 1, 2, 3, 4 test steps; Task 7 confirms full-suite pass. ✓
- §12 explicitly deferred items (Naukri/X.com, full description fetch, daily cap) → not implemented here, correctly out of scope; no task references them as if in scope.

**Placeholder scan:** the only literal placeholder is `config/discover-linkedin.json`'s `search_url` value, which is intentional user-provided data (documented as such in Task 1 Step 1), not a plan gap. No `TBD`/`TODO`/"implement later" language anywhere else in the plan.

**Type consistency:** `ParseResult`, `RawJobCard`, `RawPostCard`, `DiscoverLinkedInConfig`, `LinkedInJobsDeps`, `LinkedInPostsDeps` are each defined exactly once (Tasks 1 and 3) and referenced identically (same names, same shapes) in every later task that uses them. `fetchLinkedInJobs`/`fetchLinkedInPosts` signatures declared in Task 2/4 match exactly what Task 5's MCP tool handlers call.
