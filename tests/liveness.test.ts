import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyLiveness, checkLiveness, isSafeFetchUrl } from '../src/liveness.js';
import { vetoResults } from '../src/vetoes.js';

const base = { status: 200, requestedUrl: 'https://x.com/jobs/123456', finalUrl: 'https://x.com/jobs/123456' };
const body = (t: string) => ({ ...base, bodyText: t.padEnd(400, ' filler') });

describe('classifyLiveness', () => {
  it('404 and 410 are expired', () => {
    expect(classifyLiveness({ ...base, status: 404, bodyText: '' })).toBe('expired');
    expect(classifyLiveness({ ...base, status: 410, bodyText: '' })).toBe('expired');
  });
  it('403, 429, 503 and anti-bot pages are uncertain, never expired', () => {
    expect(classifyLiveness({ ...base, status: 403, bodyText: '' })).toBe('uncertain');
    expect(classifyLiveness(body('Just a moment... verify you are human'))).toBe('uncertain');
  });
  it('hard-expired phrases are expired', () => {
    expect(classifyLiveness(body('This job is no longer available'))).toBe('expired');
    expect(classifyLiveness(body('The position has been filled'))).toBe('expired');
  });
  it('ignores a conditional phrase on a live page', () => {
    expect(classifyLiveness(body('We will close this listing until the position has been filled. Apply now'))).not.toBe('expired');
  });
  it('a redirect that drops the job id is uncertain', () => {
    expect(classifyLiveness({ ...body('Browse all open roles'), finalUrl: 'https://x.com/careers' })).toBe('uncertain');
  });
  it('a live page with an apply control is active', () => {
    expect(classifyLiveness(body('Senior Dev. Apply now'))).toBe('active');
  });
  it('a tiny body with no hard-expired phrase is uncertain, never expired', () => {
    expect(classifyLiveness({ ...base, bodyText: 'ok' })).toBe('uncertain');
    expect(classifyLiveness({ ...base, bodyText: '<div id="root"></div>' })).toBe('uncertain');
  });
  it('a short body with a hard-expired phrase is still expired', () => {
    expect(classifyLiveness({ ...base, bodyText: 'Job no longer available' })).toBe('expired');
  });
});

describe('isSafeFetchUrl', () => {
  it.each(['https://x.com/jobs/1', 'http://x.com/jobs/1', 'http://172.32.0.1/x', 'http://172.15.0.1/x'])('allows %s', (u) => {
    expect(isSafeFetchUrl(u)).toBe(true);
  });
  it.each([
    'file:///etc/passwd', 'ftp://x.com/a', 'http://localhost/x', 'http://127.0.0.1/x', 'http://169.254.169.254/latest',
    'http://10.1.2.3/x', 'http://192.168.1.1/x', 'http://172.16.0.1/x', 'http://172.31.255.1/x', 'http://[::1]/x',
    'http://0.0.0.0/x', 'http://printer.local/x', 'http://svc.internal/x', 'not a url', '',
  ])('refuses %s', (u) => {
    expect(isSafeFetchUrl(u)).toBe(false);
  });
});

describe('checkLiveness', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('404 response is expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404, url: 'https://x.com/jobs/123456', text: async () => '' }));
    expect(await checkLiveness('https://x.com/jobs/123456')).toBe('expired');
  });
  it('a non-public url is uncertain and never fetched', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await checkLiveness('http://127.0.0.1/x')).toBe('uncertain');
    expect(f).toHaveBeenCalledTimes(0);
  });
  it('a thrown error is uncertain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    expect(await checkLiveness('https://x.com/jobs/123456')).toBe('uncertain');
  });
  it('a redirect to a private host is uncertain and the second fetch is never made', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }));
    vi.stubGlobal('fetch', f);
    expect(await checkLiveness('https://x.com/jobs/123456')).toBe('uncertain');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('follows a redirect chain (relative Location) to a safe host and classifies the final page', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/jobs/123456/' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://y.com/jobs/123456/view' } }))
      .mockResolvedValueOnce(new Response('<button>Apply now</button>', { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await checkLiveness('https://x.com/old/123456')).toBe('active');
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      'https://x.com/old/123456', 'https://x.com/jobs/123456/', 'https://y.com/jobs/123456/view',
    ]);
    expect(f.mock.calls.every((c) => c[1].redirect === 'manual')).toBe(true);
  });
  it('cancels the body of each 3xx hop before following it', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const redirect = { status: 302, headers: new Headers({ location: 'https://x.com/jobs/123456/' }), body: { cancel } };
    const f = vi.fn()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(new Response('<button>Apply now</button>', { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await checkLiveness('https://x.com/jobs/123456')).toBe('active');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('a throwing body cancel does not break redirect following', async () => {
    const redirect = {
      status: 302, headers: new Headers({ location: 'https://x.com/jobs/123456/' }),
      body: { cancel: () => { throw new Error('boom'); } },
    };
    const f = vi.fn()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(new Response('<button>Apply now</button>', { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await checkLiveness('https://x.com/jobs/123456')).toBe('active');
  });
  it('gives up (uncertain) after more than 5 redirects', async () => {
    const f = vi.fn().mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://x.com/loop' } }));
    vi.stubGlobal('fetch', f);
    expect(await checkLiveness('https://x.com/start')).toBe('uncertain');
    expect(f).toHaveBeenCalledTimes(6);
  });
  it('truncates the body at 200 KB but still classifies the readable part', async () => {
    const body = 'Apply now ' + 'x'.repeat(300 * 1024) + ' this job has expired';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    expect(await checkLiveness('https://x.com/careers')).toBe('active');
  });
  it('sends a browser-like User-Agent', async () => {
    const f = vi.fn().mockResolvedValue(new Response('Apply now', { status: 200 }));
    vi.stubGlobal('fetch', f);
    await checkLiveness('https://x.com/careers');
    expect(f.mock.calls[0][1].headers['User-Agent']).toMatch(/^Mozilla\/5\.0 .*Chrome/);
  });
});

describe('vetoResults', () => {
  const jobs = [{ id: 'a', title: 'Dev', description: 'Unpaid trial' }];
  it('drops blank/whitespace keywords and trims', () => {
    const r = vetoResults([{ job_id: 'a', score: 80 }], jobs, ['  ', '', ' nothing-here ']);
    expect(r[0].excluded).toBe(false);
    const r2 = vetoResults([{ job_id: 'a', score: 80 }], jobs, [' unpaid ']);
    expect(r2[0]).toEqual({ job_id: 'a', excluded: true, reason: 'deal-breaker: unpaid', flags: [] });
  });
  it('handles a missing job', () => {
    const r = vetoResults([{ job_id: 'zzz', score: 80, language_gate: 'FLAG' }], jobs, ['unpaid']);
    expect(r).toEqual([{ job_id: 'zzz', excluded: false, flags: ['language FLAG'] }]);
  });
  it('excludes on FAIL verdict', () => {
    const r = vetoResults([{ job_id: 'a', score: 99, location_verdict: 'FAIL' }], jobs, []);
    expect(r[0]).toMatchObject({ job_id: 'a', excluded: true, reason: 'location FAIL' });
  });
});
