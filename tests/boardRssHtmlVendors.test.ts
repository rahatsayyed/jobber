import { describe, it, expect, vi, afterEach } from 'vitest';
import { settleBoard } from '../src/sources/boards/greenhouse.js';
import { FETCHERS } from '../src/sources/boards/registry.js';
import { BOARD_PROVIDERS } from '../src/sources/boards/providers.js';
import { COMPANY_ATS, slugProblem, type TrackedCompany } from '../src/sources/boards/filters.js';
import { fetchTeamtailor, normalizeTeamtailorRss } from '../src/sources/boards/teamtailor.js';
import { extractEid, fetchJobvite, normalizeJobviteXml } from '../src/sources/boards/jobvite.js';
import { fetchIcims, parseIcimsPage } from '../src/sources/boards/icims.js';
import { fetchJazzhr, parseJazzhrList } from '../src/sources/boards/jazzhr.js';
import { fetchJoin, joinCompanyId, normalizeJoin } from '../src/sources/boards/join.js';
import { parseSoftgardenWidget, softgardenDate } from '../src/sources/boards/softgarden.js';
import { parseAvatureArticles } from '../src/sources/boards/avature.js';
import { parseAppliTrackOutput } from '../src/sources/boards/applitrack.js';
import { parseNeogovPage } from '../src/sources/boards/neogov.js';
import { parsePageupListing } from '../src/sources/boards/pageup.js';
import { eployTitle, parseEploySitemap } from '../src/sources/boards/eploy.js';
import { anchorsOf, jsonLdOf, mdyToIso } from '../src/sources/boards/htmlList.js';

afterEach(() => vi.unstubAllGlobals());
const co = (ats: string, slug = 'acme', extra: Record<string, unknown> = {}) => ({ name: 'Acme', ats, slug, enabled: true, ...extra }) as TrackedCompany;
const stub = (routes: Record<string, string | object>) => {
  const f = vi.fn().mockImplementation(async (url: string) => {
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    if (!hit) return new Response('nope', { status: 404 });
    return new Response(typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]), { status: 200 });
  });
  vi.stubGlobal('fetch', f);
  return f;
};

describe('registration', () => {
  it('every new vendor has a fetcher, a provider and a slug rule', () => {
    for (const v of ['teamtailor', 'jobvite', 'icims', 'jazzhr', 'join', 'softgarden', 'avature', 'applitrack', 'neogov', 'pageup', 'eploy'] as const) {
      expect((COMPANY_ATS as readonly string[]).includes(v), v).toBe(true);
      expect(FETCHERS[v], v).toBeTypeOf('function');
      expect(BOARD_PROVIDERS[v].id).toBe(v);
      expect(slugProblem(v, 'a.b'), v).toMatch(/^invalid slug/);
    }
    expect(slugProblem('pageup', '932')).toBeNull();
    expect(slugProblem('pageup', 'acme')).toMatch(/digits/);
    expect(slugProblem('teamtailor', 'Acme')).toMatch(/^invalid slug/);
    expect(slugProblem('jobvite', 'Acme_Corp-2')).toBeNull();
  });
});

describe('htmlList helpers', () => {
  it('anchors, ld+json and dates stay bounded and defensive', () => {
    expect(anchorsOf('<a href="/x">One</a><A HREF=\'/y\'>Two</A><a href="/z">open')).toEqual([expect.objectContaining({ href: '/x', inner: 'One' })]);
    expect(anchorsOf('<a ' + 'x'.repeat(5000) + '>t</a>')).toEqual([]);
    expect(jsonLdOf('<script type="application/ld+json">{"@graph":[{"a":1},{"b":2}]}</script><script type="application/ld+json">{bad</script>')).toHaveLength(3);
    expect(mdyToIso('10/2/2026')).toBe('2026-10-02');
    expect(mdyToIso('2/31/2026')).toBeUndefined();
  });
});

const rss = `<?xml version="1.0"?><rss xmlns:tt="https://teamtailor.com/locations" version="2.0"><channel>
<item><title>Full Stack Developer</title><link>https://acme.teamtailor.com/jobs/5551234-full-stack-developer</link><pubDate>Mon, 05 Oct 2026 09:30:00 +0000</pubDate>
<description><![CDATA[<p>Build <b>React</b> apps</p>]]></description><remoteStatus>none</remoteStatus>
<tt:locations><tt:location><tt:city>Pune</tt:city><tt:country>India</tt:country></tt:location></tt:locations></item>
<item><title>Remote Engineer</title><link>https://careers.acme.com/jobs/77-remote</link><remoteStatus>fully</remoteStatus></item>
<item><title></title><link>https://acme.teamtailor.com/jobs/1</link></item>
</channel></rss>`;

