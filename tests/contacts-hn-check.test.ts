import { describe, it, expect, vi } from 'vitest';
import { withHnGate } from '../src/lib/postingDomains.js';

describe('withHnGate (contacts tool seam)', () => {
  it('does no work when the HN domain is unmatched', async () => {
    const work = vi.fn(async () => [{ email: 'a@b.c' }]);
    const r = await withHnGate({ source: 'hackernews', description: 'jobs@acme.io' }, 'evil.com', work);
    expect(r).toEqual({ contacts: [], hn_check: 'unmatched' });
    expect(work).not.toHaveBeenCalled();
  });
  it('does no work when the posting has no domain', async () => {
    const work = vi.fn(async () => [1]);
    const r = await withHnGate({ source: 'hackernews', description: 'nothing' }, 'acme.io', work);
    expect(r.hn_check).toBe('no_domain_in_posting');
    expect(work).not.toHaveBeenCalled();
  });
  it('runs work when matched or not applicable', async () => {
    const work = vi.fn(async () => [1]);
    const a = await withHnGate({ source: 'hackernews', description: 'x@acme.io' }, 'acme.io', work);
    const b = await withHnGate({ source: 'adzuna', description: null }, 'acme.io', work);
    const c = await withHnGate(null, 'acme.io', work);
    expect([a.hn_check, b.hn_check, c.hn_check]).toEqual(['matched', 'not_applicable', 'not_applicable']);
    expect(work).toHaveBeenCalledTimes(3);
  });
});
