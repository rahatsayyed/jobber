import { describe, it, expect, vi } from 'vitest';
import {
  buildNaukriSearchUrl,
  extractNaukriJobId,
  parseNaukriCards,
  fetchNaukri,
  resolveApplyUrl,
} from '../src/sources/naukri.js';
import { openDb, isSeen } from '../src/db.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
        'https://www.naukri.com/job-listings-full-stack-developer-i-fedex-express-hyderabad-2-to-5-years-150426501261'
      )
    ).toBe('150426501261');
  });

  it('strips a query string before extracting the id', () => {
    expect(extractNaukriJobId('https://www.naukri.com/job-listings-foo-12345?src=abc')).toBe('12345');
  });

  it('returns null when the URL has no trailing numeric segment', () => {
    expect(extractNaukriJobId('https://www.naukri.com/job-listings-foo-bar')).toBeNull();
  });
});

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

describe('fetchNaukri', () => {
  it('scrapes cards and uses the listing URL as apply_url when no session file exists', async () => {
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

    const jobs = await fetchNaukri(
      { role: 'Full Stack Developer', location: 'India' },
      { chromium: chromiumStub, sessionStatePath: '/nonexistent/naukri-state.json' }
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0].apply_url).toBe('https://www.naukri.com/job-listings-full-stack-developer-acme-12345');
    expect(browser.close).toHaveBeenCalled();
  });

  it('never touches the db — a job it returns is not marked seen in a fresh db', async () => {
    // This is the regression test for the Critical #1 bug: fetchNaukri used to call saveJob
    // itself, which meant a caller's own isSeen/saveJob dedup (job-fetch.ts's list_new_jobs)
    // filtered every Naukri job out as "already seen" before the pipeline ever got to it.
    const rawCards = [
      {
        titleText: 'Full Stack Developer',
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-full-stack-developer-acme-77777',
        descriptionText: null,
      },
    ];
    const searchPage = makeFakeSearchPage(rawCards);
    const searchContext = { newPage: vi.fn().mockResolvedValue(searchPage), close: vi.fn().mockResolvedValue(undefined) };
    const browser = { newContext: vi.fn().mockResolvedValue(searchContext), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchNaukri(
      { role: 'Full Stack Developer' },
      { chromium: chromiumStub, sessionStatePath: '/nonexistent/naukri-state.json' }
    );

    expect(jobs).toHaveLength(1);
    const freshDb = openDb(':memory:');
    expect(isSeen(freshDb, jobs[0].id)).toBe(false);
  });

  it('returns [] (not a throw) if the search page fails to load', async () => {
    const searchPage = {
      goto: vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_RESET')),
      waitForSelector: vi.fn(),
      locator: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const searchContext = { newPage: vi.fn().mockResolvedValue(searchPage), close: vi.fn().mockResolvedValue(undefined) };
    const browser = { newContext: vi.fn().mockResolvedValue(searchContext), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchNaukri(
      { role: 'Full Stack Developer' },
      { chromium: chromiumStub, sessionStatePath: '/nonexistent/naukri-state.json' }
    );

    expect(jobs).toEqual([]);
    expect(browser.close).toHaveBeenCalled();
  });

  it('resolves apply_url via the company-site button when a session file exists', async () => {
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

    const jobs = await fetchNaukri({ role: 'Full Stack Developer' }, { chromium: chromiumStub, sessionStatePath });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].apply_url).toBe('https://acme.com/careers/apply/123');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to the Naukri listing URL when the company-site button is not found', async () => {
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

    const jobs = await fetchNaukri({ role: 'Full Stack Developer' }, { chromium: chromiumStub, sessionStatePath });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].apply_url).toBe('https://www.naukri.com/job-listings-full-stack-developer-acme-66666');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does NOT attempt apply-URL resolution for a job the injected isNewJob predicate says is not new', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'naukri-test-'));
    const sessionStatePath = path.join(tmpDir, 'naukri-state.json');
    writeFileSync(sessionStatePath, '{}');

    const rawCards = [
      {
        titleText: 'Full Stack Developer',
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-full-stack-developer-acme-88888',
        descriptionText: null,
      },
    ];
    const searchPage = makeFakeSearchPage(rawCards);
    const searchContext = { newPage: vi.fn().mockResolvedValue(searchPage), close: vi.fn().mockResolvedValue(undefined) };
    const applyContext = makeFakeApplyContext(true, 'https://acme.com/careers/apply/999');
    const browser = {
      newContext: vi.fn().mockResolvedValueOnce(searchContext).mockResolvedValueOnce(applyContext),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchNaukri(
      { role: 'Full Stack Developer' },
      { chromium: chromiumStub, sessionStatePath, isNewJob: () => false }
    );

    expect(jobs).toHaveLength(1);
    // Falls back to the listing URL — resolution never ran because isNewJob said "not new".
    expect(jobs[0].apply_url).toBe('https://www.naukri.com/job-listings-full-stack-developer-acme-88888');
    // Only the search-phase context was ever created — no apply-phase context.
    expect(browser.newContext).toHaveBeenCalledTimes(1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('attempts apply-URL resolution when no isNewJob predicate is given (defaults to "always new")', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'naukri-test-'));
    const sessionStatePath = path.join(tmpDir, 'naukri-state.json');
    writeFileSync(sessionStatePath, '{}');

    const rawCards = [
      {
        titleText: 'Full Stack Developer',
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-full-stack-developer-acme-11111',
        descriptionText: null,
      },
    ];
    const searchPage = makeFakeSearchPage(rawCards);
    const searchContext = { newPage: vi.fn().mockResolvedValue(searchPage), close: vi.fn().mockResolvedValue(undefined) };
    const applyContext = makeFakeApplyContext(true, 'https://acme.com/careers/apply/111');
    const browser = {
      newContext: vi.fn().mockResolvedValueOnce(searchContext).mockResolvedValueOnce(applyContext),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchNaukri({ role: 'Full Stack Developer' }, { chromium: chromiumStub, sessionStatePath });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].apply_url).toBe('https://acme.com/careers/apply/111');
    expect(browser.newContext).toHaveBeenCalledTimes(2);

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

  it('returns null when the new tab is still on about:blank (never actually navigated)', async () => {
    const button = { count: vi.fn().mockResolvedValue(1), click: vi.fn().mockResolvedValue(undefined) };
    const page = { locator: vi.fn().mockReturnValue({ first: vi.fn().mockReturnValue(button) }) };
    const newPage = {
      url: vi.fn().mockReturnValue('about:blank'),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const context = { waitForEvent: vi.fn().mockResolvedValue(newPage) };

    const result = await resolveApplyUrl(page as never, context as never);

    expect(result).toBeNull();
  });

  it('returns null when the new tab is still on naukri.com (redirector, not the real ATS)', async () => {
    const button = { count: vi.fn().mockResolvedValue(1), click: vi.fn().mockResolvedValue(undefined) };
    const page = { locator: vi.fn().mockReturnValue({ first: vi.fn().mockReturnValue(button) }) };
    const newPage = {
      url: vi.fn().mockReturnValue('https://www.naukri.com/job-listings-foo-123'),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const context = { waitForEvent: vi.fn().mockResolvedValue(newPage) };

    const result = await resolveApplyUrl(page as never, context as never);

    expect(result).toBeNull();
  });
});
