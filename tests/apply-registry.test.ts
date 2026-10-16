import { describe, it, expect } from 'vitest';
import { ATS_REGISTRY, classifyApplyUrl } from '../src/apply/registry.js';
import { APPLY_HOST_PLATFORM_IDS, hostCapKey } from '../src/webcore/hostCaps.js';
import { LIMITS } from '../src/setup/limitsCatalog.js';

const env = (o: Record<string, string> = {}) => o as NodeJS.ProcessEnv;
const c = (url: string | null, source: string | null = 'greenhouse', e: Record<string, string> = {}) => classifyApplyUrl(url, source, env(e));

describe('classifyApplyUrl', () => {
  it('classifies registry hosts and subdomains', () => {
    expect(c('https://boards.greenhouse.io/acme/jobs/1')).toMatchObject({ platform: 'greenhouse', tier: 'fast' });
    expect(c('https://job-boards.greenhouse.io/acme/jobs/1')).toMatchObject({ platform: 'greenhouse', tier: 'fast' });
    expect(c('https://jobs.lever.co/acme/abc')).toMatchObject({ platform: 'lever', tier: 'fast' });
    expect(c('https://jobs.ashbyhq.com/acme/abc')).toMatchObject({ platform: 'ashby', tier: 'fast' });
    expect(c('https://apply.workable.com/acme/j/1', 'remotive')).toMatchObject({ platform: 'workable', tier: 'fast' });
    expect(c('https://jobs.smartrecruiters.com/Acme/1', 'remotive')).toMatchObject({ platform: 'smartrecruiters', tier: 'fast' });
    expect(c('https://acme.wd5.myworkdayjobs.com/ext/job/x', 'adzuna')).toMatchObject({ platform: 'workday', tier: 'agent' });
    expect(c('https://acme.recruitee.com/o/dev', 'adzuna')).toMatchObject({ platform: 'recruitee', tier: 'agent' });
    expect(c('https://acme.jobs.personio.de/job/1', 'adzuna')).toMatchObject({ platform: 'personio', tier: 'agent' });
  });

  it('look-alike hosts are none', () => {
    for (const u of ['https://evil-greenhouse.io/x', 'https://greenhouse.io.evil.com/x', 'https://evillinkedin.com/jobs/1', 'https://notlever.co/x']) {
      expect(c(u).platform).toBe('none');
      expect(c(u).tier).toBe('never');
    }
  });

  it('non-http schemes and credentials are none', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '//boards.greenhouse.io/x', 'not a url', 'https://u:p@boards.greenhouse.io/x', '']) {
      expect(c(u, 'adzuna', { APPLY_ALLOW_UNKNOWN_HOSTS: 'true' }).platform).toBe('none');
    }
    expect(c(null).platform).toBe('none');
  });

  it('linkedin is none while APPLY_LINKEDIN_EASY is not exactly true', () => {
    const u = 'https://www.linkedin.com/jobs/view/123';
    expect(c(u, 'linkedin')).toMatchObject({ platform: 'none', tier: 'never', reason: 'easy_apply_off' });
    for (const v of ['TRUE', '1', 'yes', ' true']) expect(c(u, 'linkedin', { APPLY_LINKEDIN_EASY: v }).platform).toBe('none');
    expect(c(u, 'linkedin', { APPLY_LINKEDIN_EASY: 'true' })).toMatchObject({ platform: 'linkedin_easy', tier: 'agent' });
  });

  it('naukri url is naukri', () => {
    expect(c('https://www.naukri.com/job-listings-dev-123', 'naukri')).toMatchObject({ platform: 'naukri' });
  });

  it('aggregator and unapproved gen sources are none', () => {
    const u = 'https://boards.greenhouse.io/acme/jobs/1';
    for (const s of ['hackernews', 'himalayas', 'weworkremotely']) expect(c(u, s)).toMatchObject({ platform: 'none', reason: 'discover_only_source' });
    expect(c('https://acme.wd5.myworkdayjobs.com/ext/job/x', 'workday')).toMatchObject({ platform: 'none', reason: 'discover_only_source' });
    expect(c(u, 'gen:acme')).toMatchObject({ platform: 'none', tier: 'never', reason: 'held_review' });
  });

  it('unknown https host is none unless APPLY_ALLOW_UNKNOWN_HOSTS=true', () => {
    const u = 'https://careers.acme.example/jobs/1';
    expect(c(u, 'adzuna')).toMatchObject({ platform: 'none', tier: 'never', reason: 'host_unknown' });
    expect(c(u, 'adzuna', { APPLY_ALLOW_UNKNOWN_HOSTS: 'TRUE' }).platform).toBe('none');
    expect(c(u, 'adzuna', { APPLY_ALLOW_UNKNOWN_HOSTS: 'true' })).toMatchObject({ platform: 'browser', tier: 'agent' });
    expect(c('http://careers.acme.example/jobs/1', 'adzuna', { APPLY_ALLOW_UNKNOWN_HOSTS: 'true' }).platform).toBe('browser');
  });

  it('every ATS_REGISTRY id has a per-host cap catalog entry', () => {
    const keys = new Set(LIMITS.map((l) => l.key));
    for (const a of ATS_REGISTRY) {
      expect((APPLY_HOST_PLATFORM_IDS as readonly string[]).includes(a.id)).toBe(true);
      expect(keys.has(hostCapKey(a.id))).toBe(true);
    }
  });

  it('registry tiers follow the ruling (workable and smartrecruiters are fast now that their recipes ship)', () => {
    const t = Object.fromEntries(ATS_REGISTRY.map((a) => [a.id, a.tier]));
    expect(t).toMatchObject({ greenhouse: 'fast', lever: 'fast', ashby: 'fast', workable: 'fast', smartrecruiters: 'fast', workday: 'agent', recruitee: 'agent', personio: 'agent' });
    expect(ATS_REGISTRY.find((a) => a.id === 'workday')?.accountRequired).toBe(true);
  });
});
