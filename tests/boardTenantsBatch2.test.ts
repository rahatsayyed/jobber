import { describe, it, expect, vi, afterEach } from 'vitest';
import { FETCHERS } from '../src/sources/boards/registry.js';
import { BOARD_PROVIDERS } from '../src/sources/boards/providers.js';
import { COMPANY_ATS, extraConfigProblem, slugProblem, type TrackedCompany } from '../src/sources/boards/filters.js';
import { vendorParamsProblem } from '../src/sources/boards/vendorParams.js';
import { portalIdOf } from '../src/sources/boards/taleo.js';
import { sfDate } from '../src/sources/boards/successfactors.js';
import { checkShape } from '../src/sources/shape.js';

// Fixtures follow the field names that career-ops providers/<vendor>.mjs reads (synthetic values, no network). Stability: fixture/unverified.
afterEach(() => vi.unstubAllGlobals());
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const co = (ats: string, slug = 'acme', params?: Record<string, string>): TrackedCompany => ({ name: 'Acme', ats, slug, enabled: true, ...(params ? { params } : {}) } as TrackedCompany);

function stub(respond: (url: string, init: any) => Response) {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    expect(init.redirect).toBe('error');
    return respond(String(url), init);
  }));
  return calls;
}

describe('bamboohr', () => {
  it('lists, details the wanted postings, builds the tenant URL and keeps the date', async () => {
    const calls = stub((u) => (u.endsWith('/careers/list')
      ? json({ result: [{ id: '12', jobOpeningName: 'React Developer', location: { city: 'Pune', state: 'MH' }, isRemote: true }, { id: 'bad/id', jobOpeningName: 'x' }] })
      : json({ result: { jobOpening: { datePosted: '2026-10-03', description: '<p>Build <b>UI</b></p>' } } })));
    const jobs = await FETCHERS.bamboohr(co('bamboohr'), {});
    expect(calls.map((c) => c.url)).toEqual(['https://acme.bamboohr.com/careers/list', 'https://acme.bamboohr.com/careers/12/detail']);
    expect(jobs).toEqual([{
      id: 'bh:acme:12', source: 'bamboohr', title: 'React Developer', company: 'Acme', url: 'https://acme.bamboohr.com/careers/12', apply_url: 'https://acme.bamboohr.com/careers/12',
      description: 'Build UI', posted_at: '2026-10-03', locations: ['Pune, MH, Remote'], remote: true,
    }]);
  });
  it('prefilter and isKnown skip the detail request; a failed detail still returns the posting', async () => {
    const calls = stub((u) => (u.endsWith('/list') ? json({ result: [{ id: '1', jobOpeningName: 'Chef' }, { id: '2', jobOpeningName: 'Dev' }] }) : json({}, 500)));
    const warn = vi.fn();
    const jobs = await FETCHERS.bamboohr(co('bamboohr'), { titleOk: (t) => t === 'Dev', warn });
    expect(calls.map((c) => c.url)).toEqual(['https://acme.bamboohr.com/careers/list', 'https://acme.bamboohr.com/careers/2/detail']);
    expect(jobs.map((j) => j.id)).toEqual(['bh:acme:2']);
    expect(warn).toHaveBeenCalled();
  });
  it('rejects an unexpected shape and a bad slug', async () => {
    stub(() => json({ nope: 1 }));
    await expect(FETCHERS.bamboohr(co('bamboohr'), {})).rejects.toThrow(/unexpected response shape/);
    await expect(FETCHERS.bamboohr(co('bamboohr', 'A.b'), {})).rejects.toThrow(/invalid board slug/);
  });
});

describe('breezy', () => {
  it('maps name, url, location and date; drops rows with a foreign or non-https URL', async () => {
    stub(() => json([
      { name: 'Frontend Engineer', url: 'https://acme.breezy.hr/p/abc123-frontend', published_date: '2026-10-05T10:00:00.000Z', location: { name: 'Dubai', country: { name: 'United Arab Emirates' }, is_remote: false } },
      { name: 'Evil', url: 'https://evil.example/p/1' },
      { name: 'Http', url: 'http://acme.breezy.hr/p/2' },
    ]));
    const jobs = await FETCHERS.breezy(co('breezy'), {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ source: 'breezy', title: 'Frontend Engineer', url: 'https://acme.breezy.hr/p/abc123-frontend', posted_at: '2026-10-05', locations: ['Dubai, United Arab Emirates'], remote: false });
    expect(jobs[0].id).toMatch(/^bz:acme:[0-9a-f]{12}$/);
  });
  it('rejects a non-array answer', async () => {
    stub(() => json({ error: 1 }));
    await expect(FETCHERS.breezy(co('breezy'), {})).rejects.toThrow(/not an array/);
  });
});

