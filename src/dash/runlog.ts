// src/dash/runlog.ts
// Read-only run log. The run_log table belongs to plan 6D and may not exist; absence is reported, never created.
import type BetterSqlite3 from 'better-sqlite3';
import { clampLimit, tableExists } from './readDb.js';
import { cleanRow } from './clean.js';

type Item = { id: number; started_at: string; finished_at: string | null; kind: string; status: string; summary: string | null };
export type RunLog = { available: false; note: string } | { available: true; items: Item[] };

const LIMITS: Record<string, number> = { started_at: 64, finished_at: 64, kind: 64, status: 32, summary: 2000 };

export function readRunLog(db: BetterSqlite3.Database, limit?: number): RunLog {
  if (!tableExists(db, 'run_log')) return { available: false, note: 'run log table not present (plan 6D)' };
  const rows = db.prepare('SELECT id, started_at, finished_at, kind, status, summary FROM run_log ORDER BY id DESC LIMIT ?')
    .all(clampLimit(limit)) as unknown as Item[];
  return { available: true, items: rows.map((r) => cleanRow(r as unknown as Record<string, unknown>, LIMITS) as unknown as Item) };
}
