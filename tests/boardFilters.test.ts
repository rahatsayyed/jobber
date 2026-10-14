import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { htmlToPlain, isValidSlug, loadPortals, locationAllowed, safeVendorUrl, titlePasses } from '../src/sources/boards/filters.js';

const tf = { positive: ['frontend', 'react', 'sde', 'word:java', 'stem:typescript', 'node + backend'], negative: ['manager', 'ai'] };

describe('titlePasses', () => {
  it.each([
    ['Senior Frontend Engineer', true],
    ['React Native Developer', true],
    ['SDE II', true],
    ['Java Developer', true],
    ['JavaScript Engineer', false],
    ['TypeScriptish Platform Dev', true],
    ['Node Backend Engineer', true],
    ['Node Engineer', false],
    ['Frontend Engineering Manager', false],
    ['Frontend AI Engineer', false],
    ['Frontend engineer to maintain apps', true],
    ['Café Frontend', true],
  ])('%s -> %s', (title, ok) => { expect(titlePasses(title, tf)).toBe(ok); });
  it('empty positive accepts all but negatives still reject', () => {
    expect(titlePasses('Anything', { positive: [], negative: [] })).toBe(true);
    expect(titlePasses('Sales Lead', { positive: [], negative: ['sales'] })).toBe(false);
  });
});

describe('title keyword word forms', () => {
  const f = { positive: ['frontend'], negative: ['word:intern', 'lead:marketing', 'lead:ios', 'word:staff'] };
  it.each([
    ['Frontend Intern', false],
    ['Frontend Engineer, Internal Tools', true],
    ['Frontend Engineer, International', true],
    ['Frontend Engineer, Marketing', true],
    ['Marketing Frontend Engineer', false],
    ['Frontend Engineer - iOS web views', true],
    ['iOS Frontend Engineer', false],
    ['Staff Frontend Engineer', false],
    ['Staff-augmentation Frontend Dev', true],
  ])('%s -> %s', (title, ok) => { expect(titlePasses(title, f)).toBe(ok); });
});

describe('shipped title filter on real board titles', () => {
  const tfs = loadPortals().config!.title_filter;
  // Real GitLab and probe titles that the old substring negatives wrongly dropped (must be kept).
  it.each([
    'Senior Fullstack Engineer, Marketing',
    'Frontend Engineer, Internal Tools',
    'React Developer - International Payments',
    'Software Development Engineer II',
    'MERN Stack Developer',
    'UI Engineer',
    'Full Stack Engineer (Product Designer tools)',
    'Staff-augmentation React Dev',
    'Frontend Engineer - iOS web views',
    'Senior Frontend Engineer | Bangalore, India',
    'Fullstack Engineer (TypeScript), AI Engineering: Duo Client SDK',
    'Intermediate Software Engineer, Security Factory: Vulnerability Management',
  ])('keeps %s', (title) => { expect(titlePasses(title, tfs)).toBe(true); });
  it.each([
    'Frontend Engineer Intern',
    'Staff Frontend Engineer',
    'Frontend Engineering Manager',
    'QA Engineer (React)',
    'Product Designer, React Design Systems',
    'Marketing Engineer (JavaScript)',
    'Director of Product Management, Agentic Software Delivery',
    'Principal Product Manager, AI Software Factory',
  ])('drops %s', (title) => { expect(titlePasses(title, tfs)).toBe(false); });
});

describe('locationAllowed', () => {
  const lf = { allow: ['india', 'bengaluru', 'bangalore'], global: ['remote', 'anywhere', 'worldwide', 'global'] };
  it.each([
    [['Remote, India'], true, true],
    [['Bengaluru'], false, true],
    [['Remote, United States'], true, false],
    [['Remote, US'], true, false],
    [['Europe'], true, false],
    [['Remote'], true, true],
    [['Remote only'], true, true],
    [[''], true, true],
    [[''], false, false],
    [['Anywhere'], true, true],
    [['Worldwide'], true, true],
    [['Remote - Worldwide'], true, true],
    [['Remote - Worldwide (excl. India)'], true, false],
    [['Worldwide (excl. India)'], true, false],
    [['Remote (US/Canada)'], true, false],
    [['Remote, Ukraine'], true, false],
    [['Remote, Sweden'], true, false],
    [['Remote, Israel'], true, false],
    [['Remote, Sweden/Austria/Switzerland'], true, false],
    [['Singapore'], false, false],
    [['San Francisco', 'Bangalore, India'], false, true],
    // Greenhouse joins several locations into one semicolon-separated string
    [['Remote, Canada; Remote, India'], true, true],
    [['Remote, Canada; Remote, United States'], true, false],
    [['Bengaluru; Remote, US'], false, true],
    [['Remote, Canada; Berlin'], true, false],
    [['Remote, US;'], true, false],
  ])('%j remote=%s -> %s', (locs, remote, ok) => { expect(locationAllowed(locs, remote, lf)).toBe(ok); });
  it('the shipped location filter rejects the live GitLab leaks', () => {
    // remote_anywhere (shipped true) is switched off here: this pins the plan 4 rule; remoteAnywhere.test.ts covers the shipped option.
    const shipped = { ...loadPortals().config!.location_filter, remote_anywhere: false };
    for (const l of ['Remote, US', 'Remote, Sweden', 'Remote, Israel', 'Remote - Worldwide (excl. India)', 'Remote, Canada; Remote, United States']) {
      expect(locationAllowed([l], true, shipped)).toBe(false);
    }
    for (const l of ['Remote, India', 'Bangalore, India', 'Remote, Canada; Remote, India', 'Remote']) {
      expect(locationAllowed([l], true, shipped)).toBe(true);
    }
  });
});

