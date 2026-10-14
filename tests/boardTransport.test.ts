import { describe, it, expect, vi, afterEach } from 'vitest';
import { apexHosts, exactHosts, getJson, getText, postJson, BOARD_USER_AGENT } from '../src/sources/boards/transport.js';
import { getJson as getJsonViaGreenhouse } from '../src/sources/boards/greenhouse.js';

afterEach(() => vi.unstubAllGlobals());
const ok = (body: string, init: ResponseInit = { status: 200 }) => new Response(body, init);

describe('transport re-export', () => {
  it('greenhouse.ts still exports the same getJson', () => { expect(getJsonViaGreenhouse).toBe(getJson); });
});

describe('host policies', () => {
  it('default policy is the three board API hosts', async () => {
    const f = vi.fn().mockResolvedValue(ok('{}'));
    vi.stubGlobal('fetch', f);
    await getJson('https://api.lever.co/v0/postings/a', 'x');
    await expect(getJson('https://api.workable.com/x', 'x')).rejects.toThrow('x: host not allowed');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('apexHosts accepts the apex and subdomains, not look-alikes, not http, not credentials', async () => {
    const f = vi.fn().mockImplementation(async () => ok('{"offers":[]}'));
    vi.stubGlobal('fetch', f);
    const hosts = apexHosts('recruitee.com');
    await getJson('https://acme.recruitee.com/api/offers/', 'rc acme', { hosts });
    await getJson('https://recruitee.com/api/offers/', 'rc', { hosts });
    for (const bad of ['https://acme.recruitee.com.evil.io/api/offers/', 'https://evil-recruitee.com/x', 'http://acme.recruitee.com/api/offers/', 'https://user:pw@acme.recruitee.com/x', 'https://127.0.0.1/x', 'not a url']) {
      await expect(getJson(bad, 'rc', { hosts })).rejects.toThrow('rc: host not allowed');
    }
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('exactHosts is case-insensitive and exact', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('{}')));
    const hosts = exactHosts('Apply.Workable.com');
    await getJson('https://apply.workable.com/api/v1/widget/accounts/a', 'wk', { hosts });
    await expect(getJson('https://x.apply.workable.com/a', 'wk', { hosts })).rejects.toThrow('wk: host not allowed');
  });
});

describe('request hardening is preserved for every helper', () => {
  it('sends no redirects, a fixed user agent that callers cannot override, and merges extra headers', async () => {
    const f = vi.fn().mockResolvedValue(ok('{}'));
    vi.stubGlobal('fetch', f);
    await getJson('https://api.lever.co/v0/postings/a', 'x', { headers: { Referer: 'https://a.example/', 'User-Agent': 'evil' }, accept: 'application/json;q=1' });
    const init = f.mock.calls[0][1];
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('GET');
    expect(init.headers['User-Agent']).toBe(BOARD_USER_AGENT);
    expect(init.headers.Referer).toBe('https://a.example/');
    expect(init.headers.Accept).toBe('application/json;q=1');
    expect(init.body).toBeUndefined();
  });
  it('getText returns the raw body with an XML accept header', async () => {
    const f = vi.fn().mockResolvedValue(ok('<a>b</a>'));
    vi.stubGlobal('fetch', f);
    expect(await getText('https://api.lever.co/x', 'x')).toBe('<a>b</a>');
    expect(f.mock.calls[0][1].headers.Accept).toMatch(/xml/);
  });
  it('postJson sends a JSON body with a content type, never follows redirects, and parses the answer', async () => {
    const f = vi.fn().mockResolvedValue(ok('{"total":1}'));
    vi.stubGlobal('fetch', f);
    const hosts = apexHosts('myworkdayjobs.com');
    expect(await postJson('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/ext/jobs', { limit: 20, offset: 0 }, 'wd acme', { hosts })).toEqual({ total: 1 });
    const init = f.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ limit: 20, offset: 0 });
  });
  it('postJson refuses a foreign host and an oversized request body before any network call', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(postJson('https://evil.example.com/jobs', {}, 'wd', { hosts: apexHosts('myworkdayjobs.com') })).rejects.toThrow('wd: host not allowed');
    await expect(postJson('https://a.myworkdayjobs.com/x', { q: 'x'.repeat(30000) }, 'wd', { hosts: apexHosts('myworkdayjobs.com') })).rejects.toThrow('wd: request body too large');
    expect(f).not.toHaveBeenCalled();
  });
  it('rejects a declared oversized body, an oversized stream, bad JSON, HTTP errors, redirects and timeouts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('{}', { status: 200, headers: { 'content-length': String(20 * 1024 * 1024) } })));
    await expect(getText('https://api.lever.co/x', 'l a')).rejects.toThrow('l a: response too large');
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (sent >= 17) { c.close(); return; } sent++; c.enqueue(new Uint8Array(1024 * 1024)); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(getText('https://api.lever.co/x', 'l a')).rejects.toThrow('l a: response too large');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('nope')));
    await expect(getJson('https://api.lever.co/x', 'l a')).rejects.toThrow('l a: invalid JSON');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('x', { status: 429 })));
    await expect(getText('https://api.lever.co/x', 'l a')).rejects.toThrow('l a: HTTP 429');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(getText('https://api.lever.co/x', 'l a')).rejects.toThrow(/^l a: request failed/);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' })));
    await expect(postJson('https://api.lever.co/x', {}, 'l a')).rejects.toThrow('l a: timeout');
  });
});

describe('fix round 1', () => {
  it('refuses explicit ports but accepts :443, and refuses trailing-dot hosts for both policy kinds', async () => {
    const f = vi.fn().mockResolvedValue(ok('{}'));
    vi.stubGlobal('fetch', f);
    await expect(getJson('https://api.lever.co:8443/x', 'x')).rejects.toThrow('x: host not allowed');
    await expect(getJson('https://a.recruitee.com:444/x', 'x', { hosts: apexHosts('recruitee.com') })).rejects.toThrow('x: host not allowed');
    await getJson('https://api.lever.co:443/x', 'x');
    await expect(getJson('https://api.lever.co./x', 'x')).rejects.toThrow('x: host not allowed');
    await expect(getJson('https://a.recruitee.com./x', 'x', { hosts: apexHosts('recruitee.com') })).rejects.toThrow('x: host not allowed');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('postJson forces the JSON content type, rejects undefined, circular and BigInt payloads', async () => {
    const f = vi.fn().mockResolvedValue(ok('{}'));
    vi.stubGlobal('fetch', f);
    await postJson('https://api.lever.co/x', {}, 'p', { headers: { 'content-type': 'text/plain' } });
    const h = f.mock.calls[0][1].headers;
    expect(h['Content-Type']).toBe('application/json');
    expect(Object.keys(h).filter((k) => k.toLowerCase() === 'content-type')).toHaveLength(1);
    const circ: any = {}; circ.self = circ;
    await expect(postJson('https://api.lever.co/x', undefined, 'p')).rejects.toThrow('p: invalid request body');
    await expect(postJson('https://api.lever.co/x', circ, 'p')).rejects.toThrow('p: invalid request body');
    await expect(postJson('https://api.lever.co/x', { n: 1n }, 'p')).rejects.toThrow('p: invalid request body');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('a throwing host predicate is reported as host not allowed', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(getJson('https://a.example.com/x', 'x', { hosts: () => { throw new Error('boom'); } })).rejects.toThrow('x: host not allowed');
    expect(f).not.toHaveBeenCalled();
  });
});
