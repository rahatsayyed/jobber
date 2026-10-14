// scripts/dashboard.ts
// Local owner CLI for the dashboard allowed account. No web equivalent.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { audit, getAllowedAccount, listAudit, openAuthStore } from '../src/dash/authStore.js';
import { accountStatus, allowAccount, normaliseEmail } from '../src/dash/account.js';

export type Parsed =
  | { ok: true; cmd: 'allow'; email: string }
  | { ok: true; cmd: 'status' }
  | { ok: true; cmd: 'audit'; n: number }
  | { ok: false; error: string };

const USAGE = 'usage: dashboard allow <email> | status | audit [n]';

export function parseArgs(argv: string[]): Parsed {
  const [cmd, ...rest] = argv;
  if (cmd === 'allow') {
    if (rest.length !== 1) return { ok: false, error: USAGE };
    return { ok: true, cmd: 'allow', email: rest[0] };
  }
  if (cmd === 'status') {
    return rest.length === 0 ? { ok: true, cmd: 'status' } : { ok: false, error: USAGE };
  }
  if (cmd === 'audit') {
    if (rest.length > 1) return { ok: false, error: USAGE };
    if (rest.length === 0) return { ok: true, cmd: 'audit', n: 50 };
    if (!/^\d+$/.test(rest[0])) return { ok: false, error: USAGE };
    const n = Number(rest[0]);
    if (n < 1) return { ok: false, error: USAGE };
    return { ok: true, cmd: 'audit', n: Math.min(200, n) };
  }
  return { ok: false, error: USAGE };
}

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + ' ', (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgs(argv);
  if (!p.ok) { console.error(p.error); return 1; }
  const db = openAuthStore(process.env.WEB_AUTH_DB || '.dashboard/auth.sqlite');
  try {
    const now = new Date();
    if (p.cmd === 'allow') {
      const e = normaliseEmail(p.email);
      if (e === null) { console.error('invalid email address'); return 1; }
      if (getAllowedAccount(db)) {
        const yes = await confirm('Replace the allowed account and clear the pinned identity? (y/N)');
        if (!yes) { console.log('unchanged'); return 1; }
      }
      const r = allowAccount(db, e, now);
      if (!r.ok) { console.error('invalid email address'); return 1; }
      audit(db, 'allow_changed', { note: 'owner cli' }, now);
      console.log(`allowed account set to ${e}; the next successful sign-in pins the account`);
      return 0;
    }
    if (p.cmd === 'status') {
      const s = accountStatus(db, now);
      if (!s) { console.log('no allowed account set'); return 0; }
      console.log(`allowed email: ${s.email}`);
      console.log(`sub pinned: ${s.pinned ? 'yes' : 'no'}`);
      console.log(`pinned at: ${s.pinnedAt ?? 'n/a'}`);
      console.log(`active sessions: ${s.activeSessions}`);
      return 0;
    }
    for (const r of listAudit(db, p.n)) {
      console.log(`${r.at}  ${r.kind}  ${r.ip ?? '-'}  ${r.note ?? ''}`.trimEnd());
    }
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
