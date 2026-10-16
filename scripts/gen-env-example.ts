// scripts/gen-env-example.ts
// Writes .env.example from the settings catalog, or with --check compares and exits 1 on drift (plan 8H, Task 3).
// Run: npm run env:example   |   npm run env:example -- --check
// Optional `--file <path>` targets another file (the test uses it on a temp copy). Reads no .env.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ENV_CATALOG } from '../src/settings/envCatalog.js';
import { ENV_EXAMPLE_HEADER, renderEnvExample } from '../src/settings/exampleGen.js';

function main(argv: string[]): number {
  const check = argv.includes('--check');
  const fi = argv.indexOf('--file');
  const target = fi >= 0 && argv[fi + 1] ? resolve(argv[fi + 1]!) : join(process.cwd(), '.env.example');
  const text = renderEnvExample(ENV_CATALOG, ENV_EXAMPLE_HEADER);
  if (check) {
    const have = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (have === text) {
      process.stdout.write('.env.example is up to date.\n');
      return 0;
    }
    process.stderr.write('.env.example differs from the catalog. Run: npm run env:example\n');
    return 1;
  }
  writeFileSync(target, text);
  process.stdout.write(`wrote ${target}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
