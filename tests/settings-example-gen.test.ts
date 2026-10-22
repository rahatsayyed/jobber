// tests/settings-example-gen.test.ts
// Plan 8H, Task 3: .env.example is generated from the catalog. Golden round trip on a fixture catalog, the real file
// equals the committed one, a hand edit fails --check, shipped safe values. Hermetic: never reads .env.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installNoRealEnv, repoRoot } from './helpers/noRealEnv.js';
import { ENV_CATALOG } from '../src/settings/envCatalog.js';
import { ENV_EXAMPLE_HEADER, renderEnvExample } from '../src/settings/exampleGen.js';
import { isSecret } from '../src/settings/types.js';
import { FIXTURE_CATALOG } from './fixtures/settings/catalog.fixture.js';

const guard = installNoRealEnv();
afterAll(() => guard.restore());

const committed = readFileSync(join(repoRoot, '.env.example'), 'utf8');
const lines = committed.split(/\r?\n/);
const val = (k: string): string | undefined => {
  const l = lines.find((x) => x.startsWith(`${k}=`) || x.startsWith(`# ${k}=`));
  return l?.slice(l.indexOf('=') + 1);
};

describe('renderEnvExample', () => {
  it('matches the golden file for the fixture catalog', () => {
    const golden = readFileSync(join(repoRoot, 'tests/fixtures/settings/example.golden.env'), 'utf8');
    expect(renderEnvExample(FIXTURE_CATALOG, 'HEADER')).toBe(golden);
  });

  it('is deterministic', () => {
    expect(renderEnvExample(ENV_CATALOG, ENV_EXAMPLE_HEADER)).toBe(renderEnvExample(ENV_CATALOG, ENV_EXAMPLE_HEADER));
  });
});

describe('the committed .env.example', () => {
  it('equals the file generated from the real catalog', () => {
    expect(committed).toBe(renderEnvExample(ENV_CATALOG, ENV_EXAMPLE_HEADER));
  });

  it('lists every catalog key exactly once', () => {
    const keys = lines.map((l) => /^(?:#\s?)?([A-Z][A-Z0-9_]*)=/.exec(l)?.[1]).filter((k): k is string => !!k);
    expect(keys.sort()).toEqual(ENV_CATALOG.map((s) => s.key).sort());
  });

  it('puts every comment above its key: no inline comment, no em or en dash', () => {
    expect(lines.filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l) && l.includes('#'))).toEqual([]);
    expect(committed).not.toMatch(/[–—]/);
    lines.forEach((l, i) => {
      if (/^(?:#\s?)?[A-Z][A-Z0-9_]*=/.test(l)) expect(lines[i - 1]?.startsWith('#'), `${l} needs a comment above`).toBe(true);
    });
  });

  it('notes in the header that it is generated', () => {
    expect(committed).toContain('npm run env:example');
  });

  it('ships the safe values', () => {
    expect(val('JOBBER_DRY_RUN')).toBe('true');
    expect(val('WEB_SETTINGS_EDIT')).toBe('false');
    expect(val('WEB_SETTINGS_REMOTE_SAFETY')).toBe('false');
    expect(val('WEB_AUTH_MODE')).toBe('token');
    for (const s of ENV_CATALOG.filter(isSecret)) expect(val(s.key), s.key).toBe('');
    expect(val('CLASSIFIER_MODEL')).toBe('');
  });
});

describe('npm run env:example -- --check', () => {
  const run = (args: string[]) =>
    spawnSync('npx', ['tsx', join(repoRoot, 'scripts/gen-env-example.ts'), ...args], { cwd: repoRoot, encoding: 'utf8' });

  it('passes on the committed file and fails after a hand edit of a temp copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envex-'));
    try {
      const copy = join(dir, 'example');
      copyFileSync(join(repoRoot, '.env.example'), copy);
      expect(run(['--check', '--file', copy]).status).toBe(0);
      writeFileSync(copy, committed.replace('JOBBER_DRY_RUN=true', 'JOBBER_DRY_RUN=false'));
      const r = run(['--check', '--file', copy]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('differs from the catalog');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
