// src/dash/runlog.ts
// Read-only run log. The run_log table belongs to plan 6D and may not exist; absence is reported, never created.
import type BetterSqlite3 from 'better-sqlite3';
import { clampLimit, tableExists } from './readDb.js';
import { cleanRow, cleanText } from './clean.js';

type Item = { id: number; started_at: string; finished_at: string | null; kind: string; status: string; summary: string | null };
export type RunLog = { available: false; note: string } | { available: true; items: Item[] };

const LIMITS: Record<string, number> = { started_at: 64, finished_at: 64, kind: 64, status: 32, summary: 2000 };

export interface SchedulerRun {
  rid: number; id: string; trigger: string; status: string; planned_at: string; started_at: string | null; ended_at: string | null;
  wall_sec: number | null; dry_run: boolean; stop_reason: string | null; tool_calls: number; tokens_approx: number;
  /** Inbox items this run created (escalations.run_id = scheduler_runs.id). The run log has no other link to jobs or messages. */
  escalations: number;
  /** One short text per operator, for example "linkedin: inbox, followups". Built from the stored task plan, never the raw model log. */
  operators: string[];
}
const RUN_LIMITS: Record<string, number> = { id: 64, trigger: 32, status: 32, planned_at: 64, started_at: 64, ended_at: 64, stop_reason: 200 };

/** Operator lines from the stored `tasks` JSON. Any shape problem gives an empty list. */
export function operatorLines(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.slice(0, 12).map((o) => {
      const rec = (o && typeof o === 'object' ? o : {}) as { operator?: unknown; platform?: unknown; tasks?: unknown };
      const name = cleanText(String(rec.platform ?? rec.operator ?? ''), 40);
      const kinds = Array.isArray(rec.tasks) ? rec.tasks.slice(0, 12).map((t) => cleanText(String((t as { kind?: unknown })?.kind ?? ''), 32)).filter(Boolean) : [];
      return kinds.length ? `${name}: ${kinds.join(', ')}` : name;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The scheduler run history (table scheduler_runs, src/scheduler/runLog.ts). The raw `summary` column holds the model's stream log, so it is
 * never selected. Keyset cursor on the implicit rowid (id is TEXT); `status` filters one status, `hideSkipped` drops the many 'skipped' wakes.
 */
export function listSchedulerRuns(
  db: BetterSqlite3.Database,
  opts: { cursor?: number | null; limit?: number; status?: string; hideSkipped?: boolean },
): { items: SchedulerRun[]; nextCursor: number | null; statuses: { status: string; count: number }[] } | null {
  if (!tableExists(db, 'scheduler_runs')) return null;
  const limit = clampLimit(opts.limit);
  const where: string[] = [];
  const params: Record<string, unknown> = { lim: limit + 1 };
  if (opts.status) { where.push('status = @status'); params.status = opts.status; }
  else if (opts.hideSkipped) where.push("status != 'skipped'");
  if (opts.cursor != null) { where.push('rowid < @cursor'); params.cursor = opts.cursor; }
  const rows = db.prepare(`SELECT rowid AS rid, id, trigger, status, planned_at, started_at, ended_at, wall_sec, dry_run, stop_reason, tool_calls,
    tokens_approx, tasks, ${tableExists(db, 'escalations') ? '(SELECT COUNT(*) FROM escalations e WHERE e.run_id = scheduler_runs.id)' : '0'} AS escalations
    FROM scheduler_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rowid DESC LIMIT @lim`).all(params) as Record<string, unknown>[];
  const page = rows.slice(0, limit);
  const items = page.map((r) => {
    const { tasks, dry_run, ...rest } = r;
    const c = cleanRow(rest, RUN_LIMITS) as unknown as SchedulerRun;
    return { ...c, dry_run: Number(dry_run) === 1, operators: operatorLines(tasks) };
  });
  const statuses = db.prepare('SELECT status, COUNT(*) AS count FROM scheduler_runs GROUP BY status ORDER BY count DESC').all() as { status: string; count: number }[];
  return { items, nextCursor: rows.length > limit ? page[page.length - 1].rid as number : null, statuses };
}

export function readRunLog(db: BetterSqlite3.Database, limit?: number): RunLog {
  if (!tableExists(db, 'run_log')) return { available: false, note: 'run log table not present (plan 6D)' };
  const rows = db.prepare('SELECT id, started_at, finished_at, kind, status, summary FROM run_log ORDER BY id DESC LIMIT ?')
    .all(clampLimit(limit)) as unknown as Item[];
  return { available: true, items: rows.map((r) => cleanRow(r as unknown as Record<string, unknown>, LIMITS) as unknown as Item) };
}
