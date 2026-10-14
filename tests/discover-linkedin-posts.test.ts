import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildSyntheticPostId,
  isHiringIntent,
  parseLinkedInPostCards,
  buildLinkedInPostSearchUrl,
  type RawPostCard,
} from '../src/discover/linkedin-posts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('POST_CARD_SELECTOR', () => {
  it('uses the role=listitem selector, not the old hashed-class selector', () => {
    const source = readFileSync(
      path.join(__dirname, '../src/discover/linkedin-posts.ts'),
      'utf-8'
    );
    expect(source).toContain('[role="listitem"]');
    expect(source).not.toContain('.feed-shared-update-v2, .reusable-search__result-container');
  });
});

describe('buildSyntheticPostId', () => {
  it('is deterministic for the same profileUrl and text', () => {
    const id1 = buildSyntheticPostId('https://www.linkedin.com/in/jane-recruiter/', "We're hiring!");
    const id2 = buildSyntheticPostId('https://www.linkedin.com/in/jane-recruiter/', "We're hiring!");
    expect(id1).toBe(id2);
  });

  it('produces a different id for a different profileUrl', () => {
    const id1 = buildSyntheticPostId('https://www.linkedin.com/in/jane-recruiter/', "We're hiring!");
    const id2 = buildSyntheticPostId('https://www.linkedin.com/in/other-recruiter/', "We're hiring!");
    expect(id1).not.toBe(id2);
  });

  it('produces a different id for different text', () => {
    const id1 = buildSyntheticPostId('https://www.linkedin.com/in/jane-recruiter/', "We're hiring!");
    const id2 = buildSyntheticPostId('https://www.linkedin.com/in/jane-recruiter/', 'Different text');
    expect(id1).not.toBe(id2);
  });

  it('is prefixed with li-post:', () => {
    const id = buildSyntheticPostId('https://www.linkedin.com/in/jane-recruiter/', "We're hiring!");
    expect(id).toMatch(/^li-post:/);
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
    const keywords = new URL(url).searchParams.get('keywords');
    expect(keywords).toContain(' in');
  });
});

describe('parseLinkedInPostCards', () => {
  it('parses a hiring-intent card into a Job', () => {
    const profileUrl = 'https://www.linkedin.com/in/jane-recruiter/';
    const text = "We're hiring a Senior React Developer, remote, India.";
    const rawCards: RawPostCard[] = [
      {
        textContent: text,
        profileUrl,
        authorText: 'Jane Recruiter',
      },
    ];

    const result = parseLinkedInPostCards(rawCards);
    const expectedId = buildSyntheticPostId(profileUrl, text);

    expect(result.found).toBe(1);
    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.jobs).toEqual([
      {
        id: expectedId,
        source: 'linkedin-posts',
        title: 'Jane Recruiter',
        company: '',
        url: profileUrl,
        apply_url: profileUrl,
        description: text,
      },
    ]);
  });

  it('silently excludes a non-hiring post without counting it as skipped', () => {
    const rawCards: RawPostCard[] = [
      {
        textContent: 'Just got a new certification, excited!',
        profileUrl: 'https://www.linkedin.com/in/someone/',
        authorText: 'Someone',
      },
    ];

    const result = parseLinkedInPostCards(rawCards);

    expect(result.found).toBe(1);
    expect(result.parsed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.jobs).toHaveLength(0);
  });

  it('skips a malformed card (no profileUrl) without failing the rest of the page', () => {
    const profileUrl = 'https://www.linkedin.com/in/other-recruiter/';
    const text = "We're hiring a Backend Engineer";
    const rawCards: RawPostCard[] = [
      { textContent: "We're hiring!", profileUrl: null, authorText: 'Someone' },
      {
        textContent: text,
        profileUrl,
        authorText: 'Other Recruiter',
      },
    ];

    const result = parseLinkedInPostCards(rawCards);
    const expectedId = buildSyntheticPostId(profileUrl, text);

    expect(result.found).toBe(2);
    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe(expectedId);
  });

  it('falls back to default title when authorText is an empty string', () => {
    const profileUrl = 'https://www.linkedin.com/in/some-company/';
    const text = "We're hiring a Frontend Developer, 5+ years experience";
    const rawCards: RawPostCard[] = [
      {
        textContent: text,
        profileUrl,
        authorText: '',
      },
    ];

    const result = parseLinkedInPostCards(rawCards);
    const expectedId = buildSyntheticPostId(profileUrl, text);

    expect(result.found).toBe(1);
    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toEqual({
      id: expectedId,
      source: 'linkedin-posts',
      title: 'LinkedIn hiring post',
      company: '',
      url: profileUrl,
      apply_url: profileUrl,
      description: text,
    });
  });
});

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
    const profileUrl = 'https://www.linkedin.com/in/recruiter-a/';
    const text = "We're hiring a Backend Engineer";
    const rawCards: RawPostCard[] = [
      {
        textContent: text,
        profileUrl,
        authorText: 'Recruiter A',
      },
    ];
    const page = makeFakePostPage(rawCards);
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };

    const jobs = await fetchLinkedInPosts({ role: 'backend engineer', geo: 'in' }, { chromium: chromiumStub, db });
    const expectedId = buildSyntheticPostId(profileUrl, text);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(expectedId);
    expect(isSeen(db, expectedId)).toBe(true);
  });

  it('falls back to config.posts.role/geo when params are omitted', async () => {
    const db = openDb(':memory:');
    const page = makeFakePostPage([]);
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const chromiumStub = { launch: vi.fn().mockResolvedValue(browser) };
    const configOverride = { jobs: [{ name: 'default', search_url: 'https://example.com', limit: 5 }], posts: { role: 'devops engineer', geo: 'in', limit: 5 } };

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

  it('returns [] and never launches a browser when the burner session state file is missing', async () => {
    const db = openDb(':memory:');
    const chromiumStub = { launch: vi.fn() };

    const jobs = await fetchLinkedInPosts(
      { role: 'backend engineer', geo: 'in' },
      { chromium: chromiumStub, db, burnerStatePath: '/nonexistent/path/to/burner-state.json' }
    );

    expect(jobs).toEqual([]);
    expect(chromiumStub.launch).not.toHaveBeenCalled();
  });
});
