// Owner CLI: the jobs you apply to by hand (Easy Apply is off, or the machine could not finish the form).
//   npm run apply:manual -- list
//   npm run apply:manual -- done <id>    you applied: counts as an application in the funnel, follow-ups treat it as applied
//   npm run apply:manual -- skip <id>    you will not apply: leaves the list for good
// <id> is the number `list` prints. The tailored resume PDF is re-rendered on demand if it is missing. Nothing here opens a browser or sends anything.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import type { ResolveDeps } from '../src/linkedin/attachment.js';
import { buildManualQueue, markDone, markSkip, withResumePdfs } from '../src/manual/manualApply.js';

export interface CliDeps { db?: BetterSqlite3.Database; env?: NodeJS.ProcessEnv; now?: () => Date; resolve?: ResolveDeps }

const USAGE = 'usage: npm run apply:manual -- list | done <id> | skip <id>';

export async function run(argv: string[], deps: CliDeps = {}): Promise<{ code: number; lines: string[] }> {
  const [cmd, arg, ...extra] = argv;
  if (!cmd || !['list', 'done', 'skip'].includes(cmd) || extra.length > 0) return { code: 2, lines: [USAGE] };
  const env = deps.env ?? process.env;
  const db = deps.db ?? openDb(dbPath());
  try {
    if (cmd === 'list') {
      if (arg !== undefined) return { code: 2, lines: [USAGE] };
      const v = buildManualQueue(db, env);
      if (!v.count) return { code: 0, lines: ['Nothing waits for you to apply by hand.'] };
      const items = await withResumePdfs(db, v.items, deps.resolve);
      const lines = [`${v.count} job${v.count === 1 ? '' : 's'} to apply by hand:`];
      for (const i of items) {
        lines.push(`#${i.id} ${i.title || '(no title)'} | ${i.company || '-'} | ${i.platform} | ${i.reason}`);
        lines.push(`    why: ${i.fail_reason}`);
        lines.push(`    open: ${i.open_url}`);
        lines.push(`    resume: ${i.resume_pdf ?? '(no tailored resume on file)'}`);
        if (i.ats_note) lines.push(`    note: ${i.ats_note}`);
      }
      lines.push('', 'After applying: npm run apply:manual -- done <id>   (or skip <id>)');
      return { code: 0, lines };
    }
    const id = Number(arg);
    if (!arg || !/^\d{1,9}$/.test(arg) || !Number.isSafeInteger(id)) return { code: 2, lines: [USAGE] };
    const r = cmd === 'done' ? markDone(db, id, env, deps.now?.()) : markSkip(db, id, env);
    if (!r.ok) return { code: 1, lines: [r.reason] };
    return { code: 0, lines: [`${cmd === 'done' ? 'recorded as applied by you' : 'skipped'}: ${r.title || r.job_id} (job ${r.job_id})`] };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2)).then((r) => {
    for (const l of r.lines) console.log(l);
    process.exit(r.code);
  });
}