describe('pinpoint', () => {
  it('reads data[], drops the demo postings and keeps the vendor URL', async () => {
    stub(() => json({ data: [
      { id: '7', title: 'Full Stack Dev', url: 'https://acme.pinpointhq.com/postings/7', location: { city: 'Berlin', province: 'BE' }, description: '<p>React</p>' },
      { id: '8', title: 'Demo', url: 'https://acme.pinpointhq.com/postings/8', description: 'x youtube.com/embed/pFxm6fszrpw x' },
      { id: '9', title: 'Elsewhere', url: 'https://evil.example/9' },
    ] }));
    const jobs = await FETCHERS.pinpoint(co('pinpoint'), {});
    expect(jobs.map((j) => [j.id, j.url, j.description, j.locations])).toEqual([['pp:acme:7', 'https://acme.pinpointhq.com/postings/7', 'React', ['Berlin, BE']]]);
  });
});

describe('gem', () => {
  it('posts the batch list query, then one batched detail query, and builds the board URL', async () => {
    const calls = stub((_u, init) => {
      const ops = JSON.parse(init.body);
      expect(init.method).toBe('POST');
      expect(init.headers.batch).toBe('true');
      if (ops[0].operationName === 'JobBoardList') {
        return json([{ data: { oatsExternalJobPostings: { jobPostings: [
          { id: 'p1', extId: 'ext1', title: 'React Engineer', locations: [{ name: 'Remote', isoCountry: 'IN', isRemote: true }], job: { locationType: 'Remote' } },
        ] } } }]);
      }
      return json([{ data: { oatsExternalJobPosting: { extId: 'ext1', firstPublishedTsSec: 1790000000, descriptionHtml: '<p>Body</p>', jobPostSectionHtml: { introHtml: '<p>Intro</p>', outroHtml: '<p>Outro</p>' }, compensationHtml: '<p>10k</p>' } } }]);
    });
    const jobs = await FETCHERS.gem(co('gem', 'acme-board'), {});
    expect(calls.map((c) => c.url)).toEqual(Array(2).fill('https://jobs.gem.com/api/public/graphql/batch'));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'gm:acme-board:ext1', url: 'https://jobs.gem.com/acme-board/ext1', description: 'Intro Body Outro Compensation: 10k', remote: true });
    expect(jobs[0].posted_at).toMatch(/^2026-/);
    expect(jobs[0].locations[0]).toContain('India');
  });
  it('still returns the listing when the detail request fails', async () => {
    let n = 0;
    stub(() => (n++ === 0 ? json([{ data: { oatsExternalJobPostings: { jobPostings: [{ extId: 'e1', title: 'Dev' }] } } }]) : json({}, 500)));
    const jobs = await FETCHERS.gem(co('gem'), {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toBe('');
  });
});

