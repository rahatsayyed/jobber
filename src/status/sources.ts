/* One table for every discovery source: registry platforms, generated providers and whatever platform_status stored.
   Read-only. Reuses sourceStatusPayload for the stored rows; a source with no stored run is shown as `ran:no`. */
import type BetterSqlite3 from 'better-sqlite3';
import { loadRegistry } from '../sources/registry.js';
import { sourceStatusPayload } from '../sources/status.js';
import type { Notice } from '../scheduler/notify.js';

type Db = BetterSqlite3.Database;

export interface SourceTableRow {
  id: string;
  kind: 'script' | 'agent';
  ran: boolean;
  fetched: number;
  kept: number;
  new: number;
  errors: number;
  error?: string;
  fallback_used: boolean;
}

export const SOURCE_COLUMNS = ['source id', 'kind (script|agent)', 'fetched', 'kept', 'new', 'errors', 'fallback used'] as const;

function tableExists(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

export const DEFAULT_WINDOW_HOURS = 24;
const NOTICE_DETAIL_BUDGET = 900;

/** Rows of every known source. A stored row counts as ran only when its last run is at or after `sinceIso`; older numbers are hidden (ran:no). */
export function buildSourceRows(db: Db, sinceIso: string): SourceTableRow[] {
  const stored = tableExists(db, 'platform_status') ? sourceStatusPayload(db).rows : [];
  const byId = new Map<string, SourceTableRow>();
  for (const r of stored) {
    if (!r.last_run_at || r.last_run_at < sinceIso) continue;
    byId.set(r.source, {
      id: r.source, kind: r.kind, ran: true, fetched: r.fetched, kept: r.kept, new: r.new,
      errors: r.error ? 1 : 0, ...(r.error ? { error: r.error } : {}), fallback_used: r.fallback_used,
    });
  }
  const idle = (id: string, kind: 'script' | 'agent'): SourceTableRow => ({ id, kind, ran: false, fetched: 0, kept: 0, new: 0, errors: 0, fallback_used: false });
  for (const p of loadRegistry().platforms) {
    if (p.enabled && !byId.has(p.id)) byId.set(p.id, idle(p.id, p.tier));
  }
  if (tableExists(db, 'generated_providers')) {
    const gens = db.prepare('SELECT id FROM generated_providers ORDER BY id').all() as { id: string }[];
    for (const g of gens) {
      const id = g.id.startsWith('gen:') ? g.id : `gen:${g.id}`;
      if (!byId.has(id)) byId.set(id, idle(id, 'script'));
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function cells(r: SourceTableRow): string[] {
  if (!r.ran) return [r.id, r.kind, 'ran:no', '-', '-', '-', '-'];
  return [r.id, r.kind, String(r.fetched), String(r.kept), String(r.new), String(r.errors), r.fallback_used ? 'yes' : 'no'];
}

export function renderSources(rows: SourceTableRow[], header?: string): string {
  if (!rows.length) return 'no sources';
  const lines = [...(header ? [header] : []), SOURCE_COLUMNS.join(' | '), ...rows.map((r) => cells(r).join(' | '))];
  for (const r of rows) if (r.error) lines.push(`error ${r.id}: ${r.error}`);
  return lines.join('\n');
}

/** End-of-wake notice: the same numbers as the table (counts per row, fallbacks, errors). Never throws; null when nothing ran. */
export function sourcesNotice(db: Db, o: { runId?: string; sinceIso: string; note?: string }): Notice | null {
  const runId = o.runId;
  try {
    const rows = buildSourceRows(db, o.sinceIso);
    const ran = rows.filter((r) => r.ran);
    if (!ran.length && !o.note) return null;
    const errors = ran.reduce((n, r) => n + r.errors, 0);
    const fallbacks = ran.filter((r) => r.fallback_used).length;
    const fetched = ran.reduce((n, r) => n + r.fetched, 0);
    const fresh = ran.reduce((n, r) => n + r.new, 0);
    // The notifier keeps 1000 characters of detail: list ran rows only and summarize what does not fit.
    const head = `${o.note ? `code pass: ${o.note}\n` : ''}`;
    let shown = ran;
    let detail = head + renderSources(shown);
    while (detail.length > NOTICE_DETAIL_BUDGET && shown.length > 1) {
      shown = shown.slice(0, -1);
      detail = `${head}${renderSources(shown)}\n+${ran.length - shown.length} more rows (npm run status -- sources)`;
    }
    return {
      level: errors > 0 || o.note ? 'warn' : 'info',
      title: `sources: ${ran.length} ran, fetched ${fetched}, new ${fresh}, errors ${errors}, fallback ${fallbacks}`,
      detail: ran.length ? detail : head.trim(),
      ...(runId ? { runId } : {}),
    };
  } catch (e) {
    console.error('[status] sources notice failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
