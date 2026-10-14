// tests/setup-resume-path.test.ts
// M2 of the final 7B review: typed resume paths are normalized, and project secrets are refused.
import { describe, expect, it } from 'vitest';
import { checkPath, normalizeUserPath } from '../src/setup/steps/resume.js';

const HOME = '/home/u';
const ROOT = '/home/u/work/jobber';

describe('normalizeUserPath', () => {
  it('expands ~, strips matching quotes and unescapes backslash-space', () => {
    expect(normalizeUserPath('~/resume.pdf', HOME)).toBe('/home/u/resume.pdf');
    expect(normalizeUserPath('~', HOME)).toBe(HOME);
    expect(normalizeUserPath('"/home/u/My Resume.pdf"', HOME)).toBe('/home/u/My Resume.pdf');
    expect(normalizeUserPath("'/home/u/cv.txt'", HOME)).toBe('/home/u/cv.txt');
    expect(normalizeUserPath('/home/u/My\\ Resume.pdf', HOME)).toBe('/home/u/My Resume.pdf');
    expect(normalizeUserPath('  /home/u/a.md  ', HOME)).toBe('/home/u/a.md');
  });
});

describe('checkPath', () => {
  it('accepts normal and dragged paths', () => {
    expect(checkPath('~/resume.pdf', HOME, ROOT)).toBeNull();
    expect(checkPath('/home/u/My\\ Resume.pdf', HOME, ROOT)).toBeNull();
    expect(checkPath('"/home/u/My Resume.md"', HOME, ROOT)).toBeNull();
  });
  it('rejects outside paths and docx as before', () => {
    expect(checkPath('/etc/passwd', HOME, ROOT)).toMatch(/inside your home/);
    expect(checkPath('~/cv.docx', HOME, ROOT)).not.toBeNull();
    expect(checkPath('', HOME, ROOT)).toBe('Enter a file path');
  });
  it('rejects env files, secrets, user-data and the database of this project', () => {
    for (const p of [
      `${ROOT}/.env`,
      `${ROOT}/.env.bak-2026-10-14`,
      `${ROOT}/secrets/gmail-credentials.json`,
      `${ROOT}/user-data/resume.json`,
      `${ROOT}/data.sqlite`,
      `${ROOT}/data.sqlite-wal`,
      `'${ROOT}/.env'`,
    ]) {
      expect(checkPath(p, HOME, ROOT), p).toMatch(/secrets or data/);
    }
  });
  it('rejects a custom data dir and allows a similarly named file elsewhere', () => {
    expect(checkPath('~/jobber-data/resume.json', HOME, ROOT, '/home/u/jobber-data')).toMatch(/secrets or data/);
    expect(checkPath(`${ROOT}/docs/.env.md`, HOME, ROOT)).toBeNull();
    expect(checkPath(`${ROOT}/user-data-notes.md`, HOME, ROOT)).toBeNull();
  });
});
