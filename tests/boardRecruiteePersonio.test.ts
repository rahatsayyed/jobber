import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchRecruitee, normalizeRecruitee } from '../src/sources/boards/recruitee.js';
import { fetchPersonio, normalizePersonioXml } from '../src/sources/boards/personio.js';
import { settleBoard } from '../src/sources/boards/greenhouse.js';
import { FETCHERS } from '../src/sources/boards/registry.js';

afterEach(() => vi.unstubAllGlobals());
const rc = { name: 'Acme', ats: 'recruitee' as const, slug: 'acme', enabled: true };
const pe = { name: 'Acme GmbH', ats: 'personio' as const, slug: 'acme', enabled: true };

// Shape read from career-ops providers/recruitee.mjs (id, slug, requirements and published_at are optional extras).
const offers = { offers: [
  { id: 4711, slug: 'frontend-engineer', title: 'Frontend Engineer', careers_url: 'https://acme.recruitee.com/o/frontend-engineer', url: 'https://careers.acme.com/o/frontend-engineer', city: 'Dubai', country: 'United Arab Emirates', remote: false, location: 'Dubai, United Arab Emirates', locations: [{ name: 'Dubai', city: 'Dubai', country: 'United Arab Emirates' }, { name: 'Remote in India', city: '', country: 'India' }], description: '<p>Build <b>React</b> apps</p>', requirements: '<ul><li>TypeScript</li></ul>', published_at: '2026-10-02 08:00:00 UTC' },
  { title: 'Full Stack Developer', careers_url: 'https://careers.acme.com/o/fs', url: 'http://acme.recruitee.com/o/fs', city: 'Pune', country: 'India', remote: true, description: '' },
  { title: 'Senior Marketer (Sample)', careers_url: 'https://acme.recruitee.com/o/sample', description: 'demo' },
] };

describe('normalizeRecruitee', () => {
  it('maps offers: numeric id, vendor URL, merged locations, description plus requirements, date; drops (Sample) postings', () => {
    const out = normalizeRecruitee(offers, rc);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 'rc:acme:4711', source: 'recruitee', title: 'Frontend Engineer', company: 'Acme',
      url: 'https://acme.recruitee.com/o/frontend-engineer', apply_url: 'https://acme.recruitee.com/o/frontend-engineer',
      description: 'Build React apps TypeScript', posted_at: '2026-10-02', locations: ['Dubai, United Arab Emirates', 'Remote in India, India'], remote: true,
    });
  });
  it('falls back to a hashed id and the tenant home page when id and slug are missing, and never keeps a custom-domain or http URL', () => {
    const [, j] = normalizeRecruitee(offers, rc);
    expect(j.id).toMatch(/^rc:acme:[0-9a-f]{12}$/);
    expect(j.url).toBe('https://acme.recruitee.com/');
    expect(j.apply_url).toBe('https://acme.recruitee.com/');
    expect(j.locations).toEqual(['Pune, India']);
    expect(j.remote).toBe(true);
    expect(normalizeRecruitee(offers, rc)[1].id).toBe(j.id);
  });
  it('rejects look-alike hosts and over-long ids, tolerates junk, applies the shared limits', () => {
    const bad = { offers: [{ id: 1, title: 'a', slug: 'x', careers_url: 'https://acme.recruitee.com.evil.io/o/x', url: 'https://evil-recruitee.com/x' }] };
    expect(normalizeRecruitee(bad, rc)[0].url).toBe('https://acme.recruitee.com/o/x');
    expect(normalizeRecruitee({ offers: [null, 5, { title: '' }, { id: 1 }] }, rc)).toEqual([]);
    expect(normalizeRecruitee(null, rc)).toEqual([]);
    expect(normalizeRecruitee({ offers: Array.from({ length: 100000 }, (_, i) => ({ id: i + 1, title: 't' })) }, rc)).toHaveLength(2000);
    const [j] = normalizeRecruitee({ offers: [{ id: 2, title: 'x'.repeat(10000), location: 'y'.repeat(5000), description: 'z'.repeat(50000) }] }, rc);
    expect([j.title.length, j.locations[0].length, j.description.length]).toEqual([300, 300, 8000]);
    expect(() => normalizeRecruitee(offers, { ...rc, slug: 'Acme' })).toThrow('invalid board slug');
    expect(() => normalizeRecruitee(offers, { ...rc, slug: 'a.evil.io' })).toThrow('invalid board slug');
  });
});

