import { describe, it, expect } from 'vitest';
import { isLinkedInUrl, isProfileUrl, classifyUrl, isBlockedPath, profileKeyOf } from '../src/linkedin/urls.js';

describe('isLinkedInUrl', () => {
  it('accepts https linkedin hosts only', () => {
    expect(isLinkedInUrl('https://www.linkedin.com/in/jane-example/')).toBe(true);
    expect(isLinkedInUrl('https://linkedin.com/feed/')).toBe(true);
    for (const bad of [
      'http://www.linkedin.com/in/x', 'https://evil-linkedin.com/in/x', 'https://linkedin.com.evil.io/in/x',
      'https://user:pw@www.linkedin.com/in/x', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', '',
    ]) expect(isLinkedInUrl(bad)).toBe(false);
  });
});

describe('classifyUrl', () => {
  it.each([
    ['https://www.linkedin.com/in/jane-example/', 'profile'],
    ['https://www.linkedin.com/search/results/people/?keywords=x', 'search'],
    ['https://www.linkedin.com/feed/', 'feed'],
    ['https://www.linkedin.com/messaging/thread/2-abc/', 'messaging'],
    ['https://www.linkedin.com/mynetwork/invitation-manager/', 'invitations'],
    ['https://www.linkedin.com/jobs/view/123/', 'jobs'],
    ['https://www.linkedin.com/login', 'login'],
    ['https://www.linkedin.com/uas/login?x=1', 'login'],
    ['https://www.linkedin.com/authwall?trk=x', 'login'],
    ['https://www.linkedin.com/checkpoint/challenge/abc', 'checkpoint'],
    ['https://www.linkedin.com/company/acme/', 'other'],
  ])('%s -> %s', (url, kind) => expect(classifyUrl(url)).toBe(kind));
});

describe('isBlockedPath', () => {
  it('blocks logout, settings and premium paths', () => {
    for (const p of ['/m/logout', '/uas/logout', '/psettings/', '/mypreferences/d/categories/account', '/premium/products', '/sales/home', '/help/linkedin'])
      expect(isBlockedPath('https://www.linkedin.com' + p).blocked).toBe(true);
    expect(isBlockedPath('https://www.linkedin.com/in/jane-example/').blocked).toBe(false);
  });
});

describe('profile keys', () => {
  it('match the 6A people.profile_key shape', () => {
    expect(profileKeyOf('https://www.linkedin.com/in/Jane-Example/?trk=x')).toBe('linkedin.com/in/jane-example');
    expect(isProfileUrl('https://www.linkedin.com/in/jane-example/')).toBe(true);
    expect(isProfileUrl('https://www.linkedin.com/company/acme/')).toBe(false);
  });
});