describe('htmlToPlain', () => {
  it('removes the escaping layer, strips tags and decodes entities', () => {
    expect(htmlToPlain('&lt;p&gt;Build &amp;amp; ship &lt;strong&gt;React&lt;/strong&gt; apps&lt;/p&gt;')).toBe('Build & ship React apps');
    expect(htmlToPlain('<ul><li>One</li><li>Two&nbsp;three</li></ul>')).toBe('One Two three');
    expect(htmlToPlain('&lt;a href=&quot;https://x.test&quot;&gt;Apply&lt;/a&gt;')).toBe('Apply');
  });
  it('decodes numeric and common named entities', () => {
    expect(htmlToPlain('<p>Don&#x27;t stop &mdash; it&rsquo;s &#8212; &#x1F600;</p>')).toBe('Don\'t stop — it’s — \u{1F600}');
    expect(htmlToPlain('&lt;p&gt;It&#x27;s &amp;amp; ok&lt;/p&gt;')).toBe("It's & ok");
  });
  it('decodes exactly once: double-escaped text never becomes a literal tag', () => {
    expect(htmlToPlain('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  it('leaves unknown or invalid entities untouched', () => {
    expect(htmlToPlain('&bogus; &#0; &#xD800;')).toBe('&bogus; &#0; &#xD800;');
  });
});

describe('isValidSlug', () => {
  it.each([
    ['gitlab', true], ['razorpaysoftwareprivatelimited', true], ['a.b_c-d', true], ['A1', true], ['x'.repeat(100), true],
    ['..', false], ['.', false], ['a/b', false], ['-x', false], ['.x', false], ['a b', false], ['', false], ['x'.repeat(101), false], ['a?b=1', false],
  ])('%s -> %s', (slug, ok) => { expect(isValidSlug(slug)).toBe(ok); });
  it('rejects non-strings', () => { expect(isValidSlug(undefined)).toBe(false); expect(isValidSlug(42)).toBe(false); });
});

describe('safeVendorUrl', () => {
  it.each([
    ['https://jobs.lever.co/a/1', 'https://jobs.lever.co/a/1'],
    ['https://jobs.eu.lever.co/a/1', 'https://jobs.eu.lever.co/a/1'],
    ['https://jobs.lever.co.evil.io/x', 'FALLBACK'],
    ['https://jobs.lever.co@evil.com/x', 'FALLBACK'],
    ['http://jobs.lever.co/a', 'FALLBACK'],
    ['javascript:alert(1)', 'FALLBACK'],
    [undefined, 'FALLBACK'],
    [42, 'FALLBACK'],
  ])('%s -> %s', (cand, want) => { expect(safeVendorUrl(cand, 'lever.co', 'FALLBACK')).toBe(want); });
});

describe('loadPortals', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'portals-'));
  const VALID = { tracked_companies: [], title_filter: { positive: ['react'], negative: [] }, location_filter: { allow: ['india'] } };
  it('missing file = no boards, no error', () => { expect(loadPortals(path.join(dir, 'none.json'))).toEqual({ config: null, error: null }); });
  it('malformed file = error', () => {
    const f = path.join(dir, 'bad.json'); writeFileSync(f, '{');
    expect(loadPortals(f).error).toMatch(/portals\.json/);
  });
  it('rejects unknown ATS values and keeps valid entries', () => {
    const f = path.join(dir, 'ok.json');
    writeFileSync(f, JSON.stringify({ tracked_companies: [{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }, { name: 'B', ats: 'taleo', slug: 'b', enabled: true }], title_filter: { positive: ['react'], negative: [] }, location_filter: { allow: ['india'], global: [] } }));
    expect(loadPortals(f).config!.tracked_companies).toEqual([{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }]);
    expect(loadPortals(f).warnings).toEqual(['config/portals.json: tracked_companies[1] (B) skipped: unknown ats "taleo"']);
  });
  it('reports each dropped invalid slug as a warning', () => {
    const f = path.join(dir, 'warn.json');
    writeFileSync(f, JSON.stringify({ ...VALID, tracked_companies: [{ name: 'X', ats: 'lever', slug: '..', enabled: true }, { name: 'Y', ats: 'lever', slug: 'y', enabled: true }] }));
    const r = loadPortals(f);
    expect(r.warnings).toEqual(['config/portals.json: tracked_companies[0] (X) skipped: invalid slug']);
    expect(r.config!.tracked_companies.map((c) => c.slug)).toEqual(['y']);
  });
  it('a run of unmatched "<" is linear', () => {
    for (const s of ['<'.repeat(200000), '<!'.repeat(90000), '<a'.repeat(90000)]) {
      const t0 = Date.now();
      htmlToPlain(s);
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  });
  it('drops entries with invalid slugs (path traversal, separators, overlong)', () => {
    const f = path.join(dir, 'slugs.json');
    const slugs = ['gitlab', '..', '.', 'a/b', '-x', 'a b', 'x'.repeat(101), 'a.b_c-d'];
    writeFileSync(f, JSON.stringify({ ...VALID, tracked_companies: slugs.map((slug, i) => ({ name: `c${i}`, ats: 'greenhouse', slug, enabled: true })) }));
    expect(loadPortals(f).config!.tracked_companies.map((c) => c.slug)).toEqual(['gitlab', 'a.b_c-d']);
  });
  it('defaults location_filter.global when absent', () => {
    const f = path.join(dir, 'noglobal.json');
    writeFileSync(f, JSON.stringify({ ...VALID, tracked_companies: [], location_filter: { allow: ['india'] } }));
    expect(loadPortals(f).config!.location_filter.global).toEqual(['remote', 'anywhere', 'worldwide', 'global']);
  });
  it('the shipped config parses', () => {
    expect(loadPortals().config!.tracked_companies.length).toBeGreaterThan(0);
  });
});