describe('teamtailor', () => {
  it('maps items, keeps only vendor-host links, remote status', () => {
    const out = normalizeTeamtailorRss(rss, co('teamtailor'));
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 'tt:acme:5551234', source: 'teamtailor', title: 'Full Stack Developer', company: 'Acme',
      url: 'https://acme.teamtailor.com/jobs/5551234-full-stack-developer', apply_url: 'https://acme.teamtailor.com/jobs/5551234-full-stack-developer',
      description: 'Build React apps', posted_at: '2026-10-05', locations: ['Pune, India'], remote: false,
    });
    expect(out[1].url).toBe('https://acme.teamtailor.com/jobs');
    expect(out[1].id).toMatch(/^tt:acme:[0-9a-f]{12}$/);
    expect(out[1].remote).toBe(true);
    expect(out[1].locations).toEqual(['Remote']);
  });
  it('fetches the tenant feed once and reports a wrong shape or slug', async () => {
    const f = stub({ 'https://acme.teamtailor.com/jobs.rss': rss });
    expect(await fetchTeamtailor(co('teamtailor'))).toHaveLength(2);
    expect(f.mock.calls[0][1].redirect).toBe('error');
    stub({ 'https://acme.teamtailor.com/jobs.rss': '<html/>' });
    expect((await settleBoard(fetchTeamtailor, co('teamtailor'))).error).toMatch(/^teamtailor acme: unexpected response shape/);
    expect((await settleBoard(fetchTeamtailor, co('teamtailor', 'a.evil.io'))).error).toMatch(/invalid board slug/);
  });
});

const jvBoard = `<html><script>var x = { companyEId: 'q6NaVfwI', other: 1 };</script></html>`;
const jvFeed = `<result>
<job><id>oAbC1</id><title>Senior React Engineer</title><location>Austin, TX</location><date>10/2/2026</date><detail-url><![CDATA[http://jobs.jobvite.com/acme/job/oAbC1]]></detail-url><apply-url>http://jobs.jobvite.com/acme/job/oAbC1/apply</apply-url><description><![CDATA[<p>Build UIs</p>]]></description></job>
<job><id>oAbC1</id><title>Senior React Engineer</title><location>Remote</location><date>10/2/2026</date><detail-url><![CDATA[http://jobs.jobvite.com/acme/job/oAbC1]]></detail-url></job>
<job><id>zz</id><title>Branded</title><location>X</location><detail-url>https://careers.acme.com/job/zz</detail-url></job>
</result>`;

describe('jobvite', () => {
  it('reads the eId from the board page and merges locations of rows that share a URL', () => {
    expect(extractEid(jvBoard)).toBe('q6NaVfwI');
    expect(extractEid('<html></html>')).toBeNull();
    const out = normalizeJobviteXml(jvFeed, co('jobvite'));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'jv:acme:oAbC1', url: 'https://jobs.jobvite.com/acme/job/oAbC1', description: 'Build UIs', posted_at: '2026-10-02', locations: ['Austin, TX', 'Remote'], remote: true });
    expect(out[1].url).toBe('https://jobs.jobvite.com/acme');
  });
  it('makes the two calls on the two pinned hosts', async () => {
    const f = stub({ 'https://jobs.jobvite.com/acme?fr=true&nl=1': jvBoard, 'https://app.jobvite.com/CompanyJobs/Xml.aspx?c=q6NaVfwI': jvFeed });
    expect(await fetchJobvite(co('jobvite'))).toHaveLength(2);
    expect(f).toHaveBeenCalledTimes(2);
    stub({ 'https://jobs.jobvite.com/acme': '<html>no id</html>' });
    expect((await settleBoard(fetchJobvite, co('jobvite'))).error).toMatch(/no companyEId/);
  });
});

const icimsPage = `<div class="iCIMS_JobCardItem"><a href="https://careers-acme.icims.com/jobs/1234/react-dev/job?in_iframe=1"><h3>React &amp; Node Developer</h3></a>
<div><span class="field-label">Location</span><span>US-NY-New York</span></div></div>
<div class="iCIMS_JobCardItem"><a href="https://evil.example/jobs/9/x/job"><h3>Evil</h3></a></div>
<div class="iCIMS_JobCardItem"><a href="/jobs/55/second/job"><h3>Second</h3></a></div>`;

