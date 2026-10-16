// tests/settings-file-registry.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allEntries, resolveEntry, textProblem, type ValidateCtx } from '../src/settings/fileRegistry.js';
import { installNoRealEnv } from './helpers/noRealEnv.js';

const guard = installNoRealEnv();
afterAll(() => guard.restore());

const fx = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'settings', name), 'utf8');
const none: ValidateCtx = { readText: () => null };
const check = (id: string, text: string, ctx: ValidateCtx = none) => resolveEntry(id)!.validate(text, ctx);
const obj = (name: string): Record<string, any> => JSON.parse(fx(name));

const DISCOVERY = JSON.stringify({
  jobs: [{ name: 'a', keyword: 'react', location: 'India', limit: 25 }],
  posts: { role: 'react', geo: 'in', limit: 25 },
});

describe('allowlist', () => {
  it('rejects anything that is not a registered id', () => {
    for (const bad of ['', '..', '../.env', 'portals/../..', 'PORTALS', 'portals\0', '%2e%2e', '/etc/passwd', 'a'.repeat(41), 'resume', 'env', 'secrets', 'constructor', '__proto__']) {
      expect(resolveEntry(bad)).toBeNull();
    }
    for (const bad of [undefined, null, 5, {}, ['portals'], true]) expect(resolveEntry(bad)).toBeNull();
  });

  it('contains exactly the D14 ids', () => {
    const edit = ['portals', 'target-regions', 'deal-breakers', 'replies', 'linkedin-discovery', 'languages', 'easy-apply-answers', 'profile', 'fact-gate'];
    const viewOnly = ['permission-sets', 'run-profiles', 'worker-tools', 'classifier-models', 'manager-windows', 'platforms', 'ai-tells', 'ccgram-pin', 'update-known-failures'];
    expect(allEntries().map((e) => e.id).sort()).toEqual([...edit, ...viewOnly].sort());
    for (const id of edit) expect(resolveEntry(id)!.edit).toBe(true);
    for (const id of viewOnly) {
      const e = resolveEntry(id)!;
      expect(e.edit).toBe(false);
      expect(e.tier).toBe('never');
      expect(e.viewReason).toBeTruthy();
    }
  });

  it('keeps every rel a constant under config/ or user-data/ with no traversal', () => {
    for (const e of allEntries()) {
      for (const rel of [e.rel, e.altRel].filter(Boolean) as string[]) {
        expect(rel).toMatch(/^(config|user-data)\/[a-z0-9.-]+\.json$/);
        expect(rel).not.toContain('..');
      }
      expect(e.rel.startsWith(e.area + '/')).toBe(true);
    }
  });
});

describe('text limits', () => {
  it('refuses oversize text before parsing, BOM, NUL and invalid UTF-8', () => {
    expect(textProblem('x'.repeat(11), 10)).toMatch(/larger/);
    expect(textProblem('﻿{}', 100)).toMatch(/byte order mark/);
    expect(textProblem('{"a":"\u0000"}', 100)).toMatch(/NUL/);
    expect(textProblem('{"a":"�"}', 100)).toMatch(/UTF-8/);
    expect(textProblem('{"a":"\ud800"}', 100)).toMatch(/UTF-8/);
    expect(textProblem('{}', 100)).toBeNull();
    const big = '{"keywords":["' + 'a'.repeat(300000) + '"]}';
    const r = check('deal-breakers', big);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/larger/);
  });

  it('reports line and column for broken JSON, never the text', () => {
    const r = check('replies', '{\n  "auto_record_enabled": false,\n}');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/invalid JSON/);
    expect(r.errors[0]).toMatch(/line 3/);
    expect(r.errors.join()).not.toContain('auto_record_enabled');
  });
});

