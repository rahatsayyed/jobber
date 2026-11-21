// scripts/heal-live.ts
// `npm run heal:live -- <ledger_id>`: the LIVE TRY of a heal. Run it from the fixer worktree (it loads the worktree code); code runs the same
// command again at landing time. It prints ONE JSON line {ledger_id, testability, ran, result, evidence} and always exits 0 for a verdict.
// It works on a temp copy of the database, never commits or sends, and refuses when halted, outside active hours or while the live stack
// uses the same platform. Logic and guards: src/heal/live.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { liveRootOf, runLiveCheck } from '../src/heal/live.js';
import { linkedinActiveNow } from '../src/linkedin/activeHours.js';
import { parseEnv } from '../src/platform/envFile.js';
import { defaultDeps, readControl } from '../src/scheduler/control.js';
import { stopActive } from './killSwitch.js';

const worktree = resolve(process.cwd());
const liveRoot = liveRootOf(worktree);

function loadEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const f = join(liveRoot, '.env');
  if (existsSync(f)) for (const [k, v] of Object.entries(parseEnv(readFileSync(f, 'utf8')))) if (env[k] === undefined) env[k] = v;
  return env;
}

async function main(): Promise<number> {
  const id = Number(process.argv[2]);
  if (!Number.isInteger(id) || id < 1) { console.error('usage: heal:live <ledger_id>'); return 2; }
  const env = loadEnv();
  const liveDbFile = join(liveRoot, 'data.sqlite');
  const v = await runLiveCheck({
    ledgerId: id, worktree, env, liveDbFile,
    readLedger: (file, lid) => {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        const r = db.prepare('SELECT signature, evidence FROM heal_ledger WHERE id = ?').get(lid) as { signature: string; evidence: string } | undefined;
        if (!r) return null;
        let queue: number[] = [];
        try { queue = (JSON.parse(r.evidence) as { queue?: number[] }).queue?.filter((x) => Number.isInteger(x)) ?? []; } catch { /* none */ }
        return { signature: r.signature, queue };
      } finally { db.close(); }
    },
    killed: () => stopActive(liveRoot, env).stopped,
    haltedOn: (db, platform) => {
      const c = readControl(db, defaultDeps(env, join(liveRoot, '.jobber', 'STOP')));
      return { all: c.killed, platform: Boolean((c.halted as Record<string, string | null>)[platform]) };
    },
    activeNow: linkedinActiveNow,
  });
  console.log(JSON.stringify(v));
  return 0;
}

main().then((c) => process.exit(c), (e) => {
  console.log(JSON.stringify({ ledger_id: Number(process.argv[2]) || 0, testability: 'not_testable', ran: false, result: 'skipped', evidence: `runner error: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}` }));
  process.exit(0);
});
