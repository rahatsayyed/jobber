// Persistence and state machine for generated providers (plan 8G task 8, D7).
// The spec is a JSON data file (mode 0600) under the git-ignored generated/providers/; state lives in the generated_providers table.
// candidate -> validated (fixture replay passed) -> trusted (clean runs over distinct run ids). Approval is a separate owner flag that
// releases held outreach rows. Nothing here imports, requires or evaluates a generated file: it is read as JSON and schema-parsed.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { PROMOTE_MIN_RUN_IDS, validateProviderSpec, type ValidationResult } from './validate.js';
import { ID_RE, specSchema, type ProviderSpec } from './spec.js';

type Db = BetterSqlite3.Database;
export type ProviderState = 'candidate' | 'validated' | 'trusted';
export interface ProviderRow {
  id: string; state: ProviderState; approved: number; clean_runs: number; run_ids: string; task_id: number | null; reason: string | null;
  created_at: string; updated_at: string;
}

export function specPath(root: string, id: string): string | null {
  if (!ID_RE.test(id)) return null;
  const dir = path.resolve(root, 'providers');
  const file = path.resolve(dir, `${id}.json`);
  return file.startsWith(dir + path.sep) ? file : null;
}

/** Writes the spec as data, 0600, via a temp file and rename (never follows an existing symlink target). */
export function writeSpecFile(root: string, spec: ProviderSpec): boolean {
  const file = specPath(root, spec.id);
  if (!file) return false;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(spec, null, 2), { mode: 0o600, flag: 'w' });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return true;
}

/** Reads and schema-parses a stored spec; null for anything missing, unparseable or invalid. */
export function readSpecFile(root: string, id: string): ProviderSpec | null {
  const file = specPath(root, id);
  if (!file || !existsSync(file)) return null;
  try {
    const r = specSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return r.success && r.data.id === id ? r.data : null;
  } catch { return null; }
}

export const getProvider = (db: Db, id: string): ProviderRow | undefined =>
  db.prepare('SELECT * FROM generated_providers WHERE id = ?').get(id) as ProviderRow | undefined;
export const listProviders = (db: Db): ProviderRow[] =>
  db.prepare('SELECT * FROM generated_providers ORDER BY id').all() as ProviderRow[];
export const isProviderApproved = (db: Db, id: string): boolean => getProvider(db, id)?.approved === 1;

export interface ProposeResult { ok: boolean; state?: ProviderState; code?: string; validation?: ValidationResult }

/** Schema, write, fixture replay. A re-proposal replaces a candidate or validated provider; a trusted or approved one is refused. */
export function proposeProvider(db: Db, root: string, input: unknown, o: { minJobs: number; now: Date; taskId?: number }): ProposeResult {
  const parsed = specSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'schema', validation: { ok: false, code: 'schema', jobs: 0, detail: String(parsed.error.issues[0]?.path.join('.') ?? '').slice(0, 60) } };
  const spec = parsed.data;
  const prev = getProvider(db, spec.id);
  if (prev && (prev.state === 'trusted' || prev.approved)) return { ok: false, code: 'exists' };
  if (!writeSpecFile(root, spec)) return { ok: false, code: 'bad_path' };
  const at = o.now.toISOString();
  db.prepare(`INSERT INTO generated_providers (id, state, task_id, created_at, updated_at) VALUES (@id, 'candidate', @task, @at, @at)
    ON CONFLICT(id) DO UPDATE SET state='candidate', clean_runs=0, run_ids='[]', task_id=@task, reason=NULL, updated_at=@at`).run({ id: spec.id, task: o.taskId ?? null, at });
  return revalidate(db, root, spec, o.minJobs, o.now);
}

/** Re-run fixture replay for a stored provider; a pass makes a candidate `validated`, a fail records the code and keeps/returns `candidate`. */
export function revalidate(db: Db, root: string, spec: ProviderSpec, minJobs: number, now: Date): ProposeResult {
  const v = validateProviderSpec(spec, root, minJobs);
  const row = getProvider(db, spec.id);
  const at = now.toISOString();
  if (v.ok) {
    if (row?.state === 'candidate') db.prepare("UPDATE generated_providers SET state='validated', reason=NULL, updated_at=? WHERE id=?").run(at, spec.id);
    return { ok: true, state: (getProvider(db, spec.id)?.state ?? 'validated') as ProviderState, validation: v };
  }
  db.prepare('UPDATE generated_providers SET reason=?, updated_at=? WHERE id=?').run(v.code ?? 'invalid', at, spec.id);
  return { ok: false, state: (row?.state ?? 'candidate') as ProviderState, code: v.code, validation: v };
}