describe('comeet', () => {
  const params = { uid: '41.00B', token: 'TOKEN123' };
  it('uses uid and token from params, keeps only comeet.co URLs and never puts the token in an error', async () => {
    const calls = stub(() => json([
      { uid: 'A1.B2', name: 'Frontend Dev', location: { name: 'Tel Aviv', is_remote: true }, url_active_page: 'https://acme.com/careers/x', url_comeet_hosted_page: 'https://www.comeet.co/jobs/acme/41.00B/frontend/A1.B2', time_updated: '2026-10-01T00:00:00Z', details: [{ value: '<p>Do things</p>' }] },
      { uid: 'C3', name: 'Only company page', url_active_page: 'https://acme.com/careers/y' },
    ]));
    const jobs = await FETCHERS.comeet(co('comeet', 'acme', params), {});
    expect(calls[0].url).toBe('https://www.comeet.co/careers-api/2.0/company/41.00B/positions?token=TOKEN123');
    expect(jobs[0]).toMatchObject({ id: 'cm:acme:A1.B2', url: 'https://www.comeet.co/jobs/acme/41.00B/frontend/A1.B2', description: 'Do things', posted_at: '2026-10-01', locations: ['Tel Aviv'],remote: true });
    expect(jobs[1].url).toBe('https://www.comeet.co/jobs/acme/41.00B');
    stub(() => json({}, 500));
    await expect(FETCHERS.comeet(co('comeet', 'acme', params), {})).rejects.toThrow(/HTTP 500/);
    await FETCHERS.comeet(co('comeet', 'acme', params), {}).catch((e) => expect(String(e.message)).not.toContain('TOKEN123'));
    await expect(FETCHERS.comeet(co('comeet'), {})).rejects.toThrow(/needs params/);
  });
});

describe('eightfold', () => {
  const params = { domain: 'acme.com' };
  it('pages v2 until a short page and falls back to the vendor URL for a foreign canonical URL', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 100 + i, name: `Role ${i}`, location: 'Pune, India', canonicalPositionUrl: i === 0 ? 'https://acme.com/careers/x' : `https://acme.eightfold.ai/careers/job/${100 + i}`, t_create: 1790000000 }));
    const calls = stub((u) => json({ positions: u.includes('start=0') ? page(10) : page(3), count: 13 }));
    const jobs = await FETCHERS.eightfold(co('eightfold', 'acme', params), {});
    expect(calls.map((c) => c.url)).toEqual([
      'https://acme.eightfold.ai/api/apply/v2/jobs?domain=acme.com&start=0&num=10', 'https://acme.eightfold.ai/api/apply/v2/jobs?domain=acme.com&start=10&num=10']);
    expect(jobs).toHaveLength(10);
    expect(jobs[0].url).toBe('https://acme.eightfold.ai/careers?pid=100&domain=acme.com');
    expect(jobs[1].url).toBe('https://acme.eightfold.ai/careers/job/101');
  });
  it('switches to pcsx once when v2 answers 403', async () => {
    const calls = stub((u) => (u.includes('/apply/v2/') ? json({}, 403) : json({ data: { count: 1, positions: [{ id: 5, name: 'Dev', postedTs: 1790000000 }] } })));
    const jobs = await FETCHERS.eightfold(co('eightfold', 'acme', params), {});
    expect(calls.map((c) => c.url.split('?')[0])).toEqual(['https://acme.eightfold.ai/api/apply/v2/jobs', 'https://acme.eightfold.ai/api/pcsx/search']);
    expect(jobs.map((j) => j.id)).toEqual(['ef:acme:5']);
  });
});

describe('oraclecloud', () => {
  const params = { host: 'abc.fa.us2.oraclecloud.com', site: 'CX_2001' };
  it('requests the finder URL and builds the candidate-experience URL', async () => {
    const calls = stub(() => json({ items: [{ TotalJobsCount: 2, requisitionList: [
      { Id: '1001', Title: 'Frontend Engineer', PrimaryLocation: 'Bengaluru, India', WorkplaceTypeCode: 'ORA_REMOTE', ShortDescriptionStr: 'Build &amp; ship', PostedDate: '2026-10-06' },
      { Id: '1002', Title: 'Backend', ExternalURL: 'https://evil.example/j', workLocation: [{ TownOrCity: 'Pune', Region: 'MH', Country: 'IN' }] },
    ] }] }));
    const jobs = await FETCHERS.oraclecloud(co('oraclecloud', 'acme', params), {});
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('https://abc.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true');
    expect(calls[0].url).toContain('finder=findReqs;siteNumber=CX_2001,facetsList=');
    expect(jobs[0]).toMatchObject({ id: 'oc:acme:1001', url: 'https://abc.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2001/job/1001', posted_at: '2026-10-06', remote: true, locations: ['Bengaluru, India, Remote'] });
    expect(jobs[0].description).toContain('Build');
    expect(jobs[1].url).toBe('https://abc.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2001/job/1002');
  });
});

