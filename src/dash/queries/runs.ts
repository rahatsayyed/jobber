// src/dash/queries/runs.ts
// Read-only "what happened during this run" for the dashboard Run panel.
// No table links a job, touch or email to a run: the tool processes get JOBBER_RUN_ID, but the code pass that saves most jobs runs in the
// scheduler process without it, and the rows have no run_id column. So this panel is matched BY TIME: rows created between the run's
// start and end. Only escalations carry a real run_id (escalations.run_id), and those are matched exactly.
// Every list is capped (CAP, jobs 20) and every third-party text goes through cleanText. Nothing is written.
import type BetterSqlite3 from 'better-sqlite3';
import { tableExists } from '../readDb.js';
import { cleanText } from '../clean.js';
import { operatorLines } from '../runlog.js';

type Db = BetterSqlite3.Database;
type Row = Record<string, unknown>;

export const RUN_PANEL_CAP = 50;
export const RUN_PANEL_JOBS = 20;
const RUN_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface RunWindowRun {
  id: string; trigger: string; status: string; started_at: string | null; ended_at: string | null; wall_sec: number | null;
  dry_run: boolean; stop_reason: string | null; tool_calls: number; operators: string[];
}
export interface RunWindow {
  run: RunWindowRun;
  /** The time window used for the "matched by time" lists. `open` is true when the run has no end yet (the window ends now). */
  window: { from: string; to: string; open: boolean };
  /** Other runs whose own window overlaps this one (the mail drip lane runs beside wakes), so a time match can include their work. */
  overlapping_runs: number;
  jobs: { total: number; by_source: { source: string; count: number }[]; items: { id: string; title: string; company: string; source: string; score: number | null; created_at: string }[] };
  touches: { total: number; items: { id: number; kind: string; status: string; at: string | null; platform: string | null; job_id: string | null; person_ref: string | null; person_name: string | null }[] };
  emails: { total: number; items: { queue_id: number; job_id: string; title: string | null; company: string | null; sent_at: string | null }[] };
  /** Exact: escalations.run_id = this run. */
  escalations: { total: number; items: { id: number; reason: string; platform: string | null; created_at: string | null; resolved: boolean }[] };
}

const txt = (v: unknown, n: number): string => (typeof v === 'string' ? cleanText(v, n) : '');
const txtOrNull = (v: unknown, n: number): string | null => (typeof v === 'string' && v !== '' ? cleanText(v, n) : null);
const count = (db: Db, sql: string, ...p: unknown[]): number => (db.prepare(sql).get(...p) as { n: number }).n;

/** The window of a run as ISO strings. Starts at started_at (else planned_at); ends at ended_at (else `now`). Pure. */
export function runWindowBounds(r: { planned_at: string | null; started_at: string | null; ended_at: string | null }, now: Date): { from: string; to: string; open: boolean } | null {
  const from = r.started_at || r.planned_at;
  if (!from || Number.isNaN(Date.parse(from))) return null;
  const end = r.ended_at && !Number.isNaN(Date.parse(r.ended_at)) ? r.ended_at : null;
  return { from, to: end ?? now.toISOString(), open: end === null };
}

/**
 * Everything created inside one run's window. Times are compared through SQLite datetime(), which reads both the ISO text the scheduler
 * writes and the `YYYY-MM-DD HH:MM:SS` text of the older tables as UTC. Returns null for an unknown id or a missing table.
 */
