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

describe('hnDomainCheck', () => {
  const hn = (d: string | null) => ({ source: 'hackernews', description: d });
  it('matched', () => expect(hnDomainCheck(hn('apply: jobs@acme.io'), 'careers.acme.io')).toBe('matched'));
  it('unmatched', () => expect(hnDomainCheck(hn('apply: jobs@acme.io'), 'evil-acme.io')).toBe('unmatched'));
  it('no domain', () => expect(hnDomainCheck(hn('no links here'), 'acme.io')).toBe('no_domain_in_posting'));
  it('null description', () => expect(hnDomainCheck(hn(null), 'acme.io')).toBe('no_domain_in_posting'));
  it('non-HN is not_applicable', () =>
    expect(hnDomainCheck({ source: 'adzuna', description: null }, 'acme.io')).toBe('not_applicable'));
});
