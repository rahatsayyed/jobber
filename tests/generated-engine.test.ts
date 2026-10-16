import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createGeneratedProvider, extractWithSpec } from '../src/sources/generated/engine.js';
import { specSchema, type ProviderSpec } from '../src/sources/generated/spec.js';
import { validateSpecAgainstFixtures } from '../src/sources/generated/validate.js';
import { baseSpec } from './helpers/genSpec.js';

const LISTING = readFileSync('tests/fixtures/web/listing-a.html', 'utf8');
const BASE = 'https://careers.example.test/jobs';

const spec = (over: Record<string, unknown> = {}): ProviderSpec => specSchema.parse(baseSpec(over));

describe('spec schema', () => {
  it('accepts a valid html_list spec', () => { expect(specSchema.safeParse(baseSpec()).success).toBe(true); });
  it('is strict: unknown keys, bad ids and missing parts are rejected', () => {
    expect(specSchema.safeParse(baseSpec({ extra: 1 })).success).toBe(false);
    expect(specSchema.safeParse(baseSpec({ id: 'Bad_Id' })).success).toBe(false);
    expect(specSchema.safeParse(baseSpec({ item: { jsonPath: 'jobs' } })).success).toBe(false);
    expect(specSchema.safeParse(baseSpec({ job_id_from: 'field' })).success).toBe(false);
    expect(specSchema.safeParse(baseSpec({ pagination: { max_pages: 6, param: 'page' } })).success).toBe(false);
    expect(specSchema.safeParse(baseSpec({ pagination: { max_pages: 2 } })).success).toBe(false);
  });
  it('rejects hostile selectors in the item, a field and the pagination', () => {
    expect(specSchema.safeParse(baseSpec({ item: { selector: 'li:has(a)' } })).success).toBe(false);
    expect(specSchema.safeParse(baseSpec({ fields: { title: { selector: 'ul > li a' }, url: { selector: 'a', attr: 'href' } } })).success).toBe(false);
    expect(specSchema.safeParse(baseSpec({ pagination: { next_selector: 'a:not(.x)', max_pages: 2 } })).success).toBe(false);
    expect(specSchema.safeParse(baseSpec({ fields: { title: { selector: 'a', attr: 'onclick' }, url: { selector: 'a', attr: 'href' } } })).success).toBe(false);
  });
  it('requires every start_url to be https and inside hosts', () => {
    expect(specSchema.safeParse(baseSpec({ start_urls: ['https://evil.example.test/jobs'] })).success).toBe(false);
    expect(specSchema.safeParse(baseSpec({ start_urls: ['http://careers.example.test/jobs'] })).success).toBe(false);
    expect(specSchema.safeParse(baseSpec({ start_urls: ['https://user:pw@careers.example.test/jobs'] })).success).toBe(false);
    expect(specSchema.safeParse(baseSpec({ start_urls: ['https://x.careers.example.test/jobs'] })).success).toBe(true);
  });
  it('json_api needs paths only', () => {
    const j = baseSpec({ kind: 'json_api', item: { jsonPath: 'data.jobs' }, fields: { title: { path: 'title' }, url: { path: 'link' } } });
    expect(specSchema.safeParse(j).success).toBe(true);
    expect(specSchema.safeParse({ ...j, fields: { title: { selector: 'a' }, url: { path: 'link' } } }).success).toBe(false);
    expect(specSchema.safeParse({ ...j, fields: { title: { path: '__proto__' }, url: { path: 'link' } } }).success).toBe(false);
  });
});

