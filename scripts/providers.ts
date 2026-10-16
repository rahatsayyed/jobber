// Owner CLI for generated job-source providers (plan 8G task 8).
//   npm run providers -- list                    id, state, approved, clean runs, spec file
//   npm run providers -- show <id>               the stored spec (data) and the provider's row
//   npm run providers -- validate <id>           re-run fixture replay (a candidate that passes becomes validated)
//   npm run providers -- approve <id> [--promote]  release the provider's held outreach rows; --promote prints a registry row to commit
//   npm run providers -- reject <id>             delete the spec and row, skip its held outreach rows
// Specs are JSON data read with a schema parse; nothing under generated/ is ever imported or executed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { ID_RE } from '../src/sources/generated/spec.js';
import { approveProvider, getProvider, listProviders, readSpecFile, registryRowFor, rejectProvider, revalidate } from '../src/sources/generated/store.js';
import { genMinJobs, genPromoteN, PROMOTE_MIN_RUN_IDS } from '../src/sources/generated/validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface CliDeps { db?: BetterSqlite3.Database; root?: string; env?: NodeJS.ProcessEnv; now?: () => Date }

export function run(argv: string[], deps: CliDeps = {}): { code: number; lines: string[] } {
  const env = deps.env ?? process.env;
  const root = deps.root ?? path.join(ROOT, 'generated');
  const now = (deps.now ?? (() => new Date()))();
  const [cmd, id, ...flags] = argv;
  const db = deps.db ?? openDb(dbPath());
  try {
    if (cmd === 'list') {
      const rows = listProviders(db);
      if (!rows.length) return { code: 0, lines: ['no generated providers'] };
      const n = genPromoteN(env);
      return {
        code: 0,
        lines: rows.map((r) => {
          const ready = r.state === 'trusted' && !r.approved ? '  READY FOR REVIEW' : '';
          return `${r.id}  ${r.state}  ${r.approved ? 'approved' : 'held'}  clean ${r.clean_runs}/${n} (needs ${PROMOTE_MIN_RUN_IDS}+ run ids)${r.reason ? `  last: ${r.reason}` : ''}${ready}`;
        }),
      };
    }
    if (!id || !ID_RE.test(id)) return { code: 2, lines: ['usage: list | show <id> | validate <id> | approve <id> [--promote] | reject <id>'] };
    const row = getProvider(db, id);
    if (!row) return { code: 1, lines: [`unknown provider ${id}`] };
    if (cmd === 'show') {
      const spec = readSpecFile(root, id);
      return { code: 0, lines: [JSON.stringify(row), spec ? JSON.stringify(spec, null, 2) : 'spec file missing or invalid'] };
    }
    if (cmd === 'validate') {
      const spec = readSpecFile(root, id);
      if (!spec) return { code: 1, lines: ['spec file missing or invalid'] };
      const r = revalidate(db, root, spec, genMinJobs(env), now);
      return { code: r.ok ? 0 : 1, lines: [r.ok ? `ok: ${r.validation?.jobs ?? 0} job(s) reproduced, state ${r.state}` : `failed: ${r.code}${r.validation?.detail ? ` (${r.validation.detail})` : ''}, state ${r.state}`] };
    }
    if (cmd === 'approve') {
      const force = flags.includes('--force');
      const r = approveProvider(db, id, now, { force });
      if (!r.ok) return { code: 1, lines: [`not approved: ${r.code}${r.code === 'not_trusted' ? ' (needs clean runs first; pass --force to override)' : ''}`] };
      const lines = [
        ...(force && row.state !== 'trusted' ? [`WARNING: ${id} is ${row.state}, not trusted; approved with --force before its clean runs`] : []),
        `approved ${id}: ${r.released ?? 0} held outreach row(s) released`,
      ];
      if (flags.includes('--promote')) {
        const spec = readSpecFile(root, id);
        lines.push('Registry row (commit it into config/platforms.json yourself; nothing is written automatically):', spec ? JSON.stringify(registryRowFor(spec), null, 2) : 'spec file missing');
      }
      return { code: 0, lines };
    }
    if (cmd === 'reject') {
      const r = rejectProvider(db, root, id);
      return r.ok ? { code: 0, lines: [`rejected ${id}: spec deleted, ${r.skipped ?? 0} held outreach row(s) skipped`] } : { code: 1, lines: [`not rejected: ${r.code}`] };
    }
    return { code: 2, lines: ['usage: list | show <id> | validate <id> | approve <id> [--promote] | reject <id>'] };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
