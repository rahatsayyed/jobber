import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { buildPostsSearchUrl, discoveryConfigSchema, loadDiscoveryConfig } from '../src/linkedin/discoveryConfig.js';
import { markSearchTried, rotateNames } from '../src/linkedin/discoverRotation.js';
import { pickDiscoverNames, LINKEDIN_DISCOVER_MAX_PER_WAKE } from '../src/scheduler/plan.js';
import { mentionsRole } from '../src/linkedin/searchPosts.js';

describe('shipped config/linkedin-discovery.json', () => {
  const cfg = loadDiscoveryConfig();
  it('is schema valid and has several named post searches with unique names', () => {
    expect(discoveryConfigSchema.safeParse(JSON.parse(JSON.stringify(cfg))).success).toBe(true);
    const names = cfg.posts.map((p) => p.name);
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('default');
  });
  it('covers referral phrasing, MERN/Node/React, Gulf and remote', () => {
    const all = JSON.stringify(cfg.posts).toLowerCase();
    for (const w of ['referral', 'mern', 'node', 'react', 'dubai', 'pune', 'bangalore', 'hyderabad', 'remote']) expect(all).toContain(w);
  });
  it('every post search builds a url and its role definition can match a post', () => {
    for (const p of cfg.posts) {
      const u = new URL(buildPostsSearchUrl(p));
      expect(u.pathname).toBe('/search/results/content/');
      expect(u.searchParams.get('keywords')!.length).toBeGreaterThan(10);
      expect(mentionsRole('Hiring a MERN stack React Node.js full stack developer', p.role)).toBe(true);
    }
  });
});

describe('buildPostsSearchUrl phrases', () => {
  it('keeps the default hiring phrases when none are given', () => {
    const u = new URL(buildPostsSearchUrl({ name: 'a', role: 'react', geo: 'in', limit: 25 }));
    expect(u.searchParams.get('keywords')).toBe('(hiring OR "we\'re hiring" OR "we are hiring" OR "join our team") (react) in');
  });
  it('quotes custom phrases and rejects quotes or brackets inside one', () => {
    const u = new URL(buildPostsSearchUrl({ name: 'a', role: 'react', geo: '', phrases: ['DM me for referral', 'send your CV'], limit: 25 }));
    expect(u.searchParams.get('keywords')).toBe('("DM me for referral" OR "send your CV") (react)');
    expect(discoveryConfigSchema.safeParse({ posts: [{ name: 'a', role: 'r', phrases: ['x" OR "y'] }] }).success).toBe(false);
  });
});

describe('search rotation', () => {
  const T0 = new Date('2026-11-08T00:00:00Z');
  it('never tried first in config order, then the oldest attempt first', () => {
    const db = openDb(':memory:');
    const names = ['a', 'b', 'c', 'd'];
    expect(rotateNames(db, 'search_posts', names)).toEqual(['a', 'b', 'c', 'd']);
    markSearchTried(db, 'search_posts', 'a', new Date(T0.getTime() + 1000));
    markSearchTried(db, 'search_posts', 'c', new Date(T0.getTime() + 2000));
    expect(rotateNames(db, 'search_posts', names)).toEqual(['b', 'd', 'a', 'c']);
    markSearchTried(db, 'search_posts', 'b', new Date(T0.getTime() + 3000));
    markSearchTried(db, 'search_posts', 'd', new Date(T0.getTime() + 4000));
    expect(rotateNames(db, 'search_posts', names)).toEqual(['a', 'c', 'b', 'd']);
  });
  it('jobs and posts keep separate histories', () => {
    const db = openDb(':memory:');
    markSearchTried(db, 'search_jobs', 'x', T0);
    expect(rotateNames(db, 'search_posts', ['x', 'y'])).toEqual(['x', 'y']);
  });
});

describe('pickDiscoverNames', () => {
  it('returns everything unchanged when it fits the quota', () => {
    const n = { jobs: ['j1'], posts: ['p1'] };
    expect(pickDiscoverNames(n, 2)).toBe(n);
  });
  it('takes posts and jobs alternately, posts first, never more than the quota', () => {
    const n = { jobs: ['j1', 'j2', 'j3'], posts: ['p1', 'p2', 'p3', 'p4'] };
    expect(pickDiscoverNames(n, 2)).toEqual({ jobs: ['j1'], posts: ['p1'] });
    expect(pickDiscoverNames(n, 3)).toEqual({ jobs: ['j1'], posts: ['p1', 'p2'] });
    expect(pickDiscoverNames({ jobs: [], posts: ['p1', 'p2', 'p3'] }, 2)).toEqual({ jobs: [], posts: ['p1', 'p2'] });
    expect(pickDiscoverNames({ jobs: ['j1', 'j2', 'j3'], posts: [] }, 2)).toEqual({ jobs: ['j1', 'j2'], posts: [] });
  });
  it('the per-wake cap is small (spreads the daily discover ceiling)', () => {
    expect(LINKEDIN_DISCOVER_MAX_PER_WAKE).toBeLessThanOrEqual(3);
  });
});