describe('fixtures validate', () => {
  it.each(['portals', 'target-regions', 'deal-breakers', 'replies', 'languages', 'easy-apply-answers', 'profile', 'fact-gate'])('%s', (id) => {
    const r = check(id, fx(`${id}.json`));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it('linkedin-discovery', () => {
    expect(check('linkedin-discovery', DISCOVERY).ok).toBe(true);
  });
  it('the shipped config files validate too', () => {
    for (const [id, rel] of [['portals', 'config/portals.json'], ['target-regions', 'config/target-regions.json'], ['deal-breakers', 'config/deal-breakers.json'], ['replies', 'config/replies.json'], ['linkedin-discovery', 'config/discover-linkedin.json']]) {
      const r = check(id, readFileSync(join(__dirname, '..', rel), 'utf8'));
      expect(r.errors, id).toEqual([]);
    }
  });
});

describe('broken variants (one per rule)', () => {
  const set = (name: string, f: (o: any) => void) => {
    const o = obj(name);
    f(o);
    return JSON.stringify(o);
  };

  it('portals', () => {
    expect(check('portals', set('portals.json', (o) => delete o.tracked_companies)).errors.join()).toMatch(/tracked_companies/);
    expect(check('portals', set('portals.json', (o) => (o.tracked_companies[0].slug = 'bad slug!'))).ok).toBe(false);
    expect(check('portals', set('portals.json', (o) => (o.tracked_companies[0].ats = 'nonsense'))).errors.join()).toMatch(/tracked_companies\[0\]/);
    expect(check('portals', '[]').ok).toBe(false);
    expect(check('portals', set('portals.json', (o) => (o.tracked_companies[1].enabled = 'true'))).warnings.join()).toMatch(/tracked_companies\[1\]\.enabled/);
    expect(check('portals', set('portals.json', (o) => (o.location_filter.allow = []))).ok).toBe(false);
  });

  it('target-regions', () => {
    expect(check('target-regions', set('target-regions.json', (o) => (o.home = []))).ok).toBe(false);
    expect(check('target-regions', set('target-regions.json', (o) => (o.targets = 'Dubai'))).ok).toBe(false);
    expect(check('target-regions', set('target-regions.json', (o) => (o.remote_anywhere = 'yes'))).errors.join()).toMatch(/remote_anywhere/);
  });

  it('deal-breakers', () => {
    expect(check('deal-breakers', '{"keywords":"unpaid"}').errors[0]).toMatch(/^keywords:/);
    expect(check('deal-breakers', '{"keywords":[1]}').errors[0]).toMatch(/^keywords\[0\]:/);
    expect(check('deal-breakers', '{}').ok).toBe(false);
    expect(check('deal-breakers', '{"keywords":[" "]}').warnings.length).toBe(1);
  });

  it('replies', () => {
    expect(check('replies', '{"auto_record_enabled":"false"}').errors[0]).toMatch(/^auto_record_enabled:/);
    expect(check('replies', '[]').ok).toBe(false);
  });

  it('linkedin-discovery', () => {
    expect(check('linkedin-discovery', JSON.stringify({ jobs: [{ name: 'a', limit: 5 }], posts: { role: 'r', geo: 'in', limit: 5 } })).ok).toBe(false);
    expect(check('linkedin-discovery', JSON.stringify({ jobs: [{ name: 'a', keyword: 'k', limit: 'x' }], posts: { role: 'r', geo: 'in', limit: 5 } })).errors[0]).toMatch(/^jobs\[0\]\.limit/);
    expect(check('linkedin-discovery', JSON.stringify({ jobs: [{ name: 'a', keyword: 'k', limit: 5, experience_level: 'god' }], posts: { role: 'r', geo: 'in', limit: 5 } })).ok).toBe(false);
    expect(check('linkedin-discovery', '{"jobs":[]}').ok).toBe(false);
    const ph = check('linkedin-discovery', JSON.stringify({ jobs: [{ name: 'a', search_url: 'REPLACE_WITH_X', limit: 5 }], posts: { role: 'r', geo: 'in', limit: 5 } }));
    expect(ph.ok).toBe(true);
    expect(ph.warnings.length).toBe(1);
  });

  it('languages', () => {
    expect(check('languages', set('languages.json', (o) => (o.confirmed = 'true'))).errors.join()).toMatch(/confirmed/);
    expect(check('languages', set('languages.json', (o) => (o.declared = []))).ok).toBe(false);
    expect(check('languages', set('languages.json', (o) => (o.declared[0].level = 'godlike'))).errors.join()).toMatch(/declared/);
    expect(check('languages', set('languages.json', (o) => (o.declared = 'English'))).ok).toBe(false);
  });

  it('easy-apply-answers', () => {
    expect(check('easy-apply-answers', set('easy-apply-answers.json', (o) => (o.years_experience = 'three'))).errors[0]).toMatch(/^years_experience:/);
    expect(check('easy-apply-answers', set('easy-apply-answers.json', (o) => delete o.phone)).errors[0]).toMatch(/^phone:/);
    expect(check('easy-apply-answers', set('easy-apply-answers.json', (o) => (o.custom = { q: ['a'] }))).ok).toBe(false);
  });

  it('easy-apply-answers: object requires_sponsorship is a warning, not an error', () => {
    const r = check('easy-apply-answers', set('easy-apply-answers.json', (o) => (o.requires_sponsorship = { india: false, other: true })));
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/requires_sponsorship/);
  });

  it('profile (salary shape and others)', () => {
    expect(check('profile', set('profile.json', (o) => (o.salary = { USD: { floor: 5, target: 1 } }))).errors.join()).toMatch(/salary\.USD/);
    expect(check('profile', set('profile.json', (o) => (o.salary = { usd: { floor: 1, target: 2 } }))).ok).toBe(false);
    expect(check('profile', set('profile.json', (o) => (o.remote_ok = 'yes'))).errors.join()).toMatch(/remote_ok/);
    expect(check('profile', '5').ok).toBe(false);
  });

  it('fact-gate', () => {
    expect(check('fact-gate', set('fact-gate.json', (o) => (o.allow_facts = [1]))).errors.join()).toMatch(/allow_facts must be an array of strings/);
    expect(check('fact-gate', set('fact-gate.json', (o) => (o.keywords = []))).errors.join()).toMatch(/unknown key "keywords"/);
    expect(check('fact-gate', '[]').ok).toBe(false);
  });

  it('error text never carries file content', () => {
    const secret = 'FIXTURE-SECRET-1';
    const r = check('easy-apply-answers', set('easy-apply-answers.json', (o) => ((o.phone = 5), (o.expected_salary = secret), (o.years_experience = secret))));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('view-only files accept any JSON object and refuse junk', () => {
    expect(check('ai-tells', '{"a":1}').ok).toBe(true);
    expect(check('ai-tells', '3').ok).toBe(false);
  });
});

describe('cross-file remote_anywhere warning', () => {
  it('portals and target-regions warn when they differ', () => {
    const portalsOff = JSON.stringify({ ...obj('portals.json'), location_filter: { ...obj('portals.json').location_filter, remote_anywhere: false } });
    const w1 = check('target-regions', fx('target-regions.json'), { readText: (id) => (id === 'portals' ? portalsOff : null) });
    expect(w1.ok).toBe(true);
    expect(w1.warnings.join()).toMatch(/remote_anywhere/);
    const w2 = check('portals', fx('portals.json'), { readText: (id) => (id === 'target-regions' ? JSON.stringify({ ...obj('target-regions.json'), remote_anywhere: false }) : null) });
    expect(w2.warnings.join()).toMatch(/keep the two in step/);
    const same = check('portals', fx('portals.json'), { readText: (id) => (id === 'target-regions' ? fx('target-regions.json') : null) });
    expect(same.warnings).toEqual([]);
  });
});

describe('weakening and tiers', () => {
  it('flags the changes the plan names', () => {
    const w = (id: string, b: unknown, a: unknown) => resolveEntry(id)!.weakens!(b, a);
    expect(w('target-regions', { remote_anywhere: false }, { remote_anywhere: true })).toBeTruthy();
    expect(w('target-regions', { remote_anywhere: true }, { remote_anywhere: true })).toBeNull();
    expect(w('deal-breakers', { keywords: ['a', 'b'] }, { keywords: ['a'] })).toMatch(/removes 1/);
    expect(w('deal-breakers', { keywords: ['a'] }, { keywords: ['a', 'b'] })).toBeNull();
    expect(w('replies', { auto_record_enabled: false }, { auto_record_enabled: true })).toBeTruthy();
    expect(w('replies', { auto_record_enabled: true }, { auto_record_enabled: false })).toBeNull();
    expect(w('languages', { confirmed: false }, { confirmed: true })).toBeTruthy();
    expect(w('fact-gate', { allow_facts: [] }, { allow_facts: ['x'] })).toMatch(/allow_facts/);
    expect(w('fact-gate', { allow_metrics: [] }, { allow_metrics: ['10%'] })).toMatch(/allow_metrics/);
    expect(w('fact-gate', { warn_phrases: [] }, { warn_phrases: ['x'] })).toBeNull();
    expect(resolveEntry('replies')!.weakTier).toBe('safety');
    expect(resolveEntry('fact-gate')!.weakTier).toBe('safety');
  });
});
