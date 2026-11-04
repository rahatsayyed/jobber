// scripts/handoff.ts
// Owner and code CLI for .jobber/handoff.md: list, add and resolve entries. `add` and `resolve` are for the manager and
// the scheduler only (the file is written by code, never by hand or by a worker window).
//   npx tsx scripts/handoff.ts list [window]
//   npx tsx scripts/handoff.ts add <window> <what> <why>
//   npx tsx scripts/handoff.ts resolve <id>
import { resolve } from 'node:path';
import { addHandoff, listHandoff, resolveHandoff } from '../src/platform/handoff.js';

const ROOT = resolve(import.meta.dirname, '..');
const USAGE = 'usage: handoff <list [window]|add <window> <what> <why>|resolve <id>>';

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'list') {
      const all = listHandoff(ROOT).filter((e) => rest[0] === undefined || e.window === rest[0]);
      if (all.length === 0) console.log('no pending handoff items');
      for (const e of all) console.log(`[${e.id}] ${e.window} | ${e.what} | ${e.why} | ${e.since}`);
      return 0;
    }
    if (cmd === 'add' && rest.length >= 3) {
      const r = addHandoff(ROOT, { window: rest[0], what: rest[1], why: rest.slice(2).join(' ') });
      if (!r.ok) { console.error(`not added: ${r.reason}`); return 1; }
      console.log(`${r.existing ? 'already pending' : 'added'}: ${r.entry.id}`);
      return 0;
    }
    if (cmd === 'resolve' && rest.length === 1) {
      if (!resolveHandoff(ROOT, rest[0])) { console.error('no such id'); return 1; }
      console.log('resolved');
      return 0;
    }
  } catch (e) {
    console.error(`handoff: ${(e as Error).message}`);
    return 1;
  }
  console.error(USAGE);
  return 2;
}

process.exit(main(process.argv.slice(2)));
