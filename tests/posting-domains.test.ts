import { describe, it, expect } from 'vitest';
import { postingDomains, registrableDomain, hnDomainCheck } from '../src/lib/postingDomains.js';

describe('postingDomains', () => {
  it('extracts email domains and URL hosts, lowercased, www stripped', () => {
    const d = postingDomains('Mail Jobs@Acme.IO or see https://www.Acme-Corp.com/careers?x=1&y=2');
    expect(d).toContain('acme.io');
    expect(d).toContain('acme-corp.com');
  });
  it('ignores hxxp and drops free-mail, social, HN hosts', () => {
    const d = postingDomains(
      'hxxp://evil.example.org me@gmail.com https://linkedin.com/in/x https://news.ycombinator.com/item?id=1 https://ycombinator.com',
    );
    expect(d).toEqual([]);
  });
  it('lowercases IDN hosts', () => {
    expect(postingDomains('https://BÜCHER.de/jobs')).toContain('xn--bcher-kva.de');
  });
});

describe('registrableDomain', () => {
  it('compares subdomains and second-level suffixes', () => {
    expect(registrableDomain('careers.acme.io')).toBe('acme.io');
    expect(registrableDomain('acme.io')).toBe('acme.io');
    expect(registrableDomain('evil-acme.io')).not.toBe('acme.io');
    expect(registrableDomain('jobs.acme.co.uk')).toBe('acme.co.uk');
  });
});

describe('lookalike and shared hosts', () => {
  const hn = (d: string) => ({ source: 'hackernews', description: d });
  it('acme.io.evil.com is evil.com', () => {
    expect(hnDomainCheck(hn('see https://acme.io.evil.com/x'), 'acme.io')).toBe('unmatched');
    expect(hnDomainCheck(hn('see https://acme.io.evil.com/x'), 'evil.com')).toBe('matched');
  });
  it('userinfo trick uses the real host', () => {
    expect(postingDomains('https://acme.io@evil.com/')).toEqual(['evil.com']);
  });
  it('path segment is not a host', () => {
    expect(postingDomains('https://evil.com/acme.io')).toEqual(['evil.com']);
  });
  it('unicode resolved domain fails closed', () => {
    expect(hnDomainCheck(hn('jobs@xn--bcher-kva.de'), 'bücher.de')).toBe('unmatched');
  });
  it('shared and ATS hosts are not company evidence', () => {
    for (const u of ['https://jobs.lever.co/acme', 'https://boards.greenhouse.io/acme', 'https://acme.notion.site/x', 'https://calendly.com/a']) {
      expect(hnDomainCheck(hn(u), 'lever.co')).toBe('no_domain_in_posting');
    }
  });
  it.each([
    'https://smartrecruiters.com/acme',
    'https://jobs.smartrecruiters.com/acme',
    'https://acme.wd5.myworkdayjobs.com/site',
    'https://acme.bamboohr.com/careers',
    'https://linktr.ee/acme',
    'https://sites.google.com/view/acme',
    'https://airtable.com/shrAcme',
  ])('more shared and ATS host %s is not company evidence', (u) => {
    expect(postingDomains(u)).toEqual([]);
  });
  it('multi-tenant suffixes keep the tenant label', () => {
    expect(registrableDomain('acme.github.io')).toBe('acme.github.io');
    expect(hnDomainCheck(hn('https://acme.github.io'), 'evil.github.io')).toBe('unmatched');
    expect(hnDomainCheck(hn('https://acme.github.io'), 'acme.github.io')).toBe('matched');
  });
});

describe('hnDomainCheck', () => {
  const hn = (d: string | null) => ({ source: 'hackernews', description: d });
  it('matched', () => expect(hnDomainCheck(hn('apply: jobs@acme.io'), 'careers.acme.io')).toBe('matched'));
  it('unmatched', () => expect(hnDomainCheck(hn('apply: jobs@acme.io'), 'evil-acme.io')).toBe('unmatched'));
  it('no domain', () => expect(hnDomainCheck(hn('no links here'), 'acme.io')).toBe('no_domain_in_posting'));
  it('null description', () => expect(hnDomainCheck(hn(null), 'acme.io')).toBe('no_domain_in_posting'));
  it('non-HN is not_applicable', () =>
    expect(hnDomainCheck({ source: 'remotive', description: null }, 'acme.io')).toBe('not_applicable'));
});
