// Owner CLI for instructions to the agent (acted on in the next wake).
//   npm run instructions -- add "<text>" [--job N] [--company key]
//   npm run instructions -- list [--all]
//   npm run instructions -- done <id> "<note>"
//   npm run instructions -- reject <id> ["<note>"]
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { addInstruction, completeInstruction, listInstructions } from '../src/owner/instructions.js';

const USAGE = 'usage: npm run instructions -- add "<text>" [--job N] [--company key] | list [--all] | done <id> "<note>" | reject <id> ["<note>"]';

function flag(args: string[], name: string): { rest: string[]; value: string | null } {
  const i = args.indexOf(name);
  if (i < 0) return { rest: args, value: null };
  return { rest: [...args.slice(0, i), ...args.slice(i + 2)], value: args[i + 1] ?? null };
}

export function run(argv: string[], deps: { db?: BetterSqlite3.Database; now?: () => Date } = {}): { code: number; lines: string[] } {
  const [cmd, ...args] = argv;
  if (!cmd || !['add', 'list', 'done', 'reject'].includes(cmd)) return { code: 2, lines: [USAGE] };
  const db = deps.db ?? openDb(dbPath());
  const now = deps.now ? deps.now() : new Date();
  if (cmd === 'add') {
    const j = flag(args, '--job');
    const c = flag(j.rest, '--company');
    const text = c.rest.join(' ');
    const job = j.value === null ? null : Number(j.value);
    if (job !== null && !Number.isInteger(job)) return { code: 2, lines: ['--job needs a number'] };
    const r = addInstruction(db, { text, job_id: job, company_key: c.value }, now);
    return r.ok ? { code: 0, lines: [`instruction #${r.id} saved (${r.scope}); the next wake acts on it`] } : { code: 1, lines: [r.error] };
  }
  if (cmd === 'list') {
    const rows = listInstructions(db, args.includes('--all') ? {} : { status: ['pending', 'in_progress'] });
    if (!rows.length) return { code: 0, lines: ['no instructions'] };
    return { code: 0, lines: rows.map((r) => `#${r.id} [${r.status}] ${r.scope}${r.job_id ? ` job ${r.job_id}` : ''}: ${r.text}${r.result_note ? ` -> ${r.result_note}` : ''}`) };
  }
  const id = Number(args[0]);
  const note = args.slice(1).join(' ') || null;
  const r = completeInstruction(db, id, cmd === 'done' ? 'done' : 'rejected', note, now);
  return r.ok ? { code: 0, lines: [`instruction #${id} ${cmd === 'done' ? 'done' : 'rejected'}`] } : { code: 1, lines: [r.error] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = run(process.argv.slice(2));
  console.log(r.lines.join('\n'));
  process.exit(r.code);
}
