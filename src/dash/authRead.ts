// src/dash/authRead.ts
// The one read-only reader of the dashboard auth store for the doctor, `npm start` (stack) and the
// setup skip catalog. It never creates the file and never returns a hash. A missing or unreadable
// store is null ("unknown"), an existing store without a token is { set: false }.
import { createRequire } from 'node:module';

interface Stmt { get(): unknown }
interface Db { prepare(sql: string): Stmt; close(): void }
type Ctor = new (path: string, opts: { readonly: boolean; fileMustExist: boolean }) => Db;

function withDb<T>(path: string, fn: (db: Db) => T): T | null {
  try {
    // Loaded lazily: a native-module ABI mismatch must not stop the wizard or the doctor.
    const Database = createRequire(import.meta.url)('better-sqlite3') as Ctor;
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function readAuthToken(path: string): { set: boolean; createdAt: string | null } | null {
  return withDb(path, (db) => {
    const r = db.prepare('SELECT created_at FROM access_token WHERE id = 1').get() as
      | { created_at: string }
      | undefined;
    return r ? { set: true, createdAt: r.created_at } : { set: false, createdAt: null };
  });
}

export function readAuthAccount(path: string): { email: string; pinned: boolean } | null {
  return withDb(path, (db) => {
    const r = db.prepare('SELECT email, sub FROM allowed_account WHERE id = 1').get() as
      | { email: string; sub: string | null }
      | undefined;
    return r ? { email: r.email, pinned: r.sub !== null } : null;
  });
}
