import { describe, it, expect } from 'vitest';
import { loadPortals, locationAllowed, titlePasses } from '../src/sources/boards/filters.js';

const { config, error, warnings } = loadPortals();

describe('config/portals.json (the real file)', () => {
  it('loads with no error and no dropped entries', () => {
    expect(error).toBeNull();
    expect(warnings).toEqual([]);
    expect(config).not.toBeNull();
  });
  it('keeps the four original boards enabled and every new-vendor example and aggregator DISABLED (user supplies tenants and enables them after check-portal)', () => {
    const tracked = config!.tracked_companies;
    expect(tracked.filter((c) => c.enabled).map((c) => `${c.ats}:${c.slug}`)).toEqual(['greenhouse:gitlab', 'greenhouse:razorpaysoftwareprivatelimited', 'lever:meesho', 'ashby:linear']);
    expect(tracked.filter((c) => c.ats === 'workday').every((c) => c.wd && c.site)).toBe(true);
    expect(tracked.some((c) => ['hackernews', 'himalayas', 'weworkremotely'].includes(c.ats) && c.enabled)).toBe(false);
    expect(tracked.filter((c) => ['hackernews', 'himalayas', 'weworkremotely'].includes(c.ats))).toHaveLength(3);
  });
  it('hackernews and the other aggregators are present and DISABLED by default, individually', () => {
    for (const a of ['hackernews', 'himalayas', 'weworkremotely']) {
      const entries = config!.tracked_companies.filter((c) => c.ats === a);
      expect(entries).toHaveLength(1);
      expect(entries[0].enabled).toBe(false);
    }
  });
});

describe('Gulf locations in the location filter', () => {
  // These pin the plan 4 / Gulf allow-list rules, so the remote_anywhere option (shipped true, see remoteAnywhere.test.ts) is switched off here.
  const f = { ...config!.location_filter, remote_anywhere: false };
  it.each([
    'Dubai, United Arab Emirates', 'Abu Dhabi', 'Sharjah, UAE', 'Riyadh, Saudi Arabia', 'Jeddah', 'KSA', 'Doha, Qatar', 'Kuwait City, Kuwait',
    'Manama, Bahrain', 'Muscat, Oman', 'GCC', 'Middle East', 'MENA', 'Remote, UAE', 'Hybrid - Dubai',
  ])('allows %s', (loc) => { expect(locationAllowed([loc], false, f)).toBe(true); });
  it.each([
    'Romania', 'Bucharest, Romania', 'Woman-owned business hub', 'Omani', 'Remote (excl. UAE)', 'Remote, Germany', 'Berlin', 'Kuwaiti Street Boston',
  ])('does not allow %s (word boundaries, exclusions and other places still fail)', (loc) => { expect(locationAllowed([loc], false, f)).toBe(false); });
  it('keeps the bare-global rule: Remote and Worldwide pass for remote roles, "Remote, <other place>" does not', () => {
    expect(locationAllowed(['Remote'], true, f)).toBe(true);
    expect(locationAllowed(['Worldwide'], true, f)).toBe(true);
    expect(locationAllowed(['Remote, Sweden'], true, f)).toBe(false);
  });
  it('title filter is unchanged for Gulf postings', () => {
    expect(titlePasses('Senior Frontend Engineer', config!.title_filter)).toBe(true);
    expect(titlePasses('Sales Manager', config!.title_filter)).toBe(false);
  });
});
