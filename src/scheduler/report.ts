// src/scheduler/report.ts
// Plain-text dry-run review report over the scheduler tables. Read-only; prints no env values.
// Stored payloads and escalation text were already redacted/gated by their recorders.
import type BetterSqlite3 from 'better-sqlite3';
import { listRuns, type RunRow } from './runLog.js';

type Db = BetterSqlite3.Database;

export interface WouldDo { source: 'dry_run_actions' | 'touches'; platform: string; action: string; person_id: number | null; at: string; text: string }

export interface DryRunReport {
  runs: number;
  statusCounts: Record<string, number>;
  skipReasons: Record<string, number>;
  budget: { toolCalls: number; tokensApprox: number; wallSec: number; peakToolCalls: number; maxTokensApprox: number; maxWallSec: number };
  wouldDo: WouldDo[];
  escalations: Array<{ id: number; platform: string | null; reason: string; detail: string | null; created_at: string }>;
}

const TEXT_MAX = 160;
const clip = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);

function payloadText(raw: string | null): string {
  if (!raw) return '';
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (p && typeof p === 'object') {
      const t = p.text ?? p.body ?? p.note ?? p.query;
      if (typeof t === 'string') return clip(t);
      return clip(JSON.stringify(p));
    }
  } catch {
    // fall through
  }
  return clip(raw);
}

function tableExists(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export function buildReport(db: Db, opts: { limit?: number } = {}): DryRunReport {
  const n = Number.isFinite(opts.limit) ? Math.trunc(opts.limit as number) : 20;
  const limit = Math.min(500, Math.max(1, n));
  const runs: RunRow[] = tableExists(db, 'scheduler_runs') ? listRuns(db, limit) : [];
  const statusCounts: Record<string, number> = {};
  const skipReasons: Record<string, number> = {};
  const budget = { toolCalls: 0, tokensApprox: 0, wallSec: 0, peakToolCalls: 0, maxTokensApprox: 0, maxWallSec: 0 };
  for (const r of runs) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    if (r.status === 'skipped') {
      const reason = (r.stop_reason ?? 'unknown').split(':')[0].trim() || 'unknown';
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    }
    budget.toolCalls += r.tool_calls ?? 0;
    budget.tokensApprox += r.tokens_approx ?? 0;
    budget.wallSec += r.wall_sec ?? 0;
    budget.peakToolCalls = Math.max(budget.peakToolCalls, r.tool_calls ?? 0);
    budget.maxTokensApprox = Math.max(budget.maxTokensApprox, r.tokens_approx ?? 0);
    budget.maxWallSec = Math.max(budget.maxWallSec, r.wall_sec ?? 0);
  }

  const wouldDo: WouldDo[] = [];
  const since = runs.length ? runs[runs.length - 1].planned_at : null;
  if (tableExists(db, 'dry_run_actions')) {
    const ids = runs.map((r) => r.id);
    const rows = (ids.length
      ? db
          .prepare(
            `SELECT action, platform, person_id, payload, created_at FROM dry_run_actions
              WHERE run_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`,
          )
          .all(...ids)
      : []) as Array<{ action: string; platform: string | null; person_id: number | null; payload: string | null; created_at: string }>;
    for (const r of rows) {
      wouldDo.push({
        source: 'dry_run_actions', platform: r.platform ?? '', action: r.action,
        person_id: r.person_id, at: r.created_at, text: payloadText(r.payload),
      });
    }
  }
  if (tableExists(db, 'touches') && tableExists(db, 'people') && since) {
    const rows = db
      .prepare(
        `SELECT t.kind, t.body, t.person_id, t.created_at, p.platform
           FROM touches t LEFT JOIN people p ON p.id = t.person_id
          WHERE t.status = 'dry_run' AND t.created_at >= ? ORDER BY t.id ASC`,
      )
      .all(since) as Array<{ kind: string; body: string | null; person_id: number | null; created_at: string; platform: string | null }>;
    for (const r of rows) {
      wouldDo.push({
        source: 'touches', platform: r.platform ?? '', action: r.kind,
        person_id: r.person_id, at: r.created_at, text: clip(r.body ?? ''),
      });
    }
  }
  wouldDo.sort((a, b) => a.at.localeCompare(b.at));

  const escalations = tableExists(db, 'escalations')
    ? (db
        .prepare(
          `SELECT id, platform, reason, detail, created_at FROM escalations
            WHERE resolved_at IS NULL ORDER BY id ASC LIMIT 100`,
        )
        .all() as DryRunReport['escalations'])
    : [];

  return { runs: runs.length, statusCounts, skipReasons, budget, wouldDo, escalations };
}

const kv = (o: Record<string, number>): string =>
  Object.keys(o).length === 0
    ? 'none'
    : Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(', ');

export function formatReport(r: DryRunReport): string {
  const out: string[] = [];
  out.push(`Dry-run report: last ${r.runs} run(s)`);
  out.push(`status: ${kv(r.statusCounts)}`);
  if (r.statusCounts.incomplete) {
    out.push(`incomplete: ${r.statusCounts.incomplete} run(s) exited 0 with the wake unfinished (steps unproven; the reason is in stop_reason, a continuation run has a parent_run_id)`);
  }
  out.push(`skip reasons: ${kv(r.skipReasons)}`);
  out.push(
    `budget used: tool_calls ${r.budget.toolCalls} (peak ${r.budget.peakToolCalls} in one run), ` +
      `tokens_approx ${r.budget.tokensApprox} (max ${r.budget.maxTokensApprox}), ` +
      `wall_sec ${r.budget.wallSec} (max ${r.budget.maxWallSec})`,
  );
  out.push(`would-be actions: ${r.wouldDo.length}`);
  for (const a of r.wouldDo) {
    out.push(`  ${a.at} ${a.platform || '-'} ${a.action} person=${a.person_id ?? '-'} [${a.source}] ${a.text}`);
  }
  out.push(`open escalations: ${r.escalations.length}`);
  for (const e of r.escalations) {
    out.push(`  #${e.id} ${e.created_at} ${e.platform ?? '-'}: ${clip(e.reason)}${e.detail ? ` | ${clip(e.detail)}` : ''}`);
  }
  return out.join('\n');
}
