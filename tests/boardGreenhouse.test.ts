import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchGreenhouse, getJson, normalizeGreenhouse, settleBoard } from '../src/sources/boards/greenhouse.js';

afterEach(() => vi.unstubAllGlobals());
const company = { name: 'Acme', ats: 'greenhouse' as const, slug: 'acme', enabled: true };
const raw = { jobs: [
  { id: 101, title: 'Frontend Engineer', absolute_url: 'https://about.acme.com/careers?gh_jid=101', location: { name: 'Remote, India' }, first_published: '2026-10-01T09:00:00-04:00', updated_at: '2026-10-03T00:00:00Z', content: '&lt;p&gt;Build &lt;b&gt;React&lt;/b&gt; apps&lt;/p&gt;' },
  { id: 102, title: 'Backend Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/102', location: { name: 'Bengaluru' }, updated_at: '2026-09-20T00:00:00Z', content: '' },
] };

describe('normalizeGreenhouse', () => {
  it('maps jobs with canonical apply URLs, readable descriptions and dates', () => {
    expect(normalizeGreenhouse(raw, company)).toEqual([
      { id: 'gh:acme:101', source: 'greenhouse', title: 'Frontend Engineer', company: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/101', apply_url: 'https://boards.greenhouse.io/acme/jobs/101', description: 'Build React apps', posted_at: '2026-10-01', locations: ['Remote, India'], remote: true },
      { id: 'gh:acme:102', source: 'greenhouse', title: 'Backend Engineer', company: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/102', apply_url: 'https://boards.greenhouse.io/acme/jobs/102', description: '', posted_at: '2026-09-20', locations: ['Bengaluru'], remote: false },
    ]);
  });
  it('tolerates junk', () => {
    expect(normalizeGreenhouse({ jobs: [null, { title: 'no id' }] }, company)).toEqual([]);
    expect(normalizeGreenhouse(null, company)).toEqual([]);
  });
  it('rejects non-numeric ids and replaces a non-http absolute_url with the canonical URL', () => {
    const out = normalizeGreenhouse({ jobs: [
      { id: '1/../x', title: 'Bad id', location: { name: 'India' } },
      { id: 103, title: 'Frontend', absolute_url: 'javascript:alert(1)', location: { name: 'India' } },
    ] }, company);
    expect(out.map((j) => j.id)).toEqual(['gh:acme:103']);
    expect(out[0].url).toBe('https://boards.greenhouse.io/acme/jobs/103');
  });
  it('keeps a semicolon-joined multi-location string as one entry (the location filter splits it)', () => {
    const out = normalizeGreenhouse({ jobs: [{ id: 7, title: 'Fullstack', location: { name: 'Remote, Canada; Remote, India' } }] }, company);
    expect(out[0].locations).toEqual(['Remote, Canada; Remote, India']);
    expect(out[0].remote).toBe(true);
  });
  it('caps descriptions and never takes apply_url from the response', () => {
    const out = normalizeGreenhouse({ jobs: [{ id: 9, title: 'Dev', apply_url: 'https://evil.example.com', location: { name: 'India' }, content: 'x'.repeat(50000) }] }, company);
    expect(out[0].description.length).toBe(8000);
    expect(out[0].apply_url).toBe('https://boards.greenhouse.io/acme/jobs/9');
  });
});

describe('normalizeGreenhouse limits', () => {
  it('a custom-domain absolute_url falls back to canonical; vendor https URLs are kept', () => {
    const out = normalizeGreenhouse({ jobs: [
      { id: 1, title: 'a', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1' },
      { id: 2, title: 'b', absolute_url: 'http://boards.greenhouse.io/acme/jobs/2' },
      { id: 3, title: 'c', absolute_url: 'https://greenhouse.io.evil.io/x' },
    ] }, company);
    expect(out.map((j) => j.url)).toEqual(['https://job-boards.greenhouse.io/acme/jobs/1', 'https://boards.greenhouse.io/acme/jobs/2', 'https://boards.greenhouse.io/acme/jobs/3']);
  });
  it('keeps at most 2000 jobs, clips title and location, falls back on long url, skips long ids', () => {
    const many = { jobs: Array.from({ length: 100000 }, (_, i) => ({ id: i + 1, title: 't' })) };
    expect(normalizeGreenhouse(many, company)).toHaveLength(2000);
    const [j] = normalizeGreenhouse({ jobs: [{ id: 5, title: 'x'.repeat(1_000_000), location: { name: 'y'.repeat(5000) }, absolute_url: 'https://boards.greenhouse.io/' + 'z'.repeat(3000) }] }, company);
    expect(j.title).toHaveLength(300);
    expect(j.locations[0]).toHaveLength(300);
    expect(j.url).toBe('https://boards.greenhouse.io/acme/jobs/5');
    expect(normalizeGreenhouse({ jobs: [{ id: '1'.repeat(150), title: 't' }] }, company)).toEqual([]);
  });
  it('validates the slug itself and settleBoard reports it', async () => {
    expect(() => normalizeGreenhouse(raw, { ...company, slug: '..' })).toThrow('invalid board slug');
    expect((await settleBoard(async (c) => normalizeGreenhouse(raw, c), { ...company, slug: 'a-b/c' })).error).toContain('invalid board slug');
  });
});

describe('fetchGreenhouse', () => {
  it('calls the public board API with content=true, no redirects', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw), { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await fetchGreenhouse(company)).toHaveLength(2);
    expect(f.mock.calls[0][0]).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
    expect(f.mock.calls[0][1].redirect).toBe('error');
    expect(f.mock.calls[0][1].headers['User-Agent']).toMatch(/jobber/);
  });
  it('throws on a non-200 so the caller can report it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
    await expect(fetchGreenhouse(company)).rejects.toThrow('greenhouse acme: HTTP 404');
  });
  it('rejects an invalid slug before any network call', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(fetchGreenhouse({ ...company, slug: '..' })).rejects.toThrow(/invalid board slug/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('getJson safety', () => {
  it('refuses non-https and non-allowlisted hosts', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(getJson('http://boards-api.greenhouse.io/v1/boards/a/jobs', 'x')).rejects.toThrow('x: host not allowed');
    await expect(getJson('https://evil.example.com/v1/boards/a/jobs', 'x')).rejects.toThrow('x: host not allowed');
    expect(f).not.toHaveBeenCalled();
  });
  it('rejects a declared content-length over the cap without reading the body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-length': String(20 * 1024 * 1024) } })));
    await expect(getJson('https://boards-api.greenhouse.io/v1/boards/a/jobs', 'greenhouse a')).rejects.toThrow('greenhouse a: response too large');
  });
  it('rejects an oversized streamed body (no content-length)', async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(ctrl) { if (sent >= 17) { ctrl.close(); return; } sent++; ctrl.enqueue(new Uint8Array(1024 * 1024)); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(getJson('https://boards-api.greenhouse.io/v1/boards/a/jobs', 'greenhouse a')).rejects.toThrow('greenhouse a: response too large');
  });
  it('reports invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));
    await expect(getJson('https://boards-api.greenhouse.io/v1/boards/a/jobs', 'greenhouse a')).rejects.toThrow('greenhouse a: invalid JSON');
  });
  it('reports 429, a blocked redirect and a timeout as labelled errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('slow down', { status: 429 })));
    await expect(getJson('https://boards-api.greenhouse.io/v1/boards/a/jobs', 'greenhouse a')).rejects.toThrow('greenhouse a: HTTP 429');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(getJson('https://boards-api.greenhouse.io/v1/boards/a/jobs', 'greenhouse a')).rejects.toThrow(/^greenhouse a: request failed/);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' })));
    await expect(getJson('https://boards-api.greenhouse.io/v1/boards/a/jobs', 'greenhouse a')).rejects.toThrow('greenhouse a: timeout');
  });
});

describe('settleBoard', () => {
  it('turns a provider failure into a structured result instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
    expect(await settleBoard(fetchGreenhouse, company)).toEqual({ jobs: [], error: 'greenhouse acme: HTTP 404' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(raw), { status: 200 })));
    const ok = await settleBoard(fetchGreenhouse, company);
    expect(ok.error).toBeNull();
    expect(ok.jobs).toHaveLength(2);
  });
});
