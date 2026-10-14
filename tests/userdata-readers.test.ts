// tests/userdata-readers.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBaseResume } from '../src/resume.js';

function withUserData<T>(dir: string, fn: () => T): T {
  const before = process.env.JOBAPPLIER_USER_DATA;
  process.env.JOBAPPLIER_USER_DATA = dir;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.JOBAPPLIER_USER_DATA;
    else process.env.JOBAPPLIER_USER_DATA = before;
  }
}

describe('getBaseResume', () => {
  it('reads resume.json from the user-data directory at call time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ud-'));
    writeFileSync(join(dir, 'resume.json'), JSON.stringify({ basics: { name: 'Jane Doe' } }));
    expect(withUserData(dir, () => getBaseResume())).toEqual({ basics: { name: 'Jane Doe' } });
  });

  it('throws a helpful message when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ud-'));
    expect(() => withUserData(dir, () => getBaseResume())).toThrow(/user-data\/resume\.json.*init/s);
  });
});

describe('no source file builds a legacy personal path by hand', () => {
  const sources = ['src/resume.ts', 'src/apply/linkedin.ts', 'src/resumeFacts.ts', 'src/languageGate.ts'];
  for (const file of sources) {
    it(`${file} uses userDataPath`, () => {
      const text = readFileSync(file, 'utf8');
      expect(text).toMatch(/userDataPath\(/);
      expect(text).not.toMatch(/'config',\s*'(easy-apply-answers|fact-gate|languages)\.json'/);
      expect(text).not.toMatch(/'input',\s*'resume\.json'/);
    });
  }
});
