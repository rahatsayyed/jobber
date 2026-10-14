// Thin CLI over src/scheduler/control.ts. Never prints env values.
import { openDb } from '../src/db.js';
import { haltPlatform, clearHalt } from '../src/outreach/limits.js';
import { readControl, setStop, clearStop, defaultDeps, DEFAULT_STOP_FILE } from '../src/scheduler/control.js';

const HALT_TARGETS = ['all', 'linkedin', 'naukri'];

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const db = openDb();
  try {
    const now = new Date();
    const deps = defaultDeps(process.env, DEFAULT_STOP_FILE);
    if (cmd === 'stop') {
      const reason = rest.join(' ').trim() || 'manual stop';
      setStop(DEFAULT_STOP_FILE, reason, now);
      for (const p of HALT_TARGETS) haltPlatform(db, p, reason, now);
      console.log(`stopped: ${reason}`);
    } else if (cmd === 'resume') {
      const had = clearStop(DEFAULT_STOP_FILE);
      for (const p of HALT_TARGETS) clearHalt(db, p, now);
      console.log(`resumed (STOP file ${had ? 'removed' : 'was not present'}; halts cleared)`);
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