describe('fetchRecruitee', () => {
  it('calls the tenant host once, https, no redirects, and fails soft on a different shape', async () => {
    const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify(offers), { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await fetchRecruitee(rc)).toHaveLength(2);
    expect(f.mock.calls[0][0]).toBe('https://acme.recruitee.com/api/offers/');
    expect(f.mock.calls[0][1].redirect).toBe('error');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify([]), { status: 200 })));
    expect((await settleBoard(fetchRecruitee, rc)).error).toBe('recruitee acme: unexpected response shape (no offers array)');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('nope', { status: 404 })));
    expect((await settleBoard(fetchRecruitee, rc)).error).toBe('recruitee acme: HTTP 404');
    expect(FETCHERS.recruitee).toBe(fetchRecruitee);
  });
});

// Shape read from career-ops providers/personio.mjs; the jobDescriptions inner elements follow Personio's public XML (unverified here).
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>2560093</id>
    <office>Berlin</office>
    <additionalOffices><office>Remote</office><office>Berlin</office></additionalOffices>
    <name>Senior Frontend Engineer &amp; Lead (m/f/d)</name>
    <createdAt>2026-10-05T09:30:00+00:00</createdAt>
    <jobDescriptions>
      <jobDescription><name>Your role</name><value><![CDATA[<p>Build <b>React</b> apps &amp; more</p><p>literal </position> inside</p>]]></value></jobDescription>
      <jobDescription><name>Profile</name><value><![CDATA[<ul><li>TypeScript</li></ul>]]></value></jobDescription>
    </jobDescriptions>
  </position>
  <position><id>12x</id><name>Bad id</name></position>
  <position><id>77</id><name>Fullstack Developer</name><office>Munich</office></position>
  <position><id>78</id></position>
</workzag-jobs>`;

describe('normalizePersonioXml', () => {
  it('maps positions with built URLs, merged offices, date and a plain description (CDATA with a literal closing tag is safe)', () => {
    const out = normalizePersonioXml(feed, pe);
    expect(out).toEqual([
      { id: 'pe:acme:2560093', source: 'personio', title: 'Senior Frontend Engineer & Lead (m/f/d)', company: 'Acme GmbH', url: 'https://acme.jobs.personio.de/job/2560093', apply_url: 'https://acme.jobs.personio.de/job/2560093', description: 'Build React apps & more literal inside TypeScript', posted_at: '2026-10-05', locations: ['Berlin', 'Remote'], remote: true },
      { id: 'pe:acme:77', source: 'personio', title: 'Fullstack Developer', company: 'Acme GmbH', url: 'https://acme.jobs.personio.de/job/77', apply_url: 'https://acme.jobs.personio.de/job/77', description: '', locations: ['Munich'], remote: false },
    ]);
  });
  it('uses the .com host when configured, throws a labelled shape error, and rejects bad slugs', () => {
    expect(normalizePersonioXml(feed, { ...pe, domain: 'com' })[0].url).toBe('https://acme.jobs.personio.com/job/2560093');
    expect(() => normalizePersonioXml('<html><body>hi</body></html>', pe)).toThrow('personio acme: unexpected response shape (no workzag-jobs element)');
    expect(() => normalizePersonioXml(feed, { ...pe, slug: 'A_b' })).toThrow('invalid board slug');
    expect(normalizePersonioXml('<workzag-jobs></workzag-jobs>', pe)).toEqual([]);
  });
});

describe('fetchPersonio', () => {
  it('fetches the tenant xml host with an xml accept header; labelled errors for 404, bad XML and DOCTYPE', async () => {
    const f = vi.fn().mockImplementation(async () => new Response(feed, { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await fetchPersonio(pe)).toHaveLength(2);
    expect(f.mock.calls[0][0]).toBe('https://acme.jobs.personio.de/xml');
    expect(f.mock.calls[0][1].headers.Accept).toMatch(/xml/);
    expect(f.mock.calls[0][1].redirect).toBe('error');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('nope', { status: 404 })));
    expect((await settleBoard(fetchPersonio, pe)).error).toBe('personio acme: HTTP 404');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('<workzag-jobs><position>', { status: 200 })));
    expect((await settleBoard(fetchPersonio, pe)).error).toBe('personio acme: xml: unclosed element');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('<!DOCTYPE x [<!ENTITY a "b">]><workzag-jobs/>', { status: 200 })));
    expect((await settleBoard(fetchPersonio, pe)).error).toMatch(/^personio acme: xml: DOCTYPE/);
    expect(FETCHERS.personio).toBe(fetchPersonio);
  });
});