describe('icims', () => {
  it('parses cards, drops other hosts, keeps the clean job URL', () => {
    const rows = parseIcimsPage(icimsPage, 'careers-acme.icims.com');
    expect(rows).toEqual([
      { title: 'React & Node Developer', url: 'https://careers-acme.icims.com/jobs/1234/react-dev/job', id: '1234', location: 'US-NY-New York' },
      { title: 'Second', url: 'https://careers-acme.icims.com/jobs/55/second/job', id: '55', location: '' },
    ]);
  });
  it('pages until an empty page', async () => {
    const f = vi.fn().mockImplementation(async (url: string) => new Response(url.includes('pr=0') ? icimsPage : '<html></html>', { status: 200 }));
    vi.stubGlobal('fetch', f);
    const out = await fetchIcims(co('icims', 'careers-acme'));
    expect(out.map((j) => j.id)).toEqual(['ic:careers-acme:1234', 'ic:careers-acme:55']);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

const jazz = `<ul><li class="list-group-item"><h4><a href="https://acme.applytojob.com/apply/AbCdEf1234/Full-Stack-Dev?source=x">Full Stack Dev</a></h4>
<ul><li><i class="fa fa-map-marker"></i> Austin, TX</li></ul></li>
<li class="list-group-item"><a href="/apply/ZyXwVu9876/Designer">Designer</a></li>
<li><a href="https://other.applytojob.com/apply/QqQqQq1111/x">Other tenant</a></li></ul>`;

describe('jazzhr', () => {
  it('parses cards on the tenant host only', () => {
    const rows = parseJazzhrList(jazz, 'acme.applytojob.com');
    expect(rows).toEqual([
      { id: 'AbCdEf1234', title: 'Full Stack Dev', url: 'https://acme.applytojob.com/apply/AbCdEf1234/Full-Stack-Dev', location: 'Austin, TX' },
      { id: 'ZyXwVu9876', title: 'Designer', url: 'https://acme.applytojob.com/apply/ZyXwVu9876/Designer', location: '' },
    ]);
  });
  it('an empty board is empty, posting links with no readable title are a markup error', async () => {
    expect(parseJazzhrList('<html>No openings</html>', 'acme.applytojob.com')).toEqual([]);
    expect(() => parseJazzhrList('<a href="/apply/AbCdEf1234/x"><img src="a.png"></a>', 'acme.applytojob.com')).toThrow('markup changed');
    stub({ 'https://acme.applytojob.com/apply': jazz });
    expect(await fetchJazzhr(co('jazzhr'))).toHaveLength(2);
  });
});

const joinPage = `<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"pageData":{"company":{"id":4242}}}}}</script></html>`;
const joinItems = [
  { id: 901, title: 'React Developer', createdAt: '2026-10-03T10:00:00Z', descriptionHtml: '<p>Build <b>things</b></p>', workplaceType: 'REMOTE', remoteType: 'ANYWHERE', city: { cityName: 'Berlin', countryName: 'Germany' } },
  { id: 902, title: 'Backend Dev', workplaceType: 'HYBRID', city: { cityName: 'Pune', countryName: 'India' }, country: { name: 'India' } },
  { id: 'x', title: 'Bad id' },
];

describe('join', () => {
  it('reads the company id and maps GraphQL items', () => {
    expect(joinCompanyId(joinPage)).toBe(4242);
    expect(joinCompanyId('<html></html>')).toBeNull();
    const out = normalizeJoin(joinItems, co('join'));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'jn:acme:901', url: 'https://join.com/companies/acme/901', description: 'Build things', posted_at: '2026-10-03', locations: ['Remote (worldwide)'], remote: true });
    expect(out[1].locations).toEqual(['Pune, India (hybrid)']);
  });
  it('POSTs the persisted query to join.com and follows pageCount', async () => {
    const f = vi.fn().mockImplementation(async (url: string, init: any) => {
      if (url === 'https://join.com/companies/acme') return new Response(joinPage, { status: 200 });
      expect(url).toBe('https://join.com/candidate-api/graphql');
      expect(JSON.parse(init.body).variables.input.companyId).toBe(4242);
      return new Response(JSON.stringify({ data: { publicJobs: { items: joinItems, pageInfo: { pageCount: 1 } } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', f);
    expect(await fetchJoin(co('join'))).toHaveLength(2);
    expect(f).toHaveBeenCalledTimes(2);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => (url.endsWith('graphql') ? new Response(JSON.stringify({ errors: [{ message: 'Too many requests' }] }), { status: 200 }) : new Response(joinPage, { status: 200 }))));
    expect((await settleBoard(fetchJoin, co('join'))).error).toBe('join acme: Too many requests');
  });
});

describe('softgarden', () => {
  const widget = `<div class="matchElement" id="job_id_123"><a href="/de/job/123/Frontend-Dev" class="x">Frontend <b>Dev</b></a>
<span class="location-view-item">Berlin</span><span class="location-view-item">Berlin</span><span class="location-view-item">Remote</span><div class="matchValue date">05.10.2026</div></div>
<div class="matchElement" id="job_id_124"><a href="https://evil.example/job/124/x">Evil</a></div>`;
  it('parses widget blocks and dates', () => {
    expect(parseSoftgardenWidget(widget, 'acme.softgarden.io', 'https://acme.softgarden.io/de/widgets/jobs')).toEqual([
      { id: '123', title: 'Frontend Dev', url: 'https://acme.softgarden.io/de/job/123/Frontend-Dev', locations: ['Berlin', 'Remote'], posted: '2026-10-05' },
    ]);
    expect(softgardenDate('10/5/2026')).toBe('2026-10-05');
    expect(softgardenDate('31.02.2026')).toBeUndefined();
  });
});

describe('avature', () => {
  const html = `<article class="article article--result"><h3 class="article__header__text__title"><a href="/careers/JobDetail/Dev/4711">Software Engineer</a></h3>
<span class="list-item-location">Dublin, Ireland</span><p>Posted 05-Oct-2026</p></article><article class="other"><a href="/careers/JobDetail/Skip/1">Skip</a></article>`;
  it('parses result articles only', () => {
    const { rows, cards } = parseAvatureArticles(html, 'acme.avature.net', 'https://acme.avature.net/careers/SearchJobs');
    expect(cards).toBe(1);
    expect(rows).toEqual([{ id: '4711', title: 'Software Engineer', url: 'https://acme.avature.net/careers/JobDetail/Dev/4711', location: 'Dublin, Ireland', posted: '2026-10-05' }]);
  });
});

describe('applitrack', () => {
  const body = `function applyFor(){} document.write('<table class=\\'title\\' x><tr><td id=\\'wrapword\\'>Math Teacher</td></tr></table> JobID: 4455 <span>Location:</span> <span class=\\'normal\\'>High School</span> Date Posted: </span><span class=\\'normal\\'>10/2/2026</span>');`;
  it('parses the Output.asp script and refuses anything else', () => {
    expect(parseAppliTrackOutput(body)).toEqual([{ id: '4455', title: 'Math Teacher', location: 'High School', posted: '2026-10-02' }]);
    expect(() => parseAppliTrackOutput('<html></html>')).toThrow('applyFor');
  });
});

describe('neogov', () => {
  const page = `<ul><li class="list-item"><a class="item-details-link" href="/careers/acme/jobs/3300001/web-developer?pagetype=x">Web Developer</a><ul class="list-meta"><li>Remote, CA</li></ul></li>
<li class="list-item"><a class="item-details-link" href="https://evil.example/careers/a/jobs/1/x">Evil</a></li></ul>`;
  it('parses list items and tells empty from foreign', () => {
    expect(parseNeogovPage(page)).toEqual([{ id: '3300001', title: 'Web Developer', url: 'https://www.schooljobs.com/careers/acme/jobs/3300001/web-developer', location: 'Remote, CA' }]);
    expect(parseNeogovPage('<div class="jobs-not-found-container"></div>')).toEqual([]);
    expect(() => parseNeogovPage('<html>login</html>')).toThrow('not a NEOGOV job list');
  });
});

describe('pageup', () => {
  const html = `<table><tbody id="search-results-content"><tr><td><a class="job-link" href="/932/cw/en/job/501/web-dev">Web Developer</a></td></tr>
<tr><td><a class="job-link" href="/111/cw/en/job/502/other-tenant">Other</a></td></tr></tbody></table><a class="more-link" href="?page=2">more</a>`;
  it('parses job links of the tenant and site', () => {
    const r = parsePageupListing(html, '932', 'cw');
    expect(r.rows).toEqual([{ id: '501', title: 'Web Developer', url: 'https://careers.pageuppeople.com/932/cw/en/job/501' }]);
    expect(r.hasMore).toBe(true);
    expect(() => parsePageupListing('<html>login</html>', '932', 'cw')).toThrow('no search-results table');
  });
});

describe('eploy', () => {
  const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://acme.eploy.net/vacancies/812/senior-react-developer--uk.html</loc></url>
<url><loc>https://evil.example/vacancies/813/x.html</loc></url><url><loc>https://acme.eploy.net/about.html</loc></url></urlset>`;
  it('rebuilds titles from the URL slug', () => {
    expect(eployTitle('senior-react-developer--uk')).toBe('Senior React Developer - UK');
    expect(parseEploySitemap(xml, 'acme.eploy.net')).toEqual([{ id: '812', title: 'Senior React Developer - UK', url: 'https://acme.eploy.net/vacancies/812/senior-react-developer--uk.html' }]);
    expect(() => parseEploySitemap('<html/>', 'acme.eploy.net')).toThrow('no urlset');
  });
});
