// tests/settings-value-check.test.ts
import { describe, it, expect } from 'vitest';
import { validateEnvValue, validateCross } from '../src/settings/valueCheck.js';
import { FIXTURE_CATALOG, specOf } from './fixtures/settings/catalog.fixture.js';

const ok = (k: string, v: string) => expect(validateEnvValue(specOf(k), v)).toBeNull();
const bad = (k: string, v: string) => expect(validateEnvValue(specOf(k), v)).toEqual(expect.any(String));

describe('validateEnvValue', () => {
  it('bool', () => {
    ok('FX_FLAG', 'true');
    ok('FX_FLAG', 'false');
    bad('FX_FLAG', 'yes');
    bad('FX_FLAG', '1');
    bad('FX_FLAG', '');
  });
  it('bool with allowed 1/0 or 1 only', () => {
    ok('FX_ZERO_ONE', '0');
    ok('FX_ZERO_ONE', '1');
    bad('FX_ZERO_ONE', 'true');
    ok('FX_ONE_ONLY', '1');
    bad('FX_ONE_ONLY', '0');
    bad('FX_ONE_ONLY', 'true');
  });
  it('int', () => {
    ok('FX_MAX_PER_DAY', '20');
    ok('FX_MAX_PER_DAY', '007');
    bad('FX_MAX_PER_DAY', '1e3');
    bad('FX_MAX_PER_DAY', '-1');
    bad('FX_MAX_PER_DAY', '501');
    bad('FX_MAX_PER_DAY', '0');
    bad('FX_MAX_PER_DAY', '');
    bad('FX_MAX_PER_DAY', '1.5');
  });
  it('enum', () => {
    ok('FX_MODE', 'oidc');
    bad('FX_MODE', 'OIDC');
    bad('FX_MODE', 'other');
  });
  it('string', () => {
    ok('FX_NAME', 'hello');
    bad('FX_NAME', 'a'.repeat(41));
    bad('FX_NAME', 'a\nb');
    bad('FX_NAME', 'a\rb');
  });
  it('path', () => {
    ok('FX_DATA_DIR', 'some/dir');
    bad('FX_DATA_DIR', 'a\0b');
    bad('FX_DATA_DIR', 'a\nb');
    bad('FX_DATA_DIR', 'x'.repeat(1025));
    ok('FX_DATA_DIR', 'x'.repeat(1024));
  });
  it('url', () => {
    ok('FX_REDIRECT_URL', 'https://example.com/cb');
    ok('FX_REDIRECT_URL', 'http://127.0.0.1:8787/cb');
    ok('FX_REDIRECT_URL', 'http://localhost:8787/cb');
    bad('FX_REDIRECT_URL', 'http://example.com/cb');
    bad('FX_REDIRECT_URL', 'https://user:pw@example.com/');
    bad('FX_REDIRECT_URL', 'not a url');
    bad('FX_REDIRECT_URL', 'ftp://example.com');
  });
  it('email', () => {
    ok('FX_ALLOWED_EMAIL', 'Me@Example.com');
    bad('FX_ALLOWED_EMAIL', 'nope');
    bad('FX_ALLOWED_EMAIL', 'a b@c.d');
    bad('FX_ALLOWED_EMAIL', '');
  });
  it('list', () => {
    ok('FX_ALLOWED_URLS', 'https://a.com,https://b.com');
    bad('FX_ALLOWED_URLS', '');
    bad('FX_ALLOWED_URLS', 'a,,b');
  });
  it('intList with itemCount and per-item range', () => {
    ok('FX_CADENCE_GAPS_DAYS', '3,4,5,7');
    bad('FX_CADENCE_GAPS_DAYS', '3,4,5');
    bad('FX_CADENCE_GAPS_DAYS', '3,4,5,7,9');
    bad('FX_CADENCE_GAPS_DAYS', '3,4,5,0');
    bad('FX_CADENCE_GAPS_DAYS', '3,4,5,61');
    bad('FX_CADENCE_GAPS_DAYS', '3,4,x,7');
  });
  it('secret: no CR/LF, maxLen, reasons never echo the value', () => {
    ok('FX_API_KEY', 'FIXTURE-SECRET-1');
    bad('FX_API_KEY', 'FIXTURE-SECRET-2\nmore');
    bad('FX_API_KEY', 'FIXTURE-SECRET-3' + 'x'.repeat(2000));
    bad('FX_BOT_TOKEN', 'FIXTURE-SECRET-4' + 'x'.repeat(200));
    for (const v of ['FIXTURE-SECRET-5\nx', 'FIXTURE-SECRET-6' + 'y'.repeat(2100)]) {
      const r = validateEnvValue(specOf('FX_API_KEY'), v)!;
      expect(r).not.toContain('FIXTURE-SECRET');
    }
  });
  it('secret-flagged non-secret-typed spec also does not echo', () => {
    const s = { ...specOf('FX_MAX_PER_DAY'), secret: true };
    const r = validateEnvValue(s, 'FIXTURE-SECRET-7')!;
    expect(r).not.toContain('FIXTURE-SECRET');
  });
});

describe('validateCross', () => {
  it('flags a min/max pair with min above max', () => {
    const msgs = validateCross({ EMAIL_DRIP_MIN_BATCH: '5', EMAIL_DRIP_MAX_BATCH: '2' }, FIXTURE_CATALOG);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('EMAIL_DRIP_MIN_BATCH');
  });
  it('is clean for a good pair and ignores keys outside the catalog', () => {
    expect(validateCross({ EMAIL_DRIP_MIN_BATCH: '1', EMAIL_DRIP_MAX_BATCH: '2' }, FIXTURE_CATALOG)).toEqual([]);
    expect(validateCross({ EMAIL_DRIP_MIN_GAP_MIN: '9', EMAIL_DRIP_MAX_GAP_MIN: '1' }, FIXTURE_CATALOG)).toEqual([]);
  });
});
