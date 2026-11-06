// One-off, idempotent migration (owner runs it; never a wake): re-runs the ROLE GATE (config/role-families.json) and, for rows that carry
// the old five-key rubric (rubric_v2) the per-dimension minimums, and for rows saved with the career-ops rubric (career_ops_v1) the cutoff
// (stored score below MATCH_THRESHOLD, default 4.0 of 5), on jobs that are scored and have a QUEUED outreach row that has not gone out.
// Rows that fail are parked: outreach_queue.status = 'skipped' and the job gets excluded_reason ('role: <word>', 'dim_min:<dim>' or 'below_cutoff:<score>') and
// status 'role_mismatch' (role) so no lane picks it up. An old 4-key row (legacy: skills, seniority, domain, location) has neither: only the
// TITLE gate applies to it, and its old stored score is never judged against the new cutoff. Sent, applied, connected, sending and any other advanced rows are never touched.
// Usage: npm run matches:regate            (dry run: prints what WOULD be parked, changes nothing)
//        npm run matches:regate -- --apply (parks them)        database: JOBAPPLIER_DB, default data.sqlite
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { checkRole, loadRoleGateConfig, ROLE_MISMATCH_STATUS, type RoleGateConfig } from '../src/roleGate.js';
import { dimMinimumsFromEnv, failedDims, matchThresholdFromEnv, parseStoredDims, type DimKey, type RubricDims } from '../src/matchRubric.js';

export interface RegateRow { job_id: string; title: string; company: string; reason: string }
export interface RegateResult { considered: number; would_park: RegateRow[]; parked: number; applied: boolean }

const OPEN = "('', 'queued', 'manual_review')";

export function rematchGate(
  db: BetterSqlite3.Database,
  opts: { apply?: boolean; cfg?: RoleGateConfig; mins?: Readonly<RubricDims>; threshold?: number } = {},
): RegateResult {
  const cfg = opts.cfg ?? loadRoleGateConfig().config;
  const mins = opts.mins ?? dimMinimumsFromEnv().mins;
  const threshold = opts.threshold ?? matchThresholdFromEnv();
  const rows = db.prepare(
    `SELECT j.id AS id, j.title AS title, j.company AS company, j.description AS description, j.score_dims AS score_dims, j.score AS score
       FROM jobs j
      WHERE j.score IS NOT NULL AND j.excluded_reason IS NULL
        AND NOT EXISTS (SELECT 1 FROM job_exclusion_log l WHERE l.job_id = j.id)
        AND EXISTS (SELECT 1 FROM outreach_queue q WHERE q.job_id = j.id AND q.status = 'queued')
        AND NOT EXISTS (SELECT 1 FROM outreach_queue q WHERE q.job_id = j.id AND (
              q.email_sent_at IS NOT NULL OR q.email_message_id IS NOT NULL
              OR COALESCE(q.email_status, '') NOT IN ${OPEN} OR COALESCE(q.connect_status, '') NOT IN ${OPEN}
              OR COALESCE(q.apply_status, '') NOT IN ${OPEN}
              OR COALESCE(q.status, '') NOT IN ('queued', 'skipped')))
        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.job_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.job_id = j.id)
      ORDER BY j.id`,
  ).all() as Array<{ id: string; title: string | null; company: string | null; description: string | null; score_dims: string | null; score: number | null }>;
  const bad: RegateRow[] = [];
  for (const r of rows) {
    const role = checkRole({ title: r.title, description: r.description }, cfg);
    let reason: string | null = role.verdict === 'reject' ? role.reason : null;
    if (!reason) {
      const { kind, dims } = parseStoredDims(r.score_dims);
      if (kind === 'rubric_v2' && dims) {
        const failed = failedDims(dims as unknown as RubricDims, mins) as DimKey[];
        if (failed.length) reason = `dim_min:${failed.join(',')}`;
      } else if (kind === 'career_ops' && r.score !== null && r.score < threshold) {
        reason = `below_cutoff:${r.score}`;
      }
    }
    if (reason) bad.push({ job_id: r.id, title: r.title ?? '', company: r.company ?? '', reason });
  }
  let parked = 0;
  if (opts.apply && bad.length) {
    const skipQ = db.prepare("UPDATE outreach_queue SET status = 'skipped', updated_at = datetime('now') WHERE job_id = ? AND status = 'queued'");
    const excl = db.prepare('UPDATE jobs SET excluded_reason = ?, status = CASE WHEN ? = 1 THEN ? ELSE status END WHERE id = ? AND excluded_reason IS NULL');
    db.transaction(() => {
      for (const b of bad) {
        parked += skipQ.run(b.job_id).changes > 0 ? 1 : 0;
        excl.run(b.reason, b.reason.startsWith('role: ') ? 1 : 0, ROLE_MISMATCH_STATUS, b.job_id);
      }
    })();
  }
  return { considered: rows.length, would_park: bad, parked, applied: !!opts.apply };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const apply = process.argv.includes('--apply');
  const db = openDb(dbPath());
  try {
    const r = rematchGate(db, { apply });
    console.log(`${apply ? 'APPLY' : 'DRY RUN (add --apply to change anything)'}: ${r.considered} scored jobs with an unsent queued row checked; ${apply ? `${r.parked} parked` : `${r.would_park.length} would be parked`}`);
    for (const b of r.would_park) console.log(`  - ${b.title} | ${b.company} | ${b.reason}`);
  } finally {
    db.close();
  }
}