export function runWindow(db: Db, runId: string, now: Date = new Date()): RunWindow | null {
  if (!RUN_ID_RE.test(runId) || !tableExists(db, 'scheduler_runs')) return null;
  const r = db.prepare('SELECT id, trigger, status, planned_at, started_at, ended_at, wall_sec, dry_run, stop_reason, tool_calls, tasks FROM scheduler_runs WHERE id = ?').get(runId) as Row | undefined;
  if (!r) return null;
  const bounds = runWindowBounds({ planned_at: txtOrNull(r.planned_at, 64), started_at: txtOrNull(r.started_at, 64), ended_at: txtOrNull(r.ended_at, 64) }, now);
  const run: RunWindowRun = {
    id: txt(r.id, 64), trigger: txt(r.trigger, 32), status: txt(r.status, 32), started_at: txtOrNull(r.started_at ?? r.planned_at, 64), ended_at: txtOrNull(r.ended_at, 64),
    wall_sec: typeof r.wall_sec === 'number' ? r.wall_sec : null, dry_run: Number(r.dry_run) === 1, stop_reason: txtOrNull(r.stop_reason, 200),
    tool_calls: Number(r.tool_calls) || 0, operators: operatorLines(r.tasks),
  };
  const empty = () => ({ total: 0, items: [] });
  const out: RunWindow = {
    run, window: bounds ?? { from: '', to: '', open: false }, overlapping_runs: 0,
    jobs: { total: 0, by_source: [], items: [] }, touches: empty(), emails: empty(), escalations: empty(),
  };
  if (tableExists(db, 'escalations')) {
    out.escalations.total = count(db, 'SELECT COUNT(*) AS n FROM escalations WHERE run_id = ?', runId);
    out.escalations.items = (db.prepare('SELECT id, reason, platform, created_at, resolved_at FROM escalations WHERE run_id = ? ORDER BY id DESC LIMIT ?').all(runId, RUN_PANEL_CAP) as Row[])
      .map((e) => ({ id: Number(e.id), reason: txt(e.reason, 200), platform: txtOrNull(e.platform, 32), created_at: txtOrNull(e.created_at, 64), resolved: e.resolved_at !== null && e.resolved_at !== undefined }));
  }
  if (!bounds) return out;
  const w = { f: bounds.from, t: bounds.to };
  out.overlapping_runs = count(db, `SELECT COUNT(*) AS n FROM scheduler_runs WHERE id != @id AND status != 'skipped'
    AND datetime(COALESCE(started_at, planned_at)) <= datetime(@t) AND datetime(COALESCE(ended_at, @now)) >= datetime(@f)`, { id: runId, t: w.t, f: w.f, now: now.toISOString() });
  if (tableExists(db, 'jobs')) {
    const where = 'datetime(created_at) >= datetime(@f) AND datetime(created_at) <= datetime(@t)';
    out.jobs.total = count(db, `SELECT COUNT(*) AS n FROM jobs WHERE ${where}`, w);
    out.jobs.by_source = (db.prepare(`SELECT source, COUNT(*) AS count FROM jobs WHERE ${where} GROUP BY source ORDER BY count DESC, source LIMIT ${RUN_PANEL_CAP}`).all(w) as unknown as { source: string | null; count: number }[])
      .map((s) => ({ source: txt(s.source, 64), count: s.count })).filter((s) => s.source !== '');
    out.jobs.items = (db.prepare(`SELECT id, title, company, source, score, created_at FROM jobs WHERE ${where} ORDER BY rowid DESC LIMIT ${RUN_PANEL_JOBS}`).all(w) as Row[])
      .map((j) => ({ id: txt(j.id, 200), title: txt(j.title, 300), company: txt(j.company, 200), source: txt(j.source, 64), score: typeof j.score === 'number' ? j.score : null, created_at: txt(j.created_at, 64) }));
  }
  if (tableExists(db, 'touches')) {
    const where = 'datetime(t.sent_at) >= datetime(@f) AND datetime(t.sent_at) <= datetime(@t)';
    out.touches.total = count(db, `SELECT COUNT(*) AS n FROM touches t WHERE ${where}`, w);
    const hasPeople = tableExists(db, 'people');
    out.touches.items = (db.prepare(`SELECT t.id, t.kind, t.status, t.sent_at, t.job_id, t.person_id, ${hasPeople ? 'p.name AS person_name, p.platform AS platform' : 'NULL AS person_name, NULL AS platform'}
      FROM touches t ${hasPeople ? 'LEFT JOIN people p ON p.id = t.person_id' : ''} WHERE ${where} ORDER BY t.id DESC LIMIT ${RUN_PANEL_CAP}`).all(w) as Row[])
      .map((t) => ({ id: Number(t.id), kind: txt(t.kind, 32), status: txt(t.status, 32), at: txtOrNull(t.sent_at, 64), platform: txtOrNull(t.platform, 32), job_id: txtOrNull(t.job_id, 200),
        person_ref: t.person_id === null || t.person_id === undefined ? null : String(t.person_id), person_name: txtOrNull(t.person_name, 200) }));
  }
  if (tableExists(db, 'outreach_queue')) {
    const where = 'datetime(q.email_sent_at) >= datetime(@f) AND datetime(q.email_sent_at) <= datetime(@t)';
    out.emails.total = count(db, `SELECT COUNT(*) AS n FROM outreach_queue q WHERE ${where}`, w);
    out.emails.items = (db.prepare(`SELECT q.id, q.job_id, q.email_sent_at, j.title, j.company FROM outreach_queue q LEFT JOIN jobs j ON j.id = q.job_id
      WHERE ${where} ORDER BY q.id DESC LIMIT ${RUN_PANEL_CAP}`).all(w) as Row[])
      .map((e) => ({ queue_id: Number(e.id), job_id: txt(e.job_id, 200), title: txtOrNull(e.title, 300), company: txtOrNull(e.company, 200), sent_at: txtOrNull(e.email_sent_at, 64) }));
  }
  return out;
}
