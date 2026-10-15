import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  'linkedin-apply.test.ts',
  'discover-linkedin-jobs.test.ts',
  'discover-linkedin-posts.test.ts',
];

describe('hermetic LinkedIn session tests', () => {
  for (const f of FILES) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    it(`${f} does not reference real secrets session files`, () => {
      expect(src).not.toMatch(/secrets['"/\\][^\n]*linkedin-/);
    });
    it(`${f} uses a temp session`, () => {
      expect(src).toMatch(/makeTempSession/);
      if (f.startsWith('discover-')) expect(src).toMatch(/burnerStatePath/);
    });
  }
});
