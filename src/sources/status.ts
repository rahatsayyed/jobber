// One per-source status for every discovery source (replaces the board-only status; `board_status` stays as an alias).
// Providers run through collectSources(), which never throws: a failing source becomes an outcome with a redacted error.
import type BetterSqlite3 from 'better-sqlite3';
import type { Job } from '../db.js';
import { redactPane } from '../platform/redact.js';
import { loadRegistry, type PlatformDef, type PlatformKind } from './registry.js';

type Db = BetterSqlite3.Database;

export interface SourceOutcome { id: string; fetched: number; kept: number; error?: string; fallback_used?: boolean; shape_hash?: string; note?: string }
export interface SourceProvider {
  id: string;
  /** Plain jobs, or jobs plus per-source outcomes (one fetch that covers several sources, such as the boards). */
  run: () => Promise<Job[] | { jobs: Job[]; outcomes: SourceOutcome[] }>;
}
export interface SourceStatusRow {
  source: string; kind: 'script' | 'agent'; group: PlatformKind;
  fetched: number; kept: number; new: number; error?: string; fallback_used: boolean; note?: string;
}

const SECRET_PARAM = /([?&;]|\b)(app_?key|app_?id|api_?key|key|token|access_token|secret|client_secret|password|auth|sig|signature)=[^&\s"']*/gi;

/** Redact an error string for storage and display: secret-looking URL parameters first, then the pane redactor; capped at 300 chars. */
export function redactError(e: unknown): string {
  const msg = typeof e === 'string' ? e : String((e as any)?.message ?? e);
  return redactPane(msg.replace(SECRET_PARAM, (_m, pre, name) => `${pre}${name}=[redacted]`)).replace(/\s+/g, ' ').trim().slice(0, 300);
}

export async function collectSources(providers: SourceProvider[]): Promise<{ jobs: Job[]; outcomes: SourceOutcome[] }> {
  const results = await Promise.all(providers.map(async (p) => {
    try {
      const r = await p.run();
      if (Array.isArray(r)) return { jobs: r, outcomes: [{ id: p.id, fetched: r.length, kept: r.length }] as SourceOutcome[] };
      return { jobs: r.jobs, outcomes: r.outcomes };
    } catch (e) {
      console.error(`[sources] ${p.id} failed:`, redactError(e));
      return { jobs: [] as Job[], outcomes: [{ id: p.id, fetched: 0, kept: 0, error: redactError(e) }] as SourceOutcome[] };
    }
  }));
  return { jobs: results.flatMap((r) => r.jobs), outcomes: results.flatMap((r) => r.outcomes) };
}

/** Per-vendor outcomes from the boards' per-company stats and error strings ("<ats> <slug>: ..."); unattributed errors go to `portals`. */
export function statsToOutcomes(stats: ReadonlyArray<{ ats: string; fetched: number; kept: number; company?: string }>, errors: string[]): SourceOutcome[] {
  const by = new Map<string, SourceOutcome>();
  const get = (id: string) => { let o = by.get(id); if (!o) by.set(id, (o = { id, fetched: 0, kept: 0 })); return o; };
  for (const s of stats) { const o = get(s.ats); o.fetched += s.fetched; o.kept += s.kept; }
  const vendors = new Set(loadRegistry().platforms.filter((p) => p.kind === 'board' || p.kind === 'aggregator').map((p) => p.id));
  for (const e of errors) {
    const vendor = e.split(' ', 1)[0];
    const o = get(vendors.has(vendor) ? vendor : 'portals');
    o.error = o.error ? `${o.error}; ${e}` : e;
  }
  return [...by.values()];
}

export function recordRun(db: Db, id: string, r: { fetched: number; kept: number; new: number; error?: string; fallback_used?: boolean; shape_hash?: string | null; note?: string }): void {
  const error = r.error ? redactError(r.error) : null;
  db.prepare(`INSERT INTO platform_status (id, last_run_at, last_status, fetched, kept, new_count, error, fallback_used, streak_fail, shape_hash, note)
    VALUES (@id, @at, @status, @fetched, @kept, @new, @error, @fb, @streak, @shape, @note)
    ON CONFLICT(id) DO UPDATE SET last_run_at=@at, last_status=@status, fetched=@fetched, kept=@kept, new_count=@new, error=@error,
      fallback_used=@fb, streak_fail=CASE WHEN @error IS NULL THEN 0 ELSE platform_status.streak_fail + 1 END,
      shape_hash=COALESCE(@shape, platform_status.shape_hash), note=@note`).run({
    id, at: new Date().toISOString(), status: error ? 'error' : 'ok', fetched: r.fetched, kept: r.kept, new: r.new, error,
    fb: r.fallback_used ? 1 : 0, streak: error ? 1 : 0, shape: r.shape_hash ?? null, note: r.note ?? null,
  });
}

let dropped: { count: number; ids: string[] } | undefined;
export function setDroppedDuplicates(jobs: Job[]): void { dropped = { count: jobs.length, ids: jobs.slice(0, 20).map((j) => j.id) }; }
export function resetSourceStatusForTests(): void { dropped = undefined; }

/** Persist one run: `newJobs` are the jobs saved in this call, counted per `job.source`. */
export function finishRun(db: Db, outcomes: SourceOutcome[], newJobs: Job[]): void {
  const fresh = new Map<string, number>();
  for (const j of newJobs) fresh.set(j.source, (fresh.get(j.source) ?? 0) + 1);
  for (const o of outcomes) recordRun(db, o.id, { fetched: o.fetched, kept: o.kept, new: fresh.get(o.id) ?? 0, error: o.error, fallback_used: o.fallback_used, shape_hash: o.shape_hash, note: o.note });
}

interface StatusRecord { id: string; last_run_at: string | null; fetched: number; kept: number; new_count: number; error: string | null; fallback_used: number; note: string | null }

/** Read-only: the last stored run of every source. Never fetches. */
export function sourceStatusPayload(db: Db): { ran: boolean; at?: string; rows: SourceStatusRow[]; dropped_duplicates?: { count: number; ids: string[] }; note?: string } {
  const recs = db.prepare('SELECT id, last_run_at, fetched, kept, new_count, error, fallback_used, note FROM platform_status WHERE last_run_at IS NOT NULL ORDER BY id').all() as StatusRecord[];
  if (!recs.length) return { ran: false, rows: [], note: 'no source fetch has run yet' };
  const reg = new Map<string, PlatformDef>(loadRegistry().platforms.map((p) => [p.id, p]));
  const rows = recs.map((r): SourceStatusRow => {
    const def = reg.get(r.id);
    return {
      source: r.id, kind: def?.tier ?? 'script', group: def?.kind ?? 'board',
      fetched: r.fetched, kept: r.kept, new: r.new_count,
      ...(r.error ? { error: r.error } : {}), fallback_used: r.fallback_used === 1, ...(r.note ? { note: r.note } : {}),
    };
  });
  const at = recs.map((r) => r.last_run_at as string).sort().at(-1);
  return { ran: true, at, rows, ...(dropped ? { dropped_duplicates: dropped } : {}) };
}

/** `board_status` kept as an alias for one release: the old payload plus a pointer to `source_status`. */
export function boardStatusAlias<T extends object>(payload: T): T & { deprecated: string } {
  return { ...payload, deprecated: 'use source_status' };
}
