# Naukri.com Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Naukri.com as a new job-discovery source feeding the existing `Job` pipeline, and
resolve each job's real employer-ATS apply URL (following Naukri's "Apply on company site" button)
so the existing `apply.auto` pipeline can handle it with zero Naukri-specific apply code.

**Architecture:** One new source module, `src/sources/naukri.ts`, registered in
`src/sources/index.ts` alongside Adzuna/Remotive/RemoteOK. Two Playwright phases inside one browser
launch: an unauthenticated search-results scrape, then (if a saved session exists) an authenticated
pass per newly-discovered job to resolve its real apply URL via the "Apply on company site" button.

**Tech Stack:** TypeScript, Playwright, vitest, `better-sqlite3` (via the existing `src/db.ts`
helpers).

## Global Constraints

- Both Playwright launches MUST use `headless: false` — Naukri sits behind Akamai Bot Manager,
  which blocks headless Chromium with a hard "Access Denied" edge response
  (`errors.edgesuite.net`), confirmed live against the search page, a job-listing page, and an
  authenticated session (spec §Findings). This needs a virtual display (e.g. Xvfb) wherever this
  runs without a physical display — an operational/deployment concern, not something this plan's
  code configures.
- No nested named function declarations inside any `page.evaluate`/`evaluateAll` callback — tsx/
  esbuild wraps those in a `__name(...)` helper that doesn't exist in Playwright's isolated browser
  evaluation context, causing a live-only `ReferenceError` no unit test can catch (discovered and
  fixed in the ATS-bootstrap work; every callback in this plan inlines its logic instead).
- No new MCP tool, no new config file — Naukri is a `src/sources/` module like Adzuna/Remotive/
  RemoteOK, taking `{role, location}` params from the existing `fetchAllJobs` call, not a
  standalone tool with its own config surface (spec §Out of Scope).
