// Thin CLI over src/scheduler/control.ts. Never prints env values.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import {
  readControl,
  applyStop,
  applyResume,
  defaultDeps,
  projectRootFromScriptDir,
  stopFileForRoot,
} from '../src/scheduler/control.js';

// Resolved from the script location, not the cwd, so it is the same file scripts/scheduler.ts watches.
const STOP_FILE = stopFileForRoot(projectRootFromScriptDir(dirname(fileURLToPath(import.meta.url))));

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const db = openDb();
  try {
    const now = new Date();
    const deps = defaultDeps(process.env, STOP_FILE);
    if (cmd === 'stop') {
      const reason = rest.join(' ').trim() || 'manual stop';
      const r = applyStop(db, STOP_FILE, reason, now);
      console.log(`stopped: ${r.reason}`);
      for (const [p, why] of Object.entries(r.kept)) console.log(`kept existing ${p} halt: ${why}`);
    } else if (cmd === 'resume') {
      const r = applyResume(db, STOP_FILE, now);
      console.log(
        `resumed (STOP file ${r.stopFileRemoved ? 'removed' : 'was not present'}; ` +
          `cleared halts: ${r.cleared.join(', ') || 'none'})`,
      );
      for (const [p, why] of Object.entries(r.remaining)) console.log(`still halted ${p}: ${why}`);
      if (process.env.JOBBER_KILL === '1') console.log('note: JOBBER_KILL=1 is still set in this environment');
    } else if (cmd === 'status') {
      const s = readControl(db, deps);
      console.log(`killed: ${s.killed}`);
      if (s.killReason) console.log(`reason: ${s.killReason}`);
      if (s.readError) console.log(`read error: ${s.readError}`);
      console.log(`linkedin halt: ${s.halted.linkedin ?? 'none'}`);
      console.log(`naukri halt: ${s.halted.naukri ?? 'none'}`);
      console.log(`allowed: ${s.allowed.join(', ') || 'none'}`);
    } else {
      console.error('usage: jobber-control <stop [reason...] | resume | status>');
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

main();
