// tests/setup-env-empty-comment.test.ts
// I1 of the final 7B review: `KEY=   # comment` (empty value plus comment) is an empty value.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupToolingChecks } from '../src/platform/checksSetup.js';
import type { DoctorContext } from '../src/platform/doctor.js';
import { envEntries, envFileValue, updateEnvText } from '../src/setup/envWriter.js';

const example = readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8');
const KEYS = ['ADZUNA_APP_ID', 'SERPER_API_KEY', 'HUNTER_API_KEY'];

function ctxWith(env: string): DoctorContext {
  const p = '/proj/.env';
  return {
    root: '/proj',
    env: {},
    run: async () => ({ stdout: '', code: 1 }),
    fs: {
      exists: (x) => x === p,
      read: (x) => {
        if (x !== p) throw new Error('ENOENT');
        return env;
      },
      mode: () => 0o600,
      list: () => [],
    },
  };
}

describe('empty value plus comment', () => {
  it('reads the .env.example shapes as empty values', () => {
    for (const k of KEYS) expect(envFileValue(example, k)).toBe('');
    expect(envFileValue(example, 'HUNTER_MONTHLY_CAP')).toBe('50');
    expect(envEntries(example).get('SERPER_API_KEY')?.inlineComment).toBe(true);
  });

  it('a no-space `KEY=#x` stays a value (loaders read it that way)', () => {
    expect(envFileValue('A=#x\n', 'A')).toBe('#x');
  });

  it('the writer moves the comment above and leaves KEY= , then is a no-op', () => {
    const first = updateEnvText(example, Object.fromEntries(KEYS.map((k) => [k, ''])));
    expect(first.changed.sort()).toEqual([...KEYS].sort());
    expect(first.text).toContain('# serper.dev');
    expect(first.text).toMatch(/^SERPER_API_KEY=$/m);
    const second = updateEnvText(first.text, Object.fromEntries(KEYS.map((k) => [k, ''])));
    expect(second.changed).toEqual([]);
    expect(second.text).toBe(first.text);
  });

  it('onlyIfMissing treats the line as missing and fills it', () => {
    const r = updateEnvText('SERPER_API_KEY=            # serper.dev\n', { SERPER_API_KEY: 'abc' }, { onlyIfMissing: true });
    expect(r.text).toBe('# serper.dev\nSERPER_API_KEY=abc\n');
  });

  it('doctor env-inline-comments warns before and passes after the rewrite', async () => {
    const check = setupToolingChecks.find((c) => c.id === 'env-inline-comments')!;
    const before = await check.run(ctxWith('SERPER_API_KEY=            # serper.dev\n'));
    expect(before.status).toBe('warn');
    const fixed = updateEnvText('SERPER_API_KEY=            # serper.dev\n', { SERPER_API_KEY: '' }).text;
    const after = await check.run(ctxWith(fixed));
    expect(after.status).toBe('pass');
  });
});