- `resolveApplyUrl` must only ever navigate (click "Apply on company site" and read the resulting
  tab's URL) — never click anything else on the page. It is explicitly NOT a submission action.
- Pure functions get real unit tests; the Playwright-orchestration function
  (`fetchNaukriJobs`)  gets unit tests via injected fakes (`chromium`/`db`/`sessionStatePath`
  dependency injection), mirroring `fetchLinkedInJobs`'s existing test convention in
  `tests/discover-linkedin-jobs.test.ts` — this is NOT the narrower "browser-touching code is
  untested" convention used for `domSnapshot.ts`'s thin wrapper; `fetchNaukriJobs` is a full
  orchestration function with real branching logic (dedup, apply_url resolution, graceful
  degradation) that deserves the same fake-injection test coverage `fetchLinkedInJobs` already has.

---

### Task 1: Pure URL/ID helpers

**Files:**
- Create: `src/sources/naukri.ts` (this task only adds `buildNaukriSearchUrl`/
  `extractNaukriJobId` — later tasks add to this same file)
- Test: `tests/sources-naukri.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function buildNaukriSearchUrl(role: string, location?: string): string`
  - `export function extractNaukriJobId(url: string): string | null`

  Task 2 consumes `extractNaukriJobId`. Task 3 consumes `buildNaukriSearchUrl`.

- [ ] **Step 1: Write the failing tests**

Create `tests/sources-naukri.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildNaukriSearchUrl, extractNaukriJobId } from '../src/sources/naukri.js';

describe('buildNaukriSearchUrl', () => {
  it('builds a URL with role and location slugified', () => {
    expect(buildNaukriSearchUrl('Full Stack Developer', 'India')).toBe(
      'https://www.naukri.com/full-stack-developer-jobs-in-india'
    );
  });

  it('omits the location segment when location is not given', () => {
    expect(buildNaukriSearchUrl('Full Stack Developer')).toBe(
      'https://www.naukri.com/full-stack-developer-jobs'
    );
  });

  it('slugifies special characters and multiple spaces', () => {
    expect(buildNaukriSearchUrl('React / Node.js Dev', 'Bengaluru (Bangalore)')).toBe(
      'https://www.naukri.com/react-node-js-dev-jobs-in-bengaluru-bangalore'
    );
  });
});

describe('extractNaukriJobId', () => {
  it('extracts the trailing numeric id from a real Naukri listing URL', () => {
    expect(
      extractNaukriJobId(
        'https://www.naukri.com/job-listings-full-stack-developer-i-fedex-express-hyderabad-2-to-5-years-1504265'
      )
    ).toBe('1504265');
  });

  it('strips a query string before extracting the id', () => {
    expect(extractNaukriJobId('https://www.naukri.com/job-listings-foo-12345?src=abc')).toBe('12345');
  });

  it('returns null when the URL has no trailing numeric segment', () => {
    expect(extractNaukriJobId('https://www.naukri.com/job-listings-foo-bar')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sources-naukri.test.ts`
Expected: FAIL — `Cannot find module '../src/sources/naukri.js'`

- [ ] **Step 3: Write the implementation**

Create `src/sources/naukri.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sources-naukri.test.ts`
Expected: PASS (6/6)

- [ ] **Step 5: Commit**

```bash
git add src/sources/naukri.ts tests/sources-naukri.test.ts
git commit -m "feat: add Naukri search-URL builder and job-id extractor"
```

---

### Task 2: Card parsing

**Files:**
- Modify: `src/sources/naukri.ts` (add to the file from Task 1)
- Modify: `tests/sources-naukri.test.ts` (add to the file from Task 1)

**Interfaces:**
- Consumes: `extractNaukriJobId` (Task 1), `Job` type from `../db.js` (existing).
- Produces:
  - `export interface RawNaukriCard { titleText: string | null; companyText: string | null; hrefRaw: string | null; descriptionText: string | null }`
  - `export interface NaukriParseResult { jobs: Job[]; found: number; parsed: number; skipped: number }`
  - `export function parseNaukriCards(rawCards: RawNaukriCard[]): NaukriParseResult`

  Task 3 consumes `RawNaukriCard` and `parseNaukriCards`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/sources-naukri.test.ts` (new imports + new describe block):

```typescript
import { describe, it, expect } from 'vitest';
import { buildNaukriSearchUrl, extractNaukriJobId, parseNaukriCards } from '../src/sources/naukri.js';
```

(replace the existing `import { buildNaukriSearchUrl, extractNaukriJobId } from '../src/sources/naukri.js';` line with the one above, adding `parseNaukriCards`)

```typescript
describe('parseNaukriCards', () => {
  it('parses a valid card into a Job with a naukri:<id> id', () => {
    const result = parseNaukriCards([
      {
        titleText: 'Full Stack Developer',
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-full-stack-developer-acme-12345',
        descriptionText: 'Build things',
      },
    ]);

    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.jobs).toEqual([
      {
        id: 'naukri:12345',
        source: 'naukri',
        title: 'Full Stack Developer',
        company: 'Acme',
        url: 'https://www.naukri.com/job-listings-full-stack-developer-acme-12345',
        apply_url: 'https://www.naukri.com/job-listings-full-stack-developer-acme-12345',
        description: 'Build things',
      },
    ]);
  });

  it('skips a card missing a title, without throwing', () => {
    const result = parseNaukriCards([
      {
        titleText: null,
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-foo-1',
        descriptionText: null,
      },
    ]);
    expect(result.parsed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.jobs).toEqual([]);
  });

  it('skips a card missing an href, without throwing', () => {
    const result = parseNaukriCards([
      { titleText: 'Foo', companyText: 'Acme', hrefRaw: null, descriptionText: null },
    ]);
    expect(result.skipped).toBe(1);
  });

  it('skips a card whose href has no extractable job id', () => {
    const result = parseNaukriCards([
      {
        titleText: 'Foo',
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-foo-bar',
        descriptionText: null,
      },
    ]);
    expect(result.skipped).toBe(1);
  });

  it('handles a missing company/description gracefully', () => {
    const result = parseNaukriCards([
      {
        titleText: 'Foo',
        companyText: null,
        hrefRaw: 'https://www.naukri.com/job-listings-foo-99',
        descriptionText: null,
      },
    ]);
    expect(result.jobs[0].company).toBe('');
    expect(result.jobs[0].description).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sources-naukri.test.ts`
Expected: FAIL — `parseNaukriCards is not exported` (or similar)

- [ ] **Step 3: Write the implementation**

Add to `src/sources/naukri.ts` (below the Task 1 functions):

```typescript
import type { Job } from '../db.js';

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
```

Note: move the `import type { Job } from '../db.js';` line to the top of the file with the other
imports (this is the file's first import — Task 1 had no imports).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sources-naukri.test.ts`
Expected: PASS (11/11)

- [ ] **Step 5: Commit**

```bash
git add src/sources/naukri.ts tests/sources-naukri.test.ts
git commit -m "feat: add Naukri job-card parsing"
```

---

### Task 3: Fetch orchestration + apply-URL resolution + wiring

**Files:**
- Modify: `src/sources/naukri.ts` (add to the file from Tasks 1-2)
- Modify: `src/sources/index.ts`
- Modify: `tests/sources-naukri.test.ts` (add to the file from Tasks 1-2)

**Interfaces:**
- Consumes: `buildNaukriSearchUrl`, `RawNaukriCard`, `parseNaukriCards` (Tasks 1-2); `openDb`,
  `isSeen`, `saveJob`, `Job` from `../db.js` (existing).
- Produces:
  - `export interface NaukriDeps { chromium?: { launch: typeof chromium.launch }; db?: BetterSqlite3.Database; sessionStatePath?: string }`
  - `export async function resolveApplyUrl(page: Pick<Page, 'locator'>, context: Pick<BrowserContext, 'waitForEvent'>): Promise<string | null>`
  - `export async function fetchNaukriJobs(params: { role: string; location?: string }, deps?: NaukriDeps): Promise<Job[]>`

  `src/sources/index.ts`'s `fetchAllJobs` consumes `fetchNaukriJobs`. This is the final task —
  nothing downstream depends on this task's own exports beyond that one wiring point.

- [ ] **Step 1: Write the failing tests**

Add to `tests/sources-naukri.test.ts` (new imports + new describe blocks):

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  buildNaukriSearchUrl,
  extractNaukriJobId,
  parseNaukriCards,
  fetchNaukriJobs,
  resolveApplyUrl,
} from '../src/sources/naukri.js';
import { openDb, isSeen, saveJob } from '../src/db.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
```

(replace the existing import block at the top of the file with the two blocks above, combined
into one set of imports — `vi` alongside `describe`/`it`/`expect`)

```typescript
function makeFakeSearchPage(rawCards: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({ evaluateAll: vi.fn().mockResolvedValue(rawCards) }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFakeApplyContext(companySiteButtonFound: boolean, resolvedUrl: string | null) {
  const newPageFake = {
    url: vi.fn().mockReturnValue(resolvedUrl),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const button = {
    count: vi.fn().mockResolvedValue(companySiteButtonFound ? 1 : 0),
    click: vi.fn().mockResolvedValue(undefined),
  };
  const jobPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({ first: vi.fn().mockReturnValue(button) }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    newPage: vi.fn().mockResolvedValue(jobPage),
    waitForEvent: companySiteButtonFound
      ? vi.fn().mockResolvedValue(newPageFake)
      : vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('fetchNaukriJobs', () => {
  it('scrapes cards, dedups against the db, and uses the listing URL as apply_url when no session file exists', async () => {
    const db = openDb(':memory:');
    const rawCards = [
      {
        titleText: 'Full Stack Developer',
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-full-stack-developer-acme-12345',
        descriptionText: 'Build things',
      },
    ];
    const searchPage = makeFakeSearchPage(rawCards);
    const searchContext = { newPage: vi.fn().mockResolvedValue(searchPage), close: vi.fn().mockResolvedValue(undefined) };
    const browser = { newContext: vi.fn().mockResolvedValue(searchContext), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchNaukriJobs(
      { role: 'Full Stack Developer', location: 'India' },
      { chromium: chromiumStub, db, sessionStatePath: '/nonexistent/naukri-state.json' }
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0].apply_url).toBe('https://www.naukri.com/job-listings-full-stack-developer-acme-12345');
    expect(isSeen(db, 'naukri:12345')).toBe(true);
    expect(browser.close).toHaveBeenCalled();
  });

  it('excludes a job already marked seen in the db', async () => {
    const db = openDb(':memory:');
    saveJob(db, {
      id: 'naukri:99999',
      source: 'naukri',
      title: 'Already Seen',
      company: 'Acme',
      url: 'https://www.naukri.com/job-listings-foo-99999',
      apply_url: 'https://www.naukri.com/job-listings-foo-99999',
      description: '',
    });
    const rawCards = [
      {
        titleText: 'Already Seen',
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-foo-99999',
        descriptionText: null,
      },
    ];
    const searchPage = makeFakeSearchPage(rawCards);
    const searchContext = { newPage: vi.fn().mockResolvedValue(searchPage), close: vi.fn().mockResolvedValue(undefined) };
    const browser = { newContext: vi.fn().mockResolvedValue(searchContext), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchNaukriJobs(
      { role: 'Full Stack Developer' },
      { chromium: chromiumStub, db, sessionStatePath: '/nonexistent/naukri-state.json' }
    );

    expect(jobs).toHaveLength(0);
  });

  it('returns [] (not a throw) if the search page fails to load', async () => {
    const db = openDb(':memory:');
    const searchPage = {
      goto: vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_RESET')),
      waitForSelector: vi.fn(),
      locator: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const searchContext = { newPage: vi.fn().mockResolvedValue(searchPage), close: vi.fn().mockResolvedValue(undefined) };
    const browser = { newContext: vi.fn().mockResolvedValue(searchContext), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchNaukriJobs(
      { role: 'Full Stack Developer' },
      { chromium: chromiumStub, db, sessionStatePath: '/nonexistent/naukri-state.json' }
    );

    expect(jobs).toEqual([]);
    expect(browser.close).toHaveBeenCalled();
  });

  it('resolves apply_url via the company-site button when a session file exists', async () => {
    const db = openDb(':memory:');
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'naukri-test-'));
    const sessionStatePath = path.join(tmpDir, 'naukri-state.json');
    writeFileSync(sessionStatePath, '{}');

    const rawCards = [
      {
        titleText: 'Full Stack Developer',
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-full-stack-developer-acme-55555',
        descriptionText: null,
      },
    ];
    const searchPage = makeFakeSearchPage(rawCards);
    const searchContext = { newPage: vi.fn().mockResolvedValue(searchPage), close: vi.fn().mockResolvedValue(undefined) };
    const applyContext = makeFakeApplyContext(true, 'https://acme.com/careers/apply/123');
    const browser = {
      newContext: vi.fn().mockResolvedValueOnce(searchContext).mockResolvedValueOnce(applyContext),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchNaukriJobs({ role: 'Full Stack Developer' }, { chromium: chromiumStub, db, sessionStatePath });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].apply_url).toBe('https://acme.com/careers/apply/123');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to the Naukri listing URL when the company-site button is not found', async () => {
    const db = openDb(':memory:');
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'naukri-test-'));
    const sessionStatePath = path.join(tmpDir, 'naukri-state.json');
    writeFileSync(sessionStatePath, '{}');

    const rawCards = [
      {
        titleText: 'Full Stack Developer',
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-full-stack-developer-acme-66666',
        descriptionText: null,
      },
    ];
    const searchPage = makeFakeSearchPage(rawCards);
    const searchContext = { newPage: vi.fn().mockResolvedValue(searchPage), close: vi.fn().mockResolvedValue(undefined) };
    const applyContext = makeFakeApplyContext(false, null);
    const browser = {
      newContext: vi.fn().mockResolvedValueOnce(searchContext).mockResolvedValueOnce(applyContext),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchNaukriJobs({ role: 'Full Stack Developer' }, { chromium: chromiumStub, db, sessionStatePath });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].apply_url).toBe('https://www.naukri.com/job-listings-full-stack-developer-acme-66666');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('resolveApplyUrl', () => {
  it('returns null when the company-site button is not present', async () => {
    const page = {
      locator: vi.fn().mockReturnValue({ first: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }) }),
    };
    const context = { waitForEvent: vi.fn() };

    const result = await resolveApplyUrl(page as never, context as never);

    expect(result).toBeNull();
    expect(context.waitForEvent).not.toHaveBeenCalled();
  });

  it('clicks the button and returns the new tab URL when found', async () => {
    const button = { count: vi.fn().mockResolvedValue(1), click: vi.fn().mockResolvedValue(undefined) };
    const page = { locator: vi.fn().mockReturnValue({ first: vi.fn().mockReturnValue(button) }) };
    const newPage = {
      url: vi.fn().mockReturnValue('https://acme.com/careers/apply/123'),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const context = { waitForEvent: vi.fn().mockResolvedValue(newPage) };

    const result = await resolveApplyUrl(page as never, context as never);

    expect(result).toBe('https://acme.com/careers/apply/123');
    expect(button.click).toHaveBeenCalled();
  });

  it('returns null if waiting for the new tab times out', async () => {
    const button = { count: vi.fn().mockResolvedValue(1), click: vi.fn().mockResolvedValue(undefined) };
    const page = { locator: vi.fn().mockReturnValue({ first: vi.fn().mockReturnValue(button) }) };
    const context = { waitForEvent: vi.fn().mockRejectedValue(new Error('Timeout')) };

    const result = await resolveApplyUrl(page as never, context as never);

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sources-naukri.test.ts`
Expected: FAIL — `fetchNaukriJobs is not exported` (or similar)

- [ ] **Step 3: Write the implementation**

Add to the top of `src/sources/naukri.ts` (alongside the existing `import type { Job } from
'../db.js';` line):

```typescript
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb, isSeen, saveJob } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const DEFAULT_SESSION_STATE_PATH = path.join(projectRoot, 'secrets', 'naukri-state.json');
const CARD_SELECTOR = '.srp-jobtuple-wrapper';
const COMPANY_SITE_BUTTON_SELECTOR = '.company-site-button';
```

Add to the bottom of `src/sources/naukri.ts`:

```typescript
export interface NaukriDeps {
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
  /** Injectable db handle, for testing without touching data.sqlite. */
  db?: BetterSqlite3.Database;
  /** Injectable session-state file path, for testing without touching the real secrets file. */
  sessionStatePath?: string;
}

/**
 * Clicks Naukri's "Apply on company site" button if present and returns the resulting new tab's
 * URL — navigation only, never a submission. Returns null if the button isn't present, or if
 * waiting for the new tab times out.
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
    return url;
  } catch {
    return null;
  }
}

/**
 * Scrapes Naukri's search-results page for a role/location, then (if a saved session exists)
 * resolves each new job's real apply_url via `resolveApplyUrl`. Both phases run `headless: false`
 * — Naukri's Akamai bot protection blocks headless Chromium outright (see Global Constraints).
 */
export async function fetchNaukriJobs(
  params: { role: string; location?: string },
  deps: NaukriDeps = {}
): Promise<Job[]> {
  const db = deps.db ?? openDb('data.sqlite');
  const browserLauncher = deps.chromium ?? chromium;
  const sessionStatePath = deps.sessionStatePath ?? DEFAULT_SESSION_STATE_PATH;
  const searchUrl = buildNaukriSearchUrl(params.role, params.location);

  let browser: Browser | undefined;
  try {
    browser = await browserLauncher.launch({ headless: false });

    let newJobs: Job[] = [];
    const searchContext = await browser.newContext();
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

      const { jobs, found, parsed, skipped } = parseNaukriCards(rawCards);
      console.error(`[naukri] ${parsed}/${found} parsed, ${skipped} skipped (malformed)`);
      newJobs = jobs.filter((job) => !isSeen(db, job.id));
    } catch (err) {
      console.error('[naukri] search fetch failed:', err instanceof Error ? err.message : err);
      return [];
    } finally {
      await searchContext.close();
    }

    if (newJobs.length > 0 && existsSync(sessionStatePath)) {
      const applyContext = await browser.newContext({ storageState: sessionStatePath });
      try {
        for (const job of newJobs) {
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
    } else if (newJobs.length > 0) {
      console.error(
        `[naukri] session state not found at ${sessionStatePath} — using Naukri listing URLs as apply_url`
      );
    }

    for (const job of newJobs) {
      saveJob(db, job);
    }
    return newJobs;
  } catch (err) {
    console.error('[naukri] fetch failed:', err instanceof Error ? err.message : err);
    return [];
  } finally {
    await browser?.close();
  }
}
```

Modify `src/sources/index.ts` — replace:

```typescript
import type { Job } from '../db.js';
import { fetchAdzuna } from './adzuna.js';
import { fetchRemotive } from './remotive.js';
import { fetchRemoteok } from './remoteok.js';

export async function fetchAllJobs(params: { role: string; location?: string }): Promise<Job[]> {
  const [adzuna, remotive, remoteok] = await Promise.all([
    fetchAdzuna({ role: params.role, location: params.location }),
    fetchRemotive({ role: params.role }),
    fetchRemoteok(),
  ]);
  return [...adzuna, ...remotive, ...remoteok];
}
```

with:

```typescript
import type { Job } from '../db.js';
import { fetchAdzuna } from './adzuna.js';
import { fetchRemotive } from './remotive.js';
import { fetchRemoteok } from './remoteok.js';
import { fetchNaukriJobs } from './naukri.js';

export async function fetchAllJobs(params: { role: string; location?: string }): Promise<Job[]> {
  const [adzuna, remotive, remoteok, naukri] = await Promise.all([
    fetchAdzuna({ role: params.role, location: params.location }),
    fetchRemotive({ role: params.role }),
    fetchRemoteok(),
    fetchNaukriJobs({ role: params.role, location: params.location }),
  ]);
  return [...adzuna, ...remotive, ...remoteok, ...naukri];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sources-naukri.test.ts`
Expected: PASS (19/19)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run`
Expected: PASS (previous total + 19)

Run: `npx tsc -p . --noEmit`
Expected: only the 2 pre-existing unrelated `linkedin.ts` errors, no new ones

- [ ] **Step 6: Commit**

```bash
git add src/sources/naukri.ts src/sources/index.ts tests/sources-naukri.test.ts
git commit -m "feat: add Naukri fetch orchestration, apply-URL resolution, and wire into fetchAllJobs"
```
