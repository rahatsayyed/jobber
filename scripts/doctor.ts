// scripts/doctor.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { ccgramChecks, restrictedChecks } from '../src/platform/checks.js';
import { setupChecks } from '../src/platform/checksSetup.js';
import { exitCode, formatReport, runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { defaultRun } from '../src/platform/tmux.js';

interface SqliteDb {
  prepare(sql: string): { all(): unknown[] };
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
  now: () => new Date(),
};

const results = await runChecks([...ccgramChecks, ...restrictedChecks(), ...setupChecks], ctx);
console.log(formatReport(results));
process.exit(exitCode(results));