/** Providers the runner may execute: validated or trusted, with a readable valid spec. */
export function loadRunnable(db: Db, root: string): ProviderSpec[] {
  const out: ProviderSpec[] = [];
  for (const r of db.prepare("SELECT id FROM generated_providers WHERE state IN ('validated','trusted') ORDER BY id").all() as Array<{ id: string }>) {
    const s = readSpecFile(root, r.id);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Record one runner pass. Clean (shape ok, kept > 0, schema ok) counts; anything else resets the streak. `trusted` needs promoteN clean runs
 * over at least two distinct run ids (a repeat of one run id adds no id). Returns the state after the call.
 */
export function recordProviderRun(db: Db, id: string, o: { runId: string; clean: boolean; promoteN: number; now: Date }): ProviderState | null {
  const row = getProvider(db, id);
  if (!row || row.state === 'candidate') return row ? 'candidate' : null;
  const at = o.now.toISOString();
  if (!o.clean) {
    db.prepare("UPDATE generated_providers SET clean_runs=0, run_ids='[]', updated_at=? WHERE id=?").run(at, id);
    return row.state;
  }
  let ids: string[] = [];
  try { const j = JSON.parse(row.run_ids); if (Array.isArray(j)) ids = j.filter((x) => typeof x === 'string'); } catch { /* start over */ }
  if (!ids.includes(o.runId)) ids.push(o.runId);
  const runs = row.clean_runs + 1;
  const promote = row.state === 'validated' && runs >= o.promoteN && ids.length >= PROMOTE_MIN_RUN_IDS;
  db.prepare('UPDATE generated_providers SET clean_runs=?, run_ids=?, state=?, updated_at=? WHERE id=?').run(runs, JSON.stringify(ids.slice(-20)), promote ? 'trusted' : row.state, at, id);
  return promote ? 'trusted' : row.state;
}

/** Owner approval: needs validated or trusted. Releases the provider's held_review outreach rows to queued. */
export function approveProvider(db: Db, id: string, now: Date, o: { force?: boolean } = {}): { ok: boolean; code?: string; released?: number } {
  const row = getProvider(db, id);
  if (!row) return { ok: false, code: 'unknown_provider' };
  if (row.state === 'candidate') return { ok: false, code: 'not_validated' };
  // Only a trusted provider (clean runs over distinct run ids) is approvable; the owner can override with an explicit force.
  if (row.state !== 'trusted' && !o.force) return { ok: false, code: 'not_trusted' };
  const tx = db.transaction(() => {
    db.prepare('UPDATE generated_providers SET approved=1, updated_at=? WHERE id=?').run(now.toISOString(), id);
    return db.prepare(`UPDATE outreach_queue SET status='queued', updated_at=datetime('now') WHERE status='held_review'
      AND job_id IN (SELECT id FROM jobs WHERE source = ?)`).run(`gen:${id}`).changes;
  });
  return { ok: true, released: tx() };
}

/** Owner rejection: deletes the spec file and the row; the provider's held outreach rows become skipped. */
export function rejectProvider(db: Db, root: string, id: string): { ok: boolean; code?: string; skipped?: number } {
  const row = getProvider(db, id);
  if (!row) return { ok: false, code: 'unknown_provider' };
  const tx = db.transaction(() => {
    const n = db.prepare(`UPDATE outreach_queue SET status='skipped', updated_at=datetime('now') WHERE status='held_review'
      AND job_id IN (SELECT id FROM jobs WHERE source = ?)`).run(`gen:${id}`).changes;
    db.prepare('DELETE FROM generated_providers WHERE id=?').run(id);
    return n;
  });
  const skipped = tx();
  const file = specPath(root, id);
  if (file) rmSync(file, { force: true });
  return { ok: true, skipped };
}

/** The registry row `approve --promote` prints for the owner to commit into config/platforms.json (nothing is written automatically). */
export function registryRowFor(spec: ProviderSpec): Record<string, unknown> {
  return { id: spec.id, kind: 'generated', label: spec.label, provider: `generated:${spec.id}`, tier: 'script', enabled: false, stability: 'fixture' };
}
