// scripts/permissions.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPermissionsCli } from '../src/platform/permissionsCli.js';
import { validateSets, type RawSets } from '../src/platform/permissions.js';

const root = resolve(import.meta.dirname, '..');
let result;
try {
  const sets = JSON.parse(readFileSync(resolve(root, 'config/permission-sets.json'), 'utf8')) as RawSets;
  validateSets(sets);
  result = runPermissionsCli(process.argv.slice(2), root, sets);
} catch (e) {
  result = { code: 1, lines: [e instanceof Error ? e.message : String(e)] };
}
for (const line of result.lines) console.log(line);
process.exit(result.code);
