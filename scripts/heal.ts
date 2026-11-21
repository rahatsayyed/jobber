// scripts/heal.ts
// Owner CLI of the self-heal system: `npm run heal -- status|list|land <id>|ignore <signature>|revert <id>`.
// `land` merges a ready fix branch (after verifying it again) and restarts what changed when idle; `revert` undoes a landed fix.
// The agent never runs this and never sets HEAL_MODE. Logic: src/heal/cli.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '../src/db.js';
import { runHealCommand } from '../src/heal/cli.js';
import { makeHealDeps } from '../src/heal/wire.js';
import { parseEnv } from '../src/platform/envFile.js';
import { stopActive } from './killSwitch.js';

const root = resolve(import.meta.dirname, '..');

function loadEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const f = join(root, '.env');
  if (existsSync(f)) for (const [k, v] of Object.entries(parseEnv(readFileSync(f, 'utf8')))) if (env[k] === undefined) env[k] = v;
  return env;
}

async function main(): Promise<number> {
  const env = loadEnv();
  const db = openDb();
  try {
    const d = makeHealDeps({ root, env, db, killed: () => stopActive(root, env).stopped });
    const r = await runHealCommand(d, process.argv.slice(2));
    for (const l of r.lines) console.log(l);
    return r.code;
  } finally {
    db.close();
  }
}

main().then((c) => process.exit(c), (e) => {
  console.error(`heal error: ${e instanceof Error ? e.message : 'unknown'}`);
  process.exit(1);
});
