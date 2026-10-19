// Finding 8: Adzuna answered HTTP 400. The built request must carry no empty parameters (an empty `where=`
// is the likely cause), nothing the API does not document, and never leak values into errors. No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAdzunaRequest, provider } from '../src/sources/adzuna.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const ENV = { ADZUNA_APP_ID: 'id-test', ADZUNA_APP_KEY: 'key-test' };

describe('buildAdzunaRequest', () => {
  it('country in, no location: only app_id, app_key, results_per_page and what (no empty where, no content-type)', () => {
    const { url, paramNames } = buildAdzunaRequest({ role: 'full stack developer / react' }, ENV);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.adzuna.com/v1/api/jobs/in/search/1');
    expect([...u.searchParams.keys()].sort()).toEqual(['app_id', 'app_key', 'results_per_page', 'what']);
    expect(paramNames).toEqual([...u.searchParams.keys()]);
    for (const [, v] of u.searchParams) expect(v).not.toBe('');
    expect(u.searchParams.get('what')).toBe('full stack developer react');
    expect(Number(u.searchParams.get('results_per_page'))).toBeLessThanOrEqual(50);
  });

  it('a location is sent as where, a blank one is not', () => {
    expect(new URL(buildAdzunaRequest({ role: 'react', location: 'Bengaluru' }, ENV).url).searchParams.get('where')).toBe('Bengaluru');
    expect(new URL(buildAdzunaRequest({ role: 'react', location: '  ' }, ENV).url).searchParams.has('where')).toBe(false);
  });

  it('refuses to build without credentials or a role (no bogus request)', () => {
    expect(() => buildAdzunaRequest({ role: 'react' }, {})).toThrow(/adzuna_credentials_missing/);
    expect(() => buildAdzunaRequest({ role: ' / ' }, ENV)).toThrow(/adzuna_role_missing/);
  });

  it('an unsafe country code falls back to in', () => {
    expect(buildAdzunaRequest({ role: 'react', country: '../x' }, ENV).url).toContain('/jobs/in/search/1');
    expect(buildAdzunaRequest({ role: 'react', country: 'GB' }, ENV).url).toContain('/jobs/gb/search/1');
  });
});

describe('adzuna provider', () => {
  it('a 400 reports the status and parameter names only, never values', async () => {
    vi.stubEnv('ADZUNA_APP_ID', 'id-secret-value');
    vi.stubEnv('ADZUNA_APP_KEY', 'key-secret-value');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 400 })));
    const err = await provider.fetch({ params: { role: 'react dev' } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/400/);
    expect(msg).toMatch(/app_id.*app_key.*results_per_page.*what/);
    expect(msg).not.toMatch(/secret-value|react dev/);
  });
});
