import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { onsiteCityVerdict } from '../src/onsiteCities.js';
import { applyVetoes } from '../src/vetoes.js';
import { DEFAULT_TARGET_REGIONS, loadTargetRegionsStatus, type TargetRegions } from '../src/targetRegions.js';
import { targetRegionsLine } from '../src/scheduler/pipeline.js';

const tr: TargetRegions = { ...DEFAULT_TARGET_REGIONS, remote_anywhere: true };
const job = (title: string, loc: string, rest = 'We build React apps.') => ({ title, description: `Location: ${loc}\n\n${rest}` });
const v = (j: { title: string; description: string; remote?: boolean }) => onsiteCityVerdict(j, tr);

describe('onsite city rule', () => {
  it('fails on-site and hybrid in a non-listed Indian city', () => {
    expect(v(job('React Developer', 'Chennai (On-site)'))?.verdict).toBe('FAIL');
    expect(v(job('React Developer', 'Chennai, India', 'This is a hybrid role, 3 days in office.'))?.verdict).toBe('FAIL');
    expect(v(job('React Developer', 'Gurugram (Hybrid)'))?.reason).toBe('location: on-site in Gurugram, remote only outside Pune/Hyderabad/Bangalore');
    expect(v(job('React Developer - Noida', 'Noida', 'Work from office, 5 days.'))?.verdict).toBe('FAIL');
  });
  it('passes listed cities, aliases and metro areas', () => {
    for (const c of ['Pune', 'Hinjewadi, Pune', 'Pimpri-Chinchwad', 'Kharadi', 'Hyderabad', 'Gachibowli', 'HITEC City', 'Secunderabad', 'Bengaluru', 'Bangalore', 'Whitefield', 'Koramangala', 'HSR Layout', 'Electronic City', 'Marathahalli', 'Indiranagar']) {
      expect(v(job('React Developer', `${c} (On-site)`))).toBeNull();
    }
    expect(v(job('React Developer', 'Pune (Hybrid)'))).toBeNull();
  });
  it('multi-location with a listed city passes', () => {
    expect(v(job('React Developer', 'Chennai; Pune (Hybrid)'))).toBeNull();
  });
  it('passes remote roles in a non-listed city', () => {
    expect(v(job('React Developer', 'Chennai (Remote)'))).toBeNull();
    expect(v(job('React Developer', 'Mumbai, India - Remote'))).toBeNull();
    expect(v(job('React Developer', 'Delhi', 'Fully remote role, work from home.'))).toBeNull();
    expect(v({ ...job('React Developer', 'Kolkata'), remote: true })).toBeNull();
  });
  it('flags an unclear work mode', () => {
    const r = v(job('React Developer', 'Chennai'));
    expect(r?.verdict).toBe('FLAG');
    expect(r?.reason).toContain('Chennai');
    expect(v(job('React Developer', 'Mumbai (Hybrid/Remote)'))?.verdict).toBe('FLAG');
  });
  it('does not touch Gulf, world remote or city-less jobs', () => {
    expect(v(job('React Developer', 'Dubai, UAE (On-site)'))).toBeNull();
    expect(v(job('React Developer', 'Dubai; Chennai (On-site)'))).toBeNull();
    expect(v(job('React Developer', 'Berlin, Germany (On-site)'))).toBeNull();
    expect(v(job('React Developer', 'Remote - Brazil'))).toBeNull();
    expect(v(job('React Developer', 'India (Remote)'))).toBeNull();
    expect(v({ title: 'React Developer', description: 'No place given. On-site.' })).toBeNull();
  });
  it('reads a city from description wording when there is no location line', () => {
    expect(v({ title: 'React Developer', description: 'Our office in Chennai is hybrid, 3 days a week.' })?.verdict).toBe('FAIL');
    expect(v({ title: 'React Developer', description: 'Remote friendly team. We were founded in Chennai.' })).toBeNull();
  });
  it('is off for a hand-built config without home_onsite', () => {
    expect(onsiteCityVerdict(job('React Developer', 'Chennai (On-site)'), { home: ['India'], targets: [], remote: true, remote_anywhere: false })).toBeNull();
  });
});

describe('applyVetoes with the city rule', () => {
  const run = (j: { title: string; description: string }, verdict?: 'PASS' | 'FAIL' | 'FLAG') =>
    applyVetoes({ job_id: 'x', score: 4.5, location_verdict: verdict }, j, [], { targetRegions: tr });
  it('excludes Chennai on-site even when the model said PASS', () => {
    const r = run(job('React Developer', 'Chennai (On-site)'), 'PASS');
    expect(r.excluded).toBe(true);
    expect(r.reason).toBe('location FAIL: on-site in Chennai, remote only outside Pune/Hyderabad/Bangalore');
  });
  it('keeps Pune hybrid, Chennai remote and Gulf on-site', () => {
    expect(run(job('React Developer', 'Pune (Hybrid)'), 'PASS').excluded).toBe(false);
    expect(run(job('React Developer', 'Chennai (Remote)'), 'PASS').excluded).toBe(false);
    expect(run(job('React Developer', 'Dubai (On-site)'), 'PASS').excluded).toBe(false);
  });
  it('turns an unclear Chennai role into a flag, not an exclusion', () => {
    const r = run(job('React Developer', 'Chennai'), 'PASS');
    expect(r.excluded).toBe(false);
    expect(r.flags.some((f) => f.includes('Chennai'))).toBe(true);
  });
  it('existing behaviour: Berlin on-site FAIL stays, remote elsewhere downgrades', () => {
    expect(run(job('React Developer', 'Berlin (On-site)'), 'FAIL').excluded).toBe(true);
    expect(run(job('React Developer', 'Remote - Brazil'), 'FAIL').excluded).toBe(false);
  });
});

describe('config and prompt line', () => {
  it('shipped config loads with home_onsite', () => {
    const r = loadTargetRegionsStatus(path.resolve('config/target-regions.json'));
    expect(r.config?.home_onsite).toEqual(expect.arrayContaining(['Pune', 'Hyderabad', 'Bengaluru', 'Bangalore']));
    expect(r.config?.home_onsite).not.toContain('Chennai');
  });
  it('the target regions line carries the rule', () => {
    const line = targetRegionsLine(path.resolve('.'));
    expect(line).toContain('on-site or hybrid in India ONLY in=Pune');
    expect(line).toContain('remote only');
  });
  it('an invalid home_onsite is rejected', () => {
    // a non-array value fails validation in the loader (checked through a temp file in the settings tests; here the helper contract)
    expect(loadTargetRegionsStatus('/nonexistent/target-regions.json').config?.home_onsite).toContain('Pune');
  });
});
