// src/dash/queries/outcomes.ts
// Read-only outcomes list (job_outcomes, src/db.ts:135; the brief's "outcomes" table) and the funnel (thin wrapper of funnelStats).
import type BetterSqlite3 from 'better-sqlite3';
import { clampLimit, tableExists, type Page } from '../readDb.js';
import { cleanRow } from '../clean.js';
import { funnelStats, type Funnel } from '../../funnel.js';

type Db = BetterSqlite3.Database;
export interface OutcomeRow { id: number; job_id: string; title: string | null; company: string | null; outcome: string; note: string | null; created_at: string }
const LIMITS: Record<string, number> = { job_id: 200, title: 300, company: 200, outcome: 32, note: 2000, created_at: 64 };

export function listOutcomes(db: Db, opts: { outcome?: string; cursor?: number | null; limit?: number }): Page<OutcomeRow> {
  if (!tableExists(db, 'job_outcomes')) return { items: [], nextCursor: null };
  const limit = clampLimit(opts.limit);
  const jobs = tableExists(db, 'jobs');
  const where: string[] = [];
  const params: Record<string, unknown> = { lim: limit + 1 };
  if (opts.outcome) { where.push('o.outcome = @outcome'); params.outcome = opts.outcome; }
  if (opts.cursor != null) { where.push('o.id < @cursor'); params.cursor = opts.cursor; }
  const rows = db.prepare(`SELECT o.id, o.job_id, ${jobs ? 'j.title' : 'NULL'} AS title, ${jobs ? 'j.company' : 'NULL'} AS company,
    o.outcome, o.note, o.created_at FROM job_outcomes o ${jobs ? 'LEFT JOIN jobs j ON j.id = o.job_id' : ''}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT @lim`).all(params) as unknown as OutcomeRow[];
  const items = rows.slice(0, limit).map((r) => cleanRow(r as unknown as Record<string, unknown>, LIMITS) as unknown as OutcomeRow);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
}

export function funnelView(db: Db, threshold: number): Funnel {
  return funnelStats(db, threshold);
}
