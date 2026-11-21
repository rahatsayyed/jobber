// src/heal/cli.ts
// The owner commands behind `npm run heal -- status|list|land <id>|ignore <signature>|revert <id>` (ids are ledger ids). Pure over HealDeps
// so a test can drive it with a temp repo. Every state-changing command takes the heal lock and refuses while the kill switch is on.
import { healCooldownHours, healMaxPerDay, healMode, healWatchMin } from './config.js';
import {
  attemptsLast24h, getAttempt, getLedger, ignoreSignature, listAttempts, listLedger, migrateHealTables, takeHealLock, type AttemptRow,
} from './ledger.js';
import { landAttempt, rollbackAttempt, runPendingRestart, type HealDeps } from './land.js';

export const HEAL_USAGE = 'usage: heal <status | list | land <id> | ignore <signature> | revert <id>>   (id = ledger id from `heal list`)';

const lastAttempt = (d: HealDeps, ledgerId: number): AttemptRow | undefined => listAttempts(d.db, ledgerId)[0];

export function statusLines(d: HealDeps): string[] {
  migrateHealTables(d.db);
  const rows = listLedger(d.db);
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.state, (by.get(r.state) ?? 0) + 1);
  const out = [
    `mode: ${healMode(d.env)} (max ${healMaxPerDay(d.env)}/day, cooldown ${healCooldownHours(d.env)} h, watch ${healWatchMin(d.env)} min)`,
    `attempts in the last 24 h: ${attemptsLast24h(d.db, d.now())}`,
    `signatures: ${rows.length} (${[...by].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
  ];
  for (const r of rows.filter((x) => x.state === 'ready' || x.state === 'healing').slice(0, 5)) out.push(`  [${r.id}] ${r.state} ${r.signature}`);
  return out;
}

export function listLines(d: HealDeps): string[] {
  migrateHealTables(d.db);
  const rows = listLedger(d.db);
  if (rows.length === 0) return ['no signatures yet'];
  return rows.map((r) => {
    const a = r.last_heal_id ? getAttempt(d.db, r.last_heal_id) : undefined;
    return `[${r.id}] ${r.state.padEnd(11)} x${r.count} ${r.verdict === 'never' ? '(never heal) ' : ''}${r.signature}  last ${r.last_seen}${a?.branch ? `  branch ${a.branch} (${a.outcome})` : ''}`;
  });
}

/** Runs one command; returns the lines to print and the exit code. */
export async function runHealCommand(d: HealDeps, argv: string[]): Promise<{ lines: string[]; code: number }> {
  const [cmd, arg] = argv;
  migrateHealTables(d.db);
  if (cmd === 'status') return { lines: statusLines(d), code: 0 };
  if (cmd === 'list') return { lines: listLines(d), code: 0 };
  if (cmd !== 'land' && cmd !== 'ignore' && cmd !== 'revert') return { lines: [HEAL_USAGE], code: 2 };
  if (!arg) return { lines: [HEAL_USAGE], code: 2 };
  if (cmd === 'ignore') {
    if (!/^[a-z0-9_:.#-]{1,160}$/.test(arg)) return { lines: ['not a signature'], code: 2 };
    ignoreSignature(d.db, arg, d.now());
    return { lines: [`ignored: ${arg}`], code: 0 };
  }
  const id = Number(arg);
  if (!Number.isInteger(id) || id < 1) return { lines: ['the id must be a ledger id from `heal list`'], code: 2 };
  if (d.killed()) return { lines: ['the kill switch is on: nothing is landed or reverted'], code: 3 };
  if (healMode(d.env) === 'off') return { lines: ['HEAL_MODE=off: nothing is landed or reverted'], code: 3 };
  const ledger = getLedger(d.db, id);
  if (!ledger) return { lines: [`no ledger row ${id}`], code: 1 };
  const att = lastAttempt(d, id);
  const lock = takeHealLock(d.root, `heal-cli-${cmd}`);
  if (!lock) return { lines: ['another heal action is running; try again in a minute'], code: 3 };
  try {
    if (cmd === 'land') {
      if (!att || att.outcome !== 'ready') return { lines: [`nothing to land for ${id}: the last attempt is ${att?.outcome ?? 'missing'}`], code: 1 };
      const r = await landAttempt(d, att.id);
      if (!r.ok) return { lines: [`not landed: ${r.reason}`], code: 1 };
      const rs = await runPendingRestart(d, att.id);
      return { lines: [`landed ${r.landedHead.slice(0, 8)} (${r.files.length} files); restart: ${rs}`], code: 0 };
    }
    if (!att || (att.outcome !== 'landed' && att.outcome !== 'stable')) return { lines: [`nothing to revert for ${id}: the last attempt is ${att?.outcome ?? 'missing'}`], code: 1 };
    const ok = await rollbackAttempt(d, att, 'owner revert');
    if (!ok) return { lines: ['revert failed; see the alerts notice'], code: 1 };
    const rs = await runPendingRestart(d, att.id);
    return { lines: [`reverted; restart: ${rs}`], code: 0 };
  } finally {
    try { lock.release(); } catch { /* ignore */ }
  }
}