describe('successfactors', () => {
  it('posts the CSB search per page and builds the job URL', async () => {
    const calls = stub((_u, init) => {
      expect(JSON.parse(init.body)).toMatchObject({ keywords: '', locale: 'en_US', sortBy: 'date' });
      return json({ totalJobs: 1, jobSearchResult: [{ response: { id: 555, unifiedStandardTitle: 'React Developer', unifiedUrlTitle: 'React-Developer', jobLocationShort: ['Pune, IN', 'Remote'], unifiedStandardStart: '10/25/2026' } }] });
    });
    const jobs = await FETCHERS.successfactors(co('successfactors', 'acme', { host: 'career5.successfactors.eu' }), {});
    expect(calls[0].url).toBe('https://career5.successfactors.eu/services/recruiting/v1/jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'sf:acme:555', url: 'https://career5.successfactors.eu/job/react-developer/555-en_US', posted_at: '2026-10-25', locations: ['Pune, IN / Remote'], remote: true });
  });
  it('reads only unambiguous dates', () => {
    expect(sfDate('2026-10-02T00:00:00Z')).toBe('2026-10-02T00:00:00Z');
    expect(sfDate('25.10.2026')).toBe('2026-10-25');
    expect(sfDate('03/04/2026')).toBeUndefined();
  });
});

describe('taleo', () => {
  const params = { section: 'ex' };
  it('reads the portal id from the shell, posts the search and maps the columns', async () => {
    const calls = stub((u, init) => {
      if (u.endsWith('jobsearch.ftl')) return new Response('<html><input type="hidden" name="portal" value="4321"></html>', { status: 200 });
      expect(JSON.parse(init.body).pageNo).toBe(1);
      expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
      return json({ pagingData: { totalCount: 1 }, requisitionList: [{ contestNo: '77', column: ['Software Engineer', '["Pune","Remote"]', 'Oct 7, 2026'] }] });
    });
    const jobs = await FETCHERS.taleo(co('taleo', 'acme', params), {});
    expect(calls.map((c) => c.url)).toEqual(['https://acme.taleo.net/careersection/ex/jobsearch.ftl', 'https://acme.taleo.net/careersection/rest/jobboard/searchjobs?lang=en&portal=4321']);
    expect(jobs[0]).toMatchObject({ id: 'tl:acme:77', url: 'https://acme.taleo.net/careersection/ex/jobdetail.ftl?job=77&lang=en', locations: ['Pune; Remote'], remote: true });
  });
  it('finds a portal id in several spellings and fails without one', () => {
    expect(portalIdOf('x?portal=12&y')).toBe('12');
    expect(portalIdOf('{"portalId": "34"}')).toBe('34');
    expect(portalIdOf('nothing')).toBeNull();
  });
  it('refuses Business Edition', async () => {
    await expect(FETCHERS.taleo(co('taleo', 'tre', params), {})).rejects.toThrow(/Business Edition/);
  });
});

describe('ultipro', () => {
  it('posts LoadSearchResults with the paging body and maps opportunities', async () => {
    const calls = stub((_u, init) => {
      const b = JSON.parse(init.body);
      expect(b.opportunitySearch).toMatchObject({ Top: 50, Skip: 0 });
      return json({ totalCount: 1, opportunities: [{ Id: 'ab-12', Title: 'Frontend Developer', PostedDate: '2026-10-08T00:00:00Z', BriefDescription: '<p>Short</p>', Locations: [{ Address: { City: 'Austin', State: { Code: 'TX' } } }] }] });
    });
    const jobs = await FETCHERS.ultipro(co('ultipro', 'ABC1234', { board: '11111111-2222-3333-4444-555555555555' }), {});
    expect(calls[0].url).toBe('https://recruiting.ultipro.com/ABC1234/JobBoard/11111111-2222-3333-4444-555555555555/JobBoardView/LoadSearchResults');
    expect(jobs[0]).toMatchObject({ id: 'up:ABC1234:ab-12', description: 'Short', posted_at: '2026-10-08', locations: ['Austin, TX'] });
    expect(jobs[0].url).toBe('https://recruiting.ultipro.com/ABC1234/JobBoard/11111111-2222-3333-4444-555555555555/OpportunityDetail?opportunityId=ab-12');
  });
});

describe('config validation for the batch-2 vendors', () => {
  it('registers every vendor in COMPANY_ATS, the fetchers and the providers', () => {
    for (const v of ['bamboohr', 'breezy', 'pinpoint', 'gem', 'comeet', 'eightfold', 'oraclecloud', 'successfactors', 'taleo', 'ultipro']) {
      expect(COMPANY_ATS).toContain(v);
      expect(typeof (FETCHERS as any)[v]).toBe('function');
      expect(BOARD_PROVIDERS[v as keyof typeof BOARD_PROVIDERS].id).toBe(v);
    }
  });
  it('host-label vendors take only lowercase labels, token vendors allow upper case', () => {
    for (const v of ['bamboohr', 'breezy', 'pinpoint', 'eightfold', 'taleo']) {
      expect(slugProblem(v, 'acme-1')).toBeNull();
      for (const bad of ['Acme', 'a.b', 'a_b', '-a']) expect(slugProblem(v, bad)).toMatch(/^invalid slug/);
    }
    for (const v of ['gem', 'comeet', 'oraclecloud', 'successfactors', 'ultipro']) {
      expect(slugProblem(v, 'Acme_1-x')).toBeNull();
      expect(slugProblem(v, 'a.b')).toMatch(/^invalid slug/);
    }
  });
  it('params are required where the endpoint needs them and strictly patterned', () => {
    expect(extraConfigProblem({ ats: 'eightfold' })).toMatch(/params\.domain/);
    expect(extraConfigProblem({ ats: 'eightfold', params: { domain: 'acme.com' } })).toBeNull();
    expect(extraConfigProblem({ ats: 'eightfold', params: { domain: 'acme.com/x' } })).toMatch(/params\.domain/);
    expect(extraConfigProblem({ ats: 'oraclecloud', params: { host: 'evil.example.com' } })).toMatch(/params\.host/);
    expect(extraConfigProblem({ ats: 'oraclecloud', params: { host: 'abc.fa.us2.oraclecloud.com' } })).toBeNull();
    expect(extraConfigProblem({ ats: 'successfactors', params: { host: 'career5.successfactors.eu' } })).toBeNull();
    expect(extraConfigProblem({ ats: 'successfactors', params: { host: 'evil.com' } })).toMatch(/params\.host/);
    expect(extraConfigProblem({ ats: 'ultipro', params: { board: 'x', host: 'recruiting2.ultipro.ca' } })).toBeNull();
    expect(extraConfigProblem({ ats: 'ultipro', params: { board: 'x', host: 'recruiting.evil.com' } })).toMatch(/params\.host/);
    expect(extraConfigProblem({ ats: 'taleo', params: { section: '../x' } })).toMatch(/params\.section/);
    expect(extraConfigProblem({ ats: 'comeet', params: { uid: '41.00B' } })).toMatch(/params\.token/);
    expect(extraConfigProblem({ ats: 'bamboohr' })).toBeNull();
    expect(extraConfigProblem({ ats: 'bamboohr', params: { x: 'y' } })).toMatch(/takes no params/);
    expect(vendorParamsProblem('gem', 'nope')).toMatch(/takes no params/);
    expect(vendorParamsProblem('taleo', { section: 'ex', other: '1' })).toMatch(/unknown param/);
  });
  it('every provider shapeSpec accepts its fixture item', () => {
    const items: Record<string, unknown> = {
      bamboohr: { id: '1', jobOpeningName: 'a' }, breezy: { name: 'a', url: 'https://a.breezy.hr/p/1' }, pinpoint: { title: 'a' }, gem: { extId: 'e', title: 'a' },
      comeet: { name: 'a' }, eightfold: { name: 'a' }, oraclecloud: { Id: '1', Title: 'a' }, successfactors: { response: { id: 1 } }, taleo: { column: ['a'] }, ultipro: { Id: 1, Title: 'a' },
    };
    for (const [v, item] of Object.entries(items)) expect(checkShape(BOARD_PROVIDERS[v as keyof typeof BOARD_PROVIDERS].shapeSpec, [item]).ok, v).toBe(true);
    expect(checkShape(BOARD_PROVIDERS.bamboohr.shapeSpec, [{ id: '1', title: 'renamed' }]).ok).toBe(false);
  });
});
