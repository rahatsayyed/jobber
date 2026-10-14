import { describe, expect, it } from 'vitest';
import { doctorRegression, evaluateTestReport, fingerprint } from '../src/update/verify.js';

const root = '/proj';
const allowed = { 'tests/renderChecked.test.ts': 4, 'tests/resume.test.ts': 1 };
const file = (name: string, failed: number, passed = 2) => ({
  name,
  status: failed > 0 ? 'failed' : 'passed',
  assertionResults: [
    ...Array.from({ length: failed }, () => ({ status: 'failed' })),
    ...Array.from({ length: passed }, () => ({ status: 'passed' })),
  ],
});

describe('evaluateTestReport', () => {
  it('accepts exactly the known failures', () => {
    const r = evaluateTestReport(
      { testResults: [file('/proj/tests/renderChecked.test.ts', 4), file('/proj/tests/resume.test.ts', 1), file('/proj/tests/a.test.ts', 0)] },
      allowed, root,
    );
    expect(r.ok).toBe(true);
    expect(r.unexpected).toEqual([]);
    expect(r.counts['tests/renderChecked.test.ts']).toBe(4);
  });
  it('rejects a fifth failure in a known file', () => {
    const r = evaluateTestReport({ testResults: [file('/proj/tests/renderChecked.test.ts', 5)] }, allowed, root);
    expect(r.ok).toBe(false);
    expect(r.unexpected).toContain('tests/renderChecked.test.ts');
  });
  it('rejects a failure in another file', () => {
    const r = evaluateTestReport({ testResults: [file('/proj/tests/other.test.ts', 1)] }, allowed, root);
    expect(r.ok).toBe(false);
    expect(r.unexpected).toEqual(['tests/other.test.ts']);
  });
  it('counts a file that failed to load as a failure', () => {
    const r = evaluateTestReport({ testResults: [{ name: '/proj/tests/broken.test.ts', status: 'failed', assertionResults: [] }] }, allowed, root);
    expect(r.ok).toBe(false);
  });
});

describe('doctorRegression', () => {
  it('only flags new failures', () => {
    const before = [{ id: 'a', status: 'fail' }, { id: 'b', status: 'pass' }, { id: 'c', status: 'skip' }];
    const after = [{ id: 'a', status: 'fail' }, { id: 'b', status: 'fail' }, { id: 'c', status: 'skip' }, { id: 'd', status: 'fail' }, { id: 'e', status: 'skip' }];
    expect(doctorRegression(before, after)).toEqual(['b', 'd']);
  });
});

describe('fingerprint', () => {
  it('is stable, absent for null, sensitive to change', () => {
    expect(fingerprint(null)).toBe('absent');
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
    expect(fingerprint('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});
