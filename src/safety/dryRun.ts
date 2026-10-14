// Dry-run guard. Any dry flag wins; unset means dry; live needs every relevant flag explicitly live.
import type BetterSqlite3 from 'better-sqlite3';
import { redactSecrets } from './redact.js';
import { secretValuesFromEnv } from './outputGate.js';

type Db = BetterSqlite3.Database;

export function isDryRun(env: NodeJS.ProcessEnv = process.env, opts: { linkedin?: boolean } = {}): boolean {
  if (env.JOBBER_DRY_RUN === '1') return true;
  if (env.SCHEDULER_DRY_RUN !== 'false') return true;
  if (opts.linkedin && env.LINKEDIN_DRY_RUN !== 'false') return true;
  return false;
}

export interface DryRunRecord {
  runId: string | null;
  action: string;
  platform: string;
  personId?: number | null;
  payload: Record<string, unknown>;
}

const PAYLOAD_MAX = 4000;

export function recordDryRun(
  db: Db, rec: DryRunRecord, now: Date, env: NodeJS.ProcessEnv = process.env,
): { status: 'dry_run'; id: number } {
  const runId = env.JOBBER_RUN_ID ?? rec.runId ?? null;
  let raw: string;
  try { raw = JSON.stringify(rec.payload ?? {}) ?? '{}'; } catch { raw = '{"unserializable":true}'; }
  const clamped = raw.slice(0, PAYLOAD_MAX);
  const payload = redactSecrets(clamped, secretValuesFromEnv(env));
  const info = db.prepare(
    'INSERT INTO dry_run_actions (run_id, action, platform, person_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(runId, rec.action, rec.platform, rec.personId ?? null, payload, now.toISOString());
  return { status: 'dry_run', id: Number(info.lastInsertRowid) };
}

export function listDryRun(
  db: Db, opts: { runId?: string; limit?: number } = {},
): Array<DryRunRecord & { id: number; created_at: string }> {
  const n = Number.isFinite(opts.limit) ? Math.trunc(opts.limit as number) : 100;
  const limit = Math.min(500, Math.max(1, n));
  const rows = (opts.runId !== undefined
    ? db.prepare('SELECT * FROM dry_run_actions WHERE run_id = ? ORDER BY id DESC LIMIT ?').all(opts.runId, limit)
    : db.prepare('SELECT * FROM dry_run_actions ORDER BY id DESC LIMIT ?').all(limit)) as Array<{
    id: number; run_id: string | null; action: string; platform: string | null;
    person_id: number | null; payload: string | null; created_at: string;
  }>;
  return rows.map((r) => {
    let payload: Record<string, unknown>;
    try {
      const p = JSON.parse(r.payload ?? '{}');
      payload = p && typeof p === 'object' && !Array.isArray(p) ? p : { raw: String(r.payload) };
    } catch { payload = { raw: r.payload ?? '' }; }
    return {
      id: r.id, runId: r.run_id, action: r.action, platform: r.platform ?? '',
      personId: r.person_id, payload, created_at: r.created_at,
    };
  });
}
