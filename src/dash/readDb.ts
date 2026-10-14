// src/dash/readDb.ts
// Read-only database handle and pagination helpers for the dashboard. Nothing here writes: the handle is opened
// readonly with query_only on, and the grep test in tests/dash-readdb.test.ts keeps write SQL out of the read modules.
import BetterSqlite3 from 'better-sqlite3';
import { dbPath } from '../dbPath.js';

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const MAX_Q = 64;

export interface Page<T> {
  items: T[];
  nextCursor: number | null;
}

export function openReadOnlyDb(path?: string): BetterSqlite3.Database {
  const db = new BetterSqlite3(path ?? dbPath(), { readonly: true, fileMustExist: true });
  db.pragma('query_only = 1');
  db.pragma('busy_timeout = 2000');
  return db;
}

export function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Keyset cursor: a positive safe integer (rows with id < cursor), or null. */
export function parseCursor(raw: unknown): number | null {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** LIKE pattern for a user search term; use with ESCAPE '\\'. */
export function likePattern(q: string): string {
  const t = String(q).trim().slice(0, MAX_Q);
  return '%' + t.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

export function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
