import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
describe('hermetic web core tests', () => {
  for (const f of ['webcore-runtime.test.ts', 'webcore-config.test.ts', 'webcore-host-caps.test.ts', 'scrape.test.ts']) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    it(`${f} does not reference the real secrets directory`, () => {
      expect(src).not.toMatch(/\bsecrets\b/);
    });
  }
  it('the runtime test keeps lock and sessions in a temp directory', () => {
    expect(readFileSync(path.join(dir, 'webcore-runtime.test.ts'), 'utf8')).toMatch(/mkdtempSync/);
  });
});
