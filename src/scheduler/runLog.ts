// src/scheduler/runLog.ts
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export type RunStatus =
  | 'planned' | 'running' | 'ok' | 'budget_exceeded' | 'killed'
  | 'failed' | 'crashed' | 'usage_limit' | 'skipped';

export interface RunRow {
  id: string; planned_at: string; started_at: string | null; ended_at: string | null;
  trigger: string; dry_run: number; burst: number | null; tasks: string;
  status: RunStatus; stop_reason: string | null; exit_code: number | null;
  tool_calls: number; tokens_approx: number; wall_sec: number | null;
  window: string | null; log_path: string | null; summary: string | null;
}

const SUMMARY_MAX = 2000;

export function migrateSchedulerTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      id TEXT PRIMARY KEY,
      planned_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      trigger TEXT NOT NULL,
      dry_run INTEGER NOT NULL DEFAULT 0,
      burst INTEGER,
      tasks TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      stop_reason TEXT,
      exit_code INTEGER,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      tokens_approx INTEGER NOT NULL DEFAULT 0,
      wall_sec INTEGER,
      window TEXT,
      log_path TEXT,
      summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduler_runs_planned ON scheduler_runs (planned_at);

    CREATE TABLE IF NOT EXISTS scheduler_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      platform TEXT,
      person_id INTEGER,
      thread_ref TEXT,
      reason TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS dry_run_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      action TEXT NOT NULL,
      platform TEXT,
      person_id INTEGER,
      payload TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbound_messages (
      id INTEGER PRIMARY KEY,
      platform TEXT NOT NULL,
      thread_ref TEXT NOT NULL,
      person_id INTEGER,
      text_hash TEXT NOT NULL,
      klass TEXT NOT NULL,
      escalated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (platform, thread_ref, text_hash)
    );
  `);
}

export function startRun(
  db: Db,
  r: {
    id: string; at: Date; trigger: string; dryRun: boolean; burst: number | null;
    tasks: unknown[]; status: RunStatus; stopReason?: string; window?: string; logPath?: string;
  },
): void {
  const iso = r.at.toISOString();
  const running = r.status === 'running';
  db.prepare(
    `INSERT INTO scheduler_runs
       (id, planned_at, started_at, trigger, dry_run, burst, tasks, status, stop_reason, window, log_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id, iso, running ? iso : null, r.trigger, r.dryRun ? 1 : 0, r.burst,
    JSON.stringify(r.tasks), r.status, r.stopReason ?? null, r.window ?? null, r.logPath ?? null,
  );
}

export function finishRun(
  db: Db,
  id: string,
  f: {
    at: Date; status: RunStatus; stopReason?: string | null; exitCode?: number | null;
    toolCalls?: number; tokensApprox?: number; summary?: string | null;
  },
): void {
  const row = db.prepare('SELECT started_at FROM scheduler_runs WHERE id = ?').get(id) as
    | { started_at: string | null } | undefined;
  if (!row) return;
  const endIso = f.at.toISOString();
  let wall: number | null = null;
  if (row.started_at) {
    const ms = f.at.getTime() - new Date(row.started_at).getTime();
    if (Number.isFinite(ms)) wall = Math.max(0, Math.round(ms / 1000));
  }
  const summary = f.summary == null ? null : f.summary.slice(0, SUMMARY_MAX);
  db.prepare(
    `UPDATE scheduler_runs SET
       ended_at = ?, status = ?, stop_reason = ?, exit_code = ?,
       tool_calls = COALESCE(?, tool_calls), tokens_approx = COALESCE(?, tokens_approx),
       wall_sec = ?, summary = ?
     WHERE id = ?`,
  ).run(
    endIso, f.status, f.stopReason ?? null, f.exitCode ?? null,
    f.toolCalls ?? null, f.tokensApprox ?? null, wall, summary, id,
  );
}

export function listRuns(db: Db, limit = 50): RunRow[] {
  return db
    .prepare('SELECT * FROM scheduler_runs ORDER BY planned_at DESC, rowid DESC LIMIT ?')
    .all(limit) as RunRow[];
}

export function markOrphans(db: Db, now: Date): number {
  const res = db
    .prepare(
      `UPDATE scheduler_runs
          SET status = 'crashed', ended_at = ?, stop_reason = COALESCE(stop_reason, 'orphaned')
        WHERE status IN ('running', 'planned')`,
    )
    .run(now.toISOString());
  return res.changes;
}

export function getState(db: Db, key: string): string | null {
  const r = db.prepare('SELECT value FROM scheduler_state WHERE key = ?').get(key) as
    | { value: string } | undefined;
  return r ? r.value : null;
}

export function setState(db: Db, key: string, value: string, now: Date): void {
  db.prepare(
    `INSERT INTO scheduler_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now.toISOString());
}
