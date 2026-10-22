// Dry-run guard. ONE master flag, JOBBER_DRY_RUN: dry iff its trimmed, lowercased value is `1` or `true`.
// Unset, empty, `false`, `0` or anything else is LIVE (the default). Legacy *_DRY_RUN keys are ignored.
// .claude/hooks/kill-switch.cjs carries a copy of the parse; tests/dryrun-parity.test.ts keeps them equal.
import type BetterSqlite3 from 'better-sqlite3';
import { redactSecrets } from './redact.js';
import { secretValuesFromEnv } from './outputGate.js';

type Db = BetterSqlite3.Database;

export const DRY_RUN_KEY = 'JOBBER_DRY_RUN';
/** Keys of the retired per-area flags. They are never read; the doctor warns when .env still has one. */
export const LEGACY_DRY_RUN_KEYS = [
  'SCHEDULER_DRY_RUN', 'LINKEDIN_DRY_RUN', 'WEB_DRY_RUN', 'APPLY_DRY_RUN', 'SCOUT_DRY_RUN',
] as const;

/** Parse the master flag value. Only `1` and `true` (any case, surrounding space ignored) mean dry. */
export function parseDryFlag(value: string | undefined | null): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true';
}

export function isDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseDryFlag(env[DRY_RUN_KEY]);
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
  const secrets: string[] = [];
  for (const s of secretValuesFromEnv(env)) {
    secrets.push(s);
    const esc = JSON.stringify(s).slice(1, -1);
    if (esc !== s) secrets.push(esc);
  }
  // Redact the full string first, then clamp, so a secret straddling the cut is never stored.
  let payload = redactSecrets(raw, secrets).slice(0, PAYLOAD_MAX);
  const open = payload.lastIndexOf('[redacted');
  if (open !== -1 && payload.indexOf(']', open) === -1) payload = payload.slice(0, open);
  else if (/\[r(e(d(a(c(t(e(d)?)?)?)?)?)?)?$/.test(payload)) payload = payload.replace(/\[r[a-z]*$/, '');
  if (payload.endsWith('[')) payload = payload.slice(0, -1);
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
