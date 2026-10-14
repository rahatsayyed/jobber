import { describe, it, expect } from 'vitest';
import { normalizeAdzuna } from '../src/sources/adzuna.js';
import { normalizeRemotive } from '../src/sources/remotive.js';
import { normalizeRemoteok } from '../src/sources/remoteok.js';

describe('normalizeAdzuna', () => {
  it('maps adzuna results to Job[]', () => {
    const jobs = normalizeAdzuna({
      results: [
        {
          id: 1,
          title: 'X',
          company: { display_name: 'Y' },
          redirect_url: 'u',
          description: 'd',
        },
      ],
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      id: 'adzuna:1',
      source: 'adzuna',
      title: 'X',
      company: 'Y',
      url: 'u',
      apply_url: 'u',
      description: 'd',
    });
  });

  it('handles missing company gracefully', () => {
    const jobs = normalizeAdzuna({
      results: [{ id: 2, title: 'X', redirect_url: 'u', description: 'd' }],
    });
    expect(jobs[0].company).toBe('');
  });
});

describe('normalizeRemotive', () => {
  it('maps remotive jobs to Job[]', () => {
    const jobs = normalizeRemotive({
      jobs: [
        {
          id: 5,
          title: 'Backend Dev',
          company_name: 'Acme',
          url: 'u',
          description: 'd',
        },
      ],
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      id: 'remotive:5',
      source: 'remotive',
      title: 'Backend Dev',
      company: 'Acme',
      url: 'u',
      apply_url: 'u',
      description: 'd',
    });
  });
});

describe('normalizeRemoteok', () => {
  it('skips the legal notice and filters non-dev roles', () => {
    const jobs = normalizeRemoteok([
      { legal: '..' },
      {
        id: 9,
        position: 'React Dev',
        company: 'C',
        url: 'u',
        tags: ['react'],
        description: 'd',
      },
      {
        id: 10,
        position: 'Chef',
        company: 'K',
        tags: ['cooking'],
        url: 'u2',
      },
    ]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      id: 'remoteok:9',
      source: 'remoteok',
      title: 'React Dev',
      company: 'C',
      url: 'u',
      apply_url: 'u',
      description: 'd',
    });
  });
});

