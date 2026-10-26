import { describe, it, expect } from 'vitest';
import { channelsFor, applyTierFor, SOURCE_POLICY, CHANNELS } from '../src/lib/channels.js';
import { loadRegistry } from '../src/sources/registry.js';
import { DISCOVER_ONLY_SOURCES } from '../src/lib/discoverOnly.js';

const by = (v: ReturnType<typeof channelsFor>) => Object.fromEntries(v.map((x) => [x.channel, x]));

describe('SOURCE_POLICY covers the registry', () => {
  for (const p of loadRegistry().platforms) {
    it(`registry source ${p.id} has a row`, () => {
      expect(SOURCE_POLICY[p.id], p.id).toBeDefined();
    });
  }
  it('every discover-only source has apply none', () => {
    for (const s of DISCOVER_ONLY_SOURCES) expect(SOURCE_POLICY[s]?.apply, s).toBe('none');
  });
});

describe('channelsFor', () => {
  const gh = { source: 'greenhouse', company: 'Acme', apply_url: 'https://boards.greenhouse.io/acme/jobs/1' };
  it('returns one verdict per channel, in order', () => {
    expect(channelsFor(gh).map((v) => v.channel)).toEqual([...CHANNELS]);
  });
  it('greenhouse job: email, linkedin and apply open, naukri cold-closed', () => {
    const v = by(channelsFor(gh));
    expect(v.email.eligible && v.linkedin.eligible && v.apply.eligible).toBe(true);
    expect(v.naukri).toEqual({ channel: 'naukri', eligible: false, reason: 'no_cold_naukri' });
  });
  it('a verified naukri thread opens naukri', () => {
    expect(by(channelsFor({ source: 'naukri', company: 'Acme' }, { naukriThread: true })).naukri.eligible).toBe(true);
  });
  it('no company closes email and linkedin', () => {
    const v = by(channelsFor({ source: 'lever', company: '', extracted_company: '' }));
    expect(v.email.reason).toBe('no_company');
    expect(v.linkedin.reason).toBe('no_company');
  });
  it('extracted_company stands in for company', () => {
    expect(by(channelsFor({ source: 'lever', company: '', extracted_company: 'Acme' })).email.eligible).toBe(true);
  });
  it('hackernews is gated until the domain check matched', () => {
    expect(by(channelsFor({ source: 'hackernews', company: 'Acme' })).email.reason).toBe('hn_gate_pending');
    expect(by(channelsFor({ source: 'hackernews', company: 'Acme' }, { hnCheck: 'unmatched' })).linkedin.reason).toBe('hn_gate_pending');
    expect(by(channelsFor({ source: 'hackernews', company: 'Acme' }, { hnCheck: 'matched' })).email.eligible).toBe(true);
  });
  it('discover-only sources never apply', () => {
    for (const s of ['workday', 'workable', 'himalayas', 'hackernews']) {
      expect(by(channelsFor({ source: s, company: 'Acme', apply_url: 'https://boards.greenhouse.io/x/jobs/1' }, { hnCheck: 'matched' })).apply)
        .toEqual({ channel: 'apply', eligible: false, reason: 'discover_only_source' });
    }
  });
  it('generated providers are held on every channel', () => {
    for (const v of channelsFor({ source: 'gen:acme-careers', company: 'Acme' })) expect(v).toEqual({ channel: v.channel, eligible: false, reason: 'held_review' });
  });
  it('linkedin-posts has no apply', () => {
    expect(by(channelsFor({ source: 'linkedin-posts', company: 'Acme' })).apply.reason).toBe('apply_tier:none');
  });
  it('apply tiers', () => {
    expect(applyTierFor('https://jobs.lever.co/a/1')).toBe('ats_form');
    expect(applyTierFor('https://x.myworkdayjobs.com/a')).toBe('account_gated');
    expect(applyTierFor('https://www.linkedin.com/jobs/view/1')).toBe('linkedin_easy');
    expect(applyTierFor('https://evil-greenhouse.io/x')).toBe('unknown_host');
    expect(applyTierFor('javascript:alert(1)')).toBe('none');
    expect(applyTierFor('https://u:p@lever.co/x')).toBe('none');
    const v = (src: string, url: string, ctx = {}) => by(channelsFor({ source: src, company: 'A', apply_url: url }, ctx)).apply;
    expect(v('remotive', 'https://www.linkedin.com/jobs/view/1').reason).toBe('apply_tier:linkedin_easy');
    expect(v('remotive', 'https://www.linkedin.com/jobs/view/1', { linkedinEasy: true }).eligible).toBe(true);
    expect(v('remotive', 'https://acme.example/jobs/1').reason).toBe('apply_tier:unknown_host');
    expect(v('remotive', 'https://acme.example/jobs/1', { allowUnknownHosts: true }).eligible).toBe(true);
    expect(v('remotive', 'https://x.myworkdayjobs.com/a').reason).toBe('apply_tier:account_gated');
  });
  it('a Naukri job page is apply-capable (naukri_arm_apply), like Wellfound', () => {
    const v = (src: string, url: string) => by(channelsFor({ source: src, company: 'A', apply_url: url })).apply;
    expect(applyTierFor('https://www.naukri.com/job-listings-react-dev-acme-123')).toBe('naukri_agent');
    expect(v('naukri', 'https://www.naukri.com/job-listings-react-dev-acme-123')).toEqual({ channel: 'apply', eligible: true });
    expect(v('wellfound', 'https://wellfound.com/jobs/123-react').eligible).toBe(true);
  });
});