describe('loadPortals hollow config fails closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'portals-hollow-'));
  const V = { tracked_companies: [], title_filter: { positive: ['react'], negative: [] }, location_filter: { allow: ['india'] } };
  it.each([
    ['null', 'null'],
    ['array', '[]'],
    ['string', '"x"'],
    ['empty object', '{}'],
    ['tracked wrong type', JSON.stringify({ ...V, tracked_companies: {} })],
    ['missing title_filter', JSON.stringify({ ...V, title_filter: undefined })],
    ['title_filter wrong type', JSON.stringify({ ...V, title_filter: [] })],
    ['empty positives', JSON.stringify({ ...V, title_filter: { positive: [], negative: [] } })],
    ['blank positives', JSON.stringify({ ...V, title_filter: { positive: [' '], negative: [] } })],
    ['negative wrong type', JSON.stringify({ ...V, title_filter: { positive: ['a'], negative: 'x' } })],
    ['missing location_filter', JSON.stringify({ ...V, location_filter: undefined })],
    ['empty allow', JSON.stringify({ ...V, location_filter: { allow: [] } })],
    ['global wrong type', JSON.stringify({ ...V, location_filter: { allow: ['india'], global: 'remote' } })],
  ])('%s -> config null with a reason', (name, body) => {
    const f = path.join(dir, `${name.replace(/ /g, '_')}.json`); writeFileSync(f, body);
    const r = loadPortals(f);
    expect(r.config).toBeNull();
    expect(r.error).toMatch(/portals\.json: /);
  });
});

describe('locationAllowed tolerates missing lists', () => {
  const lf = { allow: ['india'], global: ['remote'] };
  it('treats null/undefined as an empty location', () => {
    expect(locationAllowed(null, true, lf)).toBe(true);
    expect(locationAllowed(undefined, false, lf)).toBe(false);
  });
});

describe('htmlToPlain is linear and safe', () => {
  const fast = (s: string) => { const t = Date.now(); const out = htmlToPlain(s); expect(Date.now() - t).toBeLessThan(1000); return out; };
  it('survives pathological input quickly', () => {
    fast('<'.repeat(200000));
    fast('&lt;a '.repeat(20000));
    fast('&#'.repeat(100000));
    fast('&a'.repeat(100000));
    fast('<a '.repeat(60000));
    fast('<script>'.repeat(20000));
    fast('<p>x'.repeat(40000));
  });
  it('removes script and style content, not just tags', () => {
    expect(htmlToPlain('<p>Hi</p><script>var x = 1 < 2;</script><style>p{color:red}</style><p>there</p>')).toBe('Hi there');
    expect(htmlToPlain('&lt;p&gt;Hi&lt;/p&gt;&lt;script&gt;evil()&lt;/script&gt;&lt;p&gt;there&lt;/p&gt;')).toBe('Hi there');
  });
  it('keeps text around a lone < or >', () => {
    expect(htmlToPlain('a < b and c > d')).toBe('a < b and c > d');
  });
});
