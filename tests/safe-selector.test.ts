import { describe, expect, it } from 'vitest';
import { isSafeJsonPath, isSafeSelector } from '../src/lib/safeSelector.js';

describe('isSafeSelector', () => {
  it.each([
    'li.job', 'a', '.job-card', '#jobs', 'div#list.row', 'a[href]', 'span[data-field=location]', 'a[data-qa="job-title"]',
    'ul.jobs li', 'div[aria-label=Jobs] a.title', 'h2.title',
  ])('accepts %s', (s) => { expect(isSafeSelector(s)).toBe(true); });

  it.each([
    '', ' ', 'li:has(a)', 'a:not(.x)', 'li:nth-child(2)', 'ul > li', 'ul + li', 'ul ~ li', 'a, b', '*', 'ul li a', 'a  b',
    'a[onclick]', 'a[href^="http"]', 'a[href*=job]', 'a[style="x"]', 'a[data-x=y z]', 'div\\.x', '.a.b[', '>a', 'a>', 'A', 'li.job ',
    'a[href=javascript:x]','../x', 'a/b', '#', '.', 'a'.repeat(17), `a.${'b'.repeat(161)}`,
  ])('rejects %j', (s) => { expect(isSafeSelector(s)).toBe(false); });

  it('rejects non-strings and the 160 char limit', () => {
    expect(isSafeSelector(undefined)).toBe(false);
    expect(isSafeSelector(5)).toBe(false);
    expect(isSafeSelector(`.${'a'.repeat(63)} .${'b'.repeat(63)}`)).toBe(true);
    expect(isSafeSelector(`.${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}`)).toBe(false);
  });
});

describe('isSafeJsonPath', () => {
  it.each(['jobs', 'data.jobs', 'locations[0].name', 'a-b.c_d'])('accepts %s', (s) => { expect(isSafeJsonPath(s)).toBe(true); });
  it.each(['', '.a', 'a.', 'a..b', '__proto__', 'a.constructor', 'a.prototype', 'a[x]', 'a[-1]', '$.a', 'a b', 'a[1000]', 'a()'])('rejects %j', (s) => { expect(isSafeJsonPath(s)).toBe(false); });
});
