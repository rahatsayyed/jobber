// tests/stack-stale.test.ts
// The "running with old settings" check: a key a window never received must not count as stale, and `up` finds stale idle windows.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wakeStartDiff, wakeStartValues } from '../src/scheduler/wakeWindowStart.js';
import { staleKeys } from '../src/stack/stale.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stack-stale-'));
  mkdirSync(join(root, '.jobber', 'window-start'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const fs = { exists: (p: string) => existsSync(p), read: (p: string) => readFileSync(p, 'utf8') };
const rec = (w: string, o: Record<string, string>): void => writeFileSync(join(root, '.jobber', 'window-start', `${w}.json`), JSON.stringify(o));

describe('wake window start record', () => {
  it('records only keys the window received; the dry-run flag is always there', () => {
    const v = wakeStartValues({ JOBBER_DRY_RUN: 'false', NAUKRI_MAX_MESSAGES_PER_DAY: '600' });
    expect(v).toMatchObject({ _fmt: '2', JOBBER_DRY_RUN: 'false', NAUKRI_MAX_MESSAGES_PER_DAY: '600' });
    expect('MATCH_THRESHOLD' in v).toBe(false);
    expect('MAX_APPLIES_PER_DAY' in v).toBe(false);
    // .env has the values but the window never got them: not stale
    expect(wakeStartDiff(v, { JOBBER_DRY_RUN: 'false', NAUKRI_MAX_MESSAGES_PER_DAY: '600', MATCH_THRESHOLD: '4', MAX_APPLIES_PER_DAY: '100' })).toEqual([]);
  });

  it('an old-format record with empty values (not passed) is not stale, a real change still is', () => {
    const old = { JOBBER_DRY_RUN: 'false', MAX_APPLIES_PER_DAY: '', MATCH_THRESHOLD: '', NAUKRI_MAX_MESSAGES_PER_DAY: '600' };
    const now = { JOBBER_DRY_RUN: 'false', MAX_APPLIES_PER_DAY: '100', MATCH_THRESHOLD: '4', NAUKRI_MAX_MESSAGES_PER_DAY: '600' };
    expect(wakeStartDiff(old, now)).toEqual([]);
    expect(wakeStartDiff(old, { ...now, NAUKRI_MAX_MESSAGES_PER_DAY: '5' })).toEqual(['NAUKRI_MAX_MESSAGES_PER_DAY']);
    expect(wakeStartDiff(old, { ...now, JOBBER_DRY_RUN: 'true' })).toEqual(['JOBBER_DRY_RUN']);
  });
});

describe('staleKeys', () => {
  it('finds a stale wake and mail window and ignores a fresh, unknown or record-less one', () => {
    rec('boards', { JOBBER_DRY_RUN: 'false', _fmt: '2', NAUKRI_MAX_MESSAGES_PER_DAY: '600' });
    rec('mail', { SEND_LIMIT_PER_RUN: '100000', JOBBER_DRY_RUN: 'false' });
    rec('linkedin', { JOBBER_DRY_RUN: 'false', APPLY_LINKEDIN_EASY: 'true', LINKEDIN_MAX_INVITES_PER_DAY: '100' });
    const env = { JOBBER_DRY_RUN: 'false', NAUKRI_MAX_MESSAGES_PER_DAY: '5', EMAIL_MAX_PER_DAY: '50', LINKEDIN_MAX_INVITES_PER_DAY: '100' };
    expect(staleKeys(root, fs, 'boards', env)).toEqual(['NAUKRI_MAX_MESSAGES_PER_DAY']);
    expect(staleKeys(root, fs, 'mail', env)).toEqual(['SEND_LIMIT_PER_RUN']);
    expect(staleKeys(root, fs, 'linkedin', env)).toEqual([]);
    expect(staleKeys(root, fs, 'apply', env)).toEqual([]);
    expect(staleKeys(root, fs, 'chat', env)).toEqual([]);
  });
});
