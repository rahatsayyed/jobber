// scripts/dry-run.ts
// `npm run dry-run`: thin wiring over src/verify/cli.ts (real fs, db, doctor, web and process runner).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { allDoctorChecks } from '../src/platform/checkLists.js';
import { runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { defaultRun } from '../src/platform/tmux.js';
import { openDb } from '../src/db.js';
import { initTerm } from '../src/ui/term.js';
import { realStartWeb, runCli } from '../src/verify/cli.js';

const term = initTerm(); // strips --no-color from process.argv; colour only on a terminal

const root = resolve(import.meta.dirname, '..');
const env = process.env;
const run = defaultRun;

interface SqliteDb { prepare(sql: string): { all(): unknown[]; get(): unknown }; close(): void }
type SqliteCtor = new (path: string, opts: { readonly: boolean; fileMustExist: boolean }) => SqliteDb;
const sqlite = (): SqliteCtor => createRequire(import.meta.url)('better-sqlite3') as SqliteCtor;

const dctx: DoctorContext = {
  root, env, run,
  fs: {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
    list: (p) => (existsSync(p) ? readdirSync(p) : []),
    mode: (p) => (existsSync(p) ? statSync(p).mode & 0o777 : null),
  },
  fetch: async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
  },
  sqliteTables: (p) => {
    try {
      const db = new (sqlite())(p, { readonly: true, fileMustExist: true });
      try { return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name); } finally { db.close(); }
    } catch { return null; }
  },
  authAccount: (p) => {
    try {
      const db = new (sqlite())(p, { readonly: true, fileMustExist: true });
      try {
        const r = db.prepare('SELECT email, sub FROM allowed_account WHERE id = 1').get() as { email: string; sub: string | null } | undefined;
        return r ? { email: r.email, pinned: r.sub !== null } : null;
      } finally { db.close(); }
    } catch { return null; }
  },
  now: () => new Date(),
};

const code = await runCli(process.argv.slice(2), {
  root, env,
  out: (s) => console.log(term.paint(s)),
  err: (s) => console.error(s),
  parts: {
    run,
    fs: {
      mkdtemp: (p) => mkdtempSync(join(tmpdir(), p)),
      mkdir: (p) => { mkdirSync(p, { recursive: true }); },
      write: (p, d) => writeFileSync(p, d),
      read: (p) => readFileSync(p, 'utf8'),
      exists: (p) => existsSync(p),
      rm: (p) => rmSync(p, { recursive: true, force: true }),
    },
    now: () => new Date(),
    doctor: () => runChecks(allDoctorChecks(), dctx),
    openDb,
    startWeb: realStartWeb,
  },
});
process.exit(code);