describe('engine over a captured listing', () => {
  it('reproduces the expected jobs from listing-a.html', () => {
    const ex = extractWithSpec(spec(), LISTING, BASE);
    expect(ex.jobs.map((j) => j.title)).toEqual(['Frontend Engineer', 'Full Stack Developer', 'Backend Engineer']);
    expect(ex.jobs.map((j) => j.url)).toEqual([
      'https://careers.example.test/jobs/1001', 'https://careers.example.test/jobs/1002', 'https://careers.example.test/jobs/1003',
    ]);
    expect(ex.jobs[0]).toMatchObject({ source: 'gen:acme', company: 'Acme Careers', apply_url: 'https://careers.example.test/jobs/1001' });
    expect(ex.jobs[0]!.description).toContain('Location: Remote, India');
    expect(new Set(ex.jobs.map((j) => j.id)).size).toBe(3);
    expect(ex.jobs[0]!.id).toMatch(/^gen:acme:[0-9a-f]{16}$/);
  });

  it('drops an extracted URL outside hosts and counts it', () => {
    const html = '<ul><li class="job"><a href="https://evil.example.test/x/1">Frontend Engineer</a></li><li class="job"><a href="/jobs/2">Dev</a></li>'
      + '<li class="job"><a href="http://careers.example.test/jobs/3">Insecure</a></li><li class="job"><a href="javascript:alert(1)">Js</a></li></ul>';
    const ex = extractWithSpec(spec(), html, BASE);
    expect(ex.jobs.map((j) => j.url)).toEqual(['https://careers.example.test/jobs/2']);
    expect(ex.outside).toBe(3);
  });

  it('never reads a field from a hidden element', () => {
    const html = '<ul><li class="job"><a href="/jobs/1">Real Engineer</a><span class="loc" style="display:none">secret</span></li>'
      + '<li class="job" hidden><a href="/jobs/2">Hidden Engineer</a></li></ul>';
    const ex = extractWithSpec(spec(), html, BASE);
    expect(ex.hidden).toBe(2);
    expect(ex.jobs.map((j) => j.title)).toEqual(['Real Engineer']);
    expect(ex.jobs[0]!.description).not.toContain('secret');
  });

  it('job_id_from field uses the id field, and a missing id is incomplete', () => {
    const s = spec({ job_id_from: 'field', fields: { title: { selector: 'a' }, url: { selector: 'a', attr: 'href' }, id: { selector: 'a', attr: 'title' } } });
    const html = '<li class="job"><a href="/jobs/1" title="r-1">One Dev</a></li><li class="job"><a href="/jobs/2">Two Dev</a></li>';
    const ex = extractWithSpec(s, html, BASE);
    expect(ex.jobs).toHaveLength(1);
    expect(ex.incomplete).toBe(1);
  });

  it('descendant selectors and pagination links work', () => {
    const s = spec({ item: { selector: 'ul.jobs li' }, fields: { title: { selector: 'a' }, url: { selector: 'a', attr: 'href' } }, pagination: { next_selector: 'a.next', max_pages: 2 } });
    const html = '<ul class="jobs"><li><a href="/jobs/1">One Dev</a></li></ul><ul><li><a href="/jobs/9">Other Dev</a></li></ul><a class="next" href="/jobs?page=2">Next</a>';
    const ex = extractWithSpec(s, html, BASE);
    expect(ex.jobs).toHaveLength(1);
    expect(ex.nextUrl).toBe('https://careers.example.test/jobs?page=2');
  });

  it('json_api reads paths and cannot reach prototype keys', () => {
    const s = spec({ kind: 'json_api', item: { jsonPath: 'data.jobs' }, fields: { title: { path: 'name' }, url: { path: 'links[0].href' }, company: { path: 'org' }, posted_at: { path: 'date' } } });
    const body = JSON.stringify({ data: { jobs: [{ name: 'Dev One', links: [{ href: '/j/1' }], org: 'Beta', date: '2026-10-01' }, { name: 'Dev Two', links: [] }] } });
    const ex = extractWithSpec(s, body, 'https://careers.example.test/api');
    expect(ex.jobs).toHaveLength(1);
    expect(ex.jobs[0]).toMatchObject({ title: 'Dev One', company: 'Beta', url: 'https://careers.example.test/j/1', posted_at: '2026-10-01' });
    expect(ex.incomplete).toBe(1);
    expect(extractWithSpec(s, 'not json', BASE).jobs).toEqual([]);
  });
});

describe('fixture-replay validation', () => {
  it('passes with at least minJobs, fails with fewer', () => {
    expect(validateSpecAgainstFixtures(spec(), [LISTING], 3)).toMatchObject({ ok: true, jobs: 3 });
    expect(validateSpecAgainstFixtures(spec(), [LISTING], 4)).toMatchObject({ ok: false, code: 'too_few_jobs', jobs: 3 });
  });
  it('fails with no fixture, an outside URL or a hidden field', () => {
    expect(validateSpecAgainstFixtures(spec(), [], 3)).toMatchObject({ ok: false, code: 'no_fixture' });
    const outside = LISTING.replace('href="/jobs/1001"', 'href="https://evil.example.test/1"');
    expect(validateSpecAgainstFixtures(spec(), [outside], 2)).toMatchObject({ ok: false, code: 'url_outside_hosts' });
    const hidden = LISTING.replace('<span class="loc">Dubai', '<span class="loc" aria-hidden="true">Dubai');
    expect(validateSpecAgainstFixtures(spec(), [hidden], 3)).toMatchObject({ ok: false, code: 'hidden_field' });
  });
  it('fails an invalid spec at the schema step', () => {
    expect(validateSpecAgainstFixtures(baseSpec({ item: { selector: 'li:has(a)' } }) as unknown as ProviderSpec, [LISTING], 1)).toMatchObject({ ok: false, code: 'schema' });
  });
});

describe('provider', () => {
  it('fetches start urls through the injected fetcher, paginates by param and dedupes', async () => {
    const s = spec({ pagination: { param: 'page', max_pages: 3 } });
    const seen: string[] = [];
    const pages: Record<string, string> = {
      [BASE]: '<li class="job"><a href="/jobs/1">One Dev</a></li><li class="job"><a href="/jobs/2">Two Dev</a></li>',
      [`${BASE}?page=2`]: '<li class="job"><a href="/jobs/2">Two Dev</a></li><li class="job"><a href="/jobs/3">Three Dev</a></li>',
      [`${BASE}?page=3`]: '<li class="job"><a href="/jobs/2">Two Dev</a></li>',
    };
    const p = createGeneratedProvider(s, async (u) => { seen.push(u); return pages[u] ?? ''; });
    const r = await p.fetch({});
    expect(p.id).toBe('gen:acme');
    expect(r.jobs.map((j) => j.title)).toEqual(['One Dev', 'Two Dev', 'Three Dev']);
    expect(seen).toEqual([BASE, `${BASE}?page=2`, `${BASE}?page=3`]);
    expect(r.sample.length).toBe(3);
    expect(p.shapeSpec.safeParse(r.sample[0]).success).toBe(true);
  });
});

describe('no code path evaluates or loads a generated file', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const f = path.join(d, n); if (statSync(f).isDirectory()) walk(f); else if (f.endsWith('.ts')) files.push(f); } };
  walk('src/sources/generated');
  files.push('src/scout/tools/provider.ts', 'scripts/providers.ts', 'src/lib/safeSelector.ts');
  it.each(files)('%s has no eval, Function, require or dynamic import', (f) => {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/\beval\s*\(/);
    expect(src).not.toMatch(/new\s+Function\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/vm\.|node:vm|createRequire/);
  });
});
