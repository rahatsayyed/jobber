import { describe, it, expect } from 'vitest';
import { hostMatches, lookAlikeAtsHost } from '../src/lib/hostClass.js';
import { detect as greenhouse } from '../src/ats/greenhouse.js';
import { detect as lever } from '../src/ats/lever.js';
import { detect as workday } from '../src/ats/workday.js';
import { detect as ashby } from '../src/ats/ashby.js';

describe('hostMatches', () => {
  it.each([
    ['https://boards.greenhouse.io/acme/jobs/1', 'greenhouse.io', true],
    ['https://job-boards.greenhouse.io/acme/jobs/1', 'greenhouse.io', true],
    ['https://greenhouse.io/x', 'greenhouse.io', true],
    ['https://BOARDS.Greenhouse.IO./x', 'greenhouse.io', true],
    ['http://boards.greenhouse.io/x', 'greenhouse.io', true],
    ['https://jobs.eu.lever.co/acme/1', 'lever.co', true],
    ['https://evil-greenhouse.io/x', 'greenhouse.io', false],
    ['https://boards.greenhouse.io.evil.com/x', 'greenhouse.io', false],
    ['https://boards.greenhouse.io@evil-domain.com/x', 'greenhouse.io', false],
    ['https://user:pw@boards.greenhouse.io/x', 'greenhouse.io', false],
    ['https://acme.myworkdayjobs.com.phishing.net/x', 'myworkdayjobs.com', false],
    ['https://lever.co.attacker.org/x', 'lever.co', false],
    ['javascript://boards.greenhouse.io/x', 'greenhouse.io', false],
    ['ftp://boards.greenhouse.io/x', 'greenhouse.io', false],
    ['not a url', 'lever.co', false],
  ])('%s vs %s -> %s', (url, apex, ok) => { expect(hostMatches(url, apex)).toBe(ok); });
});

describe('lookAlikeAtsHost', () => {
  it.each([
    ['https://evil-greenhouse.io/acme/jobs/1', true],
    ['https://evilgreenhouse.io/acme/jobs/1', true],
    ['https://boards.greenhouse.io.evil.com/x', true],
    ['https://boards.greenhouse.io@evil-domain.com/x', true],
    ['https://acme.myworkdayjobs.com.phishing.net/x', true],
    ['https://lever.co.attacker.org/x', true],
    ['https://jobs.ashbyhq.com.evil.io/x', true],
    ['https://evillinkedin.com/jobs/1', true],
    ['javascript://boards.greenhouse.io/x', true],
    ['https://boards.greenhouse.io/acme/jobs/1', false],
    ['https://jobs.eu.lever.co/acme/1', false],
    ['https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1', false],
    ['https://jobs.ashbyhq.com/acme/1', false],
    ['https://www.linkedin.com/jobs/view/1', false],
    ['https://clever.com/x', false],
    ['https://jobs.newats.example/apply/1', false],
    ['not a url', false],
  ])('%s -> %s', (url, bad) => { expect(lookAlikeAtsHost(url)).toBe(bad); });
});

describe('ATS detect uses apex matching', () => {
  it('rejects look-alikes for all four platforms', () => {
    expect(greenhouse('https://evil-greenhouse.io/acme/jobs/1')).toBeNull();
    expect(lever('https://lever.co.attacker.org/acme/1')).toBeNull();
    expect(workday('https://acme.myworkdayjobs.com.phishing.net/job/1')).toBeNull();
    expect(ashby('https://jobs.ashbyhq.com.evil.io/acme/1')).toBeNull();
    expect(greenhouse('javascript://boards.greenhouse.io/acme/jobs/1')).toBeNull();
  });
  it('still accepts the real hosts', () => {
    expect(greenhouse('https://boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse');
    expect(lever('https://jobs.lever.co/acme/1')).toBe('lever');
    expect(workday('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1')).toBe('workday');
    expect(ashby('https://jobs.ashbyhq.com/acme/1')).toBe('ashby');
  });
});
