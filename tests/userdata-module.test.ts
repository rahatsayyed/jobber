// tests/userdata-module.test.ts
import { describe, it, expect } from 'vitest';
import {
  LEGACY_PATHS,
  USER_FILES,
  missingUserDataMessage,
  planInit,
  planMigration,
  userDataDir,
  userDataPath,
} from '../src/lib/userData.js';

describe('userDataDir', () => {
  it('defaults to <root>/user-data', () => {
    expect(userDataDir({}, '/p')).toBe('/p/user-data');
  });
  it('honours JOBAPPLIER_USER_DATA, relative to the root or absolute, and ignores blanks', () => {
    expect(userDataDir({ JOBAPPLIER_USER_DATA: 'user-data.example' }, '/p')).toBe('/p/user-data.example');
    expect(userDataDir({ JOBAPPLIER_USER_DATA: '/abs/dir' }, '/p')).toBe('/abs/dir');
    expect(userDataDir({ JOBAPPLIER_USER_DATA: '   ' }, '/p')).toBe('/p/user-data');
  });
});

describe('userDataPath and the missing-file message', () => {
  it('joins the directory and the file name', () => {
    expect(userDataPath('resume.json', {}, '/p')).toBe('/p/user-data/resume.json');
  });
  it('tells the user how to fix a missing file', () => {
    const msg = missingUserDataMessage('resume.json');
    expect(msg).toContain('user-data/resume.json');
    expect(msg).toContain('init');
  });
});

describe('planMigration', () => {
  it('copies each existing legacy file whose target is missing, and never overwrites a target', () => {
    const existing = new Set([
      '/p/input/resume.json',
      '/p/config/languages.json',
      '/p/config/fact-gate.json',
      '/p/user-data/fact-gate.json',
    ]);
    const ops = planMigration('/p', (f) => existing.has(f), {});
    expect(ops).toEqual([
      { from: '/p/input/resume.json', to: '/p/user-data/resume.json' },
      { from: '/p/config/languages.json', to: '/p/user-data/languages.json' },
    ]);
  });
  it('covers every user file with at least one legacy path', () => {
    // profile.json is new with the setup wizard: it has no legacy location.
    expect(LEGACY_PATHS['profile.json']).toEqual([]);
    for (const f of USER_FILES.filter((x) => x !== 'profile.json')) {
      expect(LEGACY_PATHS[f].length).toBeGreaterThan(0);
    }
  });
});

describe('planInit', () => {
  it('copies the template for each missing file only', () => {
    const existing = new Set(['/p/user-data/resume.json']);
    const ops = planInit('/p', (f) => existing.has(f), {});
    expect(ops.map((o) => o.to.split('/').pop()).sort()).toEqual(USER_FILES.filter((f) => f !== 'resume.json').sort());
    expect(ops.map((o) => o.to)).toContain('/p/user-data/profile.json');
    for (const op of ops) expect(op.from.startsWith('/p/user-data.example/')).toBe(true);
  });
});
