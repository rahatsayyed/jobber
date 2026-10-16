// scripts/doctor.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { allDoctorChecks } from '../src/platform/checkLists.js';
import { exitCode, formatJson, formatReport, runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { skipSummary, skippedFromContext, withSkips } from '../src/setup/skips.js';
import { defaultRun } from '../src/platform/tmux.js';
import { initTerm } from '../src/ui/term.js';

const term = initTerm(); // strips --no-color from process.argv; colour only on a terminal

interface SqliteDb {
  prepare(sql: string): { all(): unknown[]; get(): unknown };
  close(): void;
}
type SqliteCtor = new (path: string, opts: { readonly: boolean; fileMustExist: boolean }) => SqliteDb;

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
  fetch: async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
  },
  sqliteTables: (path) => {
    try {
      // Loaded lazily: a native-module ABI mismatch must not stop the wizard or the doctor.
      const Database = createRequire(import.meta.url)('better-sqlite3') as SqliteCtor;
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
        return rows.map((r) => r.name);
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  },
  authAccount: (p) => {
    try {
      const Database = createRequire(import.meta.url)('better-sqlite3') as SqliteCtor;
      const db = new Database(p, { readonly: true, fileMustExist: true });
      try {
        const r = db.prepare('SELECT email, sub FROM allowed_account WHERE id = 1').get() as
          | { email: string; sub: string | null }
          | undefined;
        return r ? { email: r.email, pinned: r.sub !== null } : null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  },
  authToken: (p) => {
    try {
      const Database = createRequire(import.meta.url)('better-sqlite3') as SqliteCtor;
      const db = new Database(p, { readonly: true, fileMustExist: true });
      try {
        const r = db.prepare('SELECT created_at FROM access_token WHERE id = 1').get() as { created_at: string } | undefined;
        return r ? { set: true, createdAt: r.created_at } : { set: false, createdAt: null };
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  },
  now: () => new Date(),
};

const results = await runChecks(withSkips(allDoctorChecks()), ctx);
if (process.argv.includes('--json')) {
  console.log(formatJson(results));
} else {
  const summary = skipSummary(skippedFromContext(ctx));
  console.log(term.paint(formatReport(results) + (summary ? `\n${summary}` : '')));
}
process.exit(exitCode(results));
