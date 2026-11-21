import { describe, expect, it } from 'vitest';
import { collectByScrolling, scrollRoundsFor, settleForCards } from '../src/linkedin/discoverCommon.js';
import type { RawSnapshot } from '../src/linkedin/types.js';

const card = (n: number) => ({ text: `post ${n}`, authorName: `A${n}`, profileHref: `/in/a${n}/`, urn: `urn:li:activity:${n}` });
const snapWith = (ids: number[]): RawSnapshot => ({ url: 'https://www.linkedin.com/search/results/content/', postCards: ids.map(card) } as unknown as RawSnapshot);

function fakeDeps(batches: number[][]) {
  let i = 0;
  let scrolls = 0;
  const deps = {
    rt: {
      page: () => ({ evaluate: async () => { scrolls++; return 0; }, waitForTimeout: async () => undefined }),
      snapshot: async () => snapWith(batches[Math.min(i++, batches.length - 1)]),
    },
  };
  return { deps: deps as never, scrolls: () => scrolls };
}

describe('collectByScrolling', () => {
  it('merges cards from each scroll by identity and drops duplicates', async () => {
    const f = fakeDeps([[1, 2, 3], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6, 7, 8]]);
    const out = await collectByScrolling(f.deps, snapWith([1]), 6, 50);
    expect(out.postCards?.map((c) => c.urn)).toEqual(['urn:li:activity:1', 'urn:li:activity:2', 'urn:li:activity:3', 'urn:li:activity:4', 'urn:li:activity:5', 'urn:li:activity:6', 'urn:li:activity:7', 'urn:li:activity:8']);
  });
  it('stops after two rounds that add nothing', async () => {
    const f = fakeDeps([[1, 2], [1, 2], [1, 2], [1, 2, 3]]);
    await collectByScrolling(f.deps, snapWith([1, 2]), 10, 50);
    expect(f.scrolls()).toBe(2);
  });
  it('stops at the limit', async () => {
    const f = fakeDeps([[1, 2, 3, 4], [1, 2, 3, 4, 5, 6, 7, 8]]);
    const out = await collectByScrolling(f.deps, snapWith([1]), 6, 4);
    expect(out.postCards?.length).toBe(4);
    expect(f.scrolls()).toBe(1);
  });
  it('returns the first snapshot untouched without a page or with 0 rounds', async () => {
    const first = snapWith([1]);
    expect(await collectByScrolling({ rt: { page: () => null } } as never, first, 6, 50)).toBe(first);
    expect(await collectByScrolling(fakeDeps([[1, 2]]).deps, first, 0, 50)).toBe(first);
  });
  it('keeps what was collected when a scroll throws', async () => {
    const deps = { rt: { page: () => ({ evaluate: async () => { throw new Error('boom'); }, waitForTimeout: async () => undefined }), snapshot: async () => null } };
    const out = await collectByScrolling(deps as never, snapWith([1, 2]), 6, 50);
    expect(out.postCards?.length).toBe(2);
  });
});

describe('scrollRoundsFor', () => {
  it('defaults to 6, clamps to 0..12, and 0 turns it off', () => {
    expect(scrollRoundsFor({} as NodeJS.ProcessEnv)).toBe(6);
    expect(scrollRoundsFor({ LINKEDIN_POST_SCROLL_ROUNDS: '' } as NodeJS.ProcessEnv)).toBe(6);
    expect(scrollRoundsFor({ LINKEDIN_POST_SCROLL_ROUNDS: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(scrollRoundsFor({ LINKEDIN_POST_SCROLL_ROUNDS: '99' } as NodeJS.ProcessEnv)).toBe(12);
    expect(scrollRoundsFor({ LINKEDIN_POST_SCROLL_ROUNDS: 'x' } as NodeJS.ProcessEnv)).toBe(6);
  });
});

describe('settleForCards', () => {
  const empty = { url: 'https://www.linkedin.com/search/results/content/', postCards: [] } as unknown as RawSnapshot;
  const pageOf = () => ({ waitForTimeout: async () => undefined });
  it('reads again while a search page has no card and keeps the first snapshot that has some', async () => {
    let i = 0;
    const deps = { rt: { page: pageOf, snapshot: async () => (i++ < 2 ? empty : snapWith([1, 2])) } };
    const out = await settleForCards(deps as never, empty, 'search_posts');
    expect(out.postCards?.length).toBe(2);
    expect(i).toBe(3);
  });
  it('does not read again when cards are already there or without a page, and gives up after the tries', async () => {
    const have = snapWith([1]);
    expect(await settleForCards({ rt: { page: pageOf, snapshot: async () => { throw new Error('no'); } } } as never, have, 'search_posts')).toBe(have);
    expect(await settleForCards({ rt: { page: () => null } } as never, empty, 'search_posts')).toBe(empty);
    let n = 0;
    const deps = { rt: { page: pageOf, snapshot: async () => { n++; return empty; } } };
    await settleForCards(deps as never, empty, 'search_posts', 3);
    expect(n).toBe(3);
  });
});
