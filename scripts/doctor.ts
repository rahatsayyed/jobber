// scripts/doctor.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ccgramChecks, restrictedChecks } from '../src/platform/checks.js';
import { exitCode, formatReport, runChecks, type DoctorContext } from '../src/platform/doctor.js';
import BetterSqlite3 from 'better-sqlite3';
import { defaultRun } from '../src/platform/tmux.js';

const ctx: DoctorContext = {
  root: resolve(import.meta.dirname, '..'),
  env: process.env,
  run: defaultRun,
  fs: {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
    list: (p) => (existsSync(p) ? readdirSync(p) : []),
    mode: (p) => (existsSync(p) ? statSync(p).mode & 0o777 : null),
  },
  authAccount: (p) => {
    try {
      const db = new BetterSqlite3(p, { readonly: true, fileMustExist: true });
      try {
        const r = db.prepare('SELECT email, sub FROM allowed_account WHERE id = 1').get() as
          { email: string; sub: string | null } | undefined;
        return r ? { email: r.email, pinned: r.sub !== null } : null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  },
};

const results = await runChecks([...ccgramChecks, ...restrictedChecks()], ctx);
console.log(formatReport(results));
process.exit(exitCode(results));
