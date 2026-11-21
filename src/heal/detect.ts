// src/heal/detect.ts
// Detection (pure code, zero LLM): reads the places a failure leaves a trace and turns each into a signature + a ledger sighting.
//   1. scheduler_runs rows with status failed / crashed / incomplete (and ok rows whose summary names a discovery failure marker)
//   2. outreach_queue rows with apply_status needs_owner / manual_review / failed (apply_note holds the code), plus needs_human /
//      needs_answer rows (recorded only so the ledger shows them as never-heal)
//   3. new files in .jobber/diag (structure diagnostics of missing page controls)
//   4. jobs stuck in jd_pending, queue rows with an incomplete JD
//   5. the drip lanes' last refusal (scheduler_state drip_last_refusal_<lane>)
// A cursor per source (scheduler_state) makes each row count once. Never throws: a source that cannot be read is skipped.
import type BetterSqlite3 from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { getState, setState } from '../scheduler/runLog.js';
import { classify, signatureOf, SUMMARY_SIGNALS, type Failure, type Verdict } from './signature.js';
import { getLedgerBySignature, migrateHealTables, recordSighting, type Evidence, type LedgerRow } from './ledger.js';

type Db = BetterSqlite3.Database;

export interface Sighting { failure: Failure; verdict: Verdict; evidence: Partial<Evidence>; at: Date }

/** A first scan only looks this far back, so an old backlog never starts a storm of heals. */
export const FIRST_SCAN_HOURS = 6;
/** A standing condition (jd stuck) is recorded at most this often, so `last_seen` keeps meaning "it happened again". */
export const STANDING_EVERY_MS = 6 * 3600_000;
const JD_STUCK_MIN = 5;
const JD_STUCK_AGE_H = 24;
const JD_INCOMPLETE_MIN = 3;

const cursorKey = (src: string): string => `heal_cursor_${src}`;
const sqlTime = (s: string): Date => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);

function readCursor(db: Db, src: string, now: Date): string {
  const v = getState(db, cursorKey(src));
  return v && Number.isFinite(Date.parse(v)) ? v : new Date(now.getTime() - FIRST_SCAN_HOURS * 3600_000).toISOString();
}

interface RunRowLite { id: string; planned_at: string; ended_at?: string | null; trigger: string; status: string; stop_reason: string | null; window: string | null; summary: string | null }

const stepSlug = (s: string): string => s.replace(/^\d+\.\s*/, '').trim().split(/[,(;]/)[0] ?? '';

/** Failure of one scheduler_runs row, or null when the row is fine. */
export function failureOfRun(r: RunRowLite): Failure | null {
  const stop = r.stop_reason ?? '';
  const window = r.window ?? undefined;
  if (r.status === 'crashed') return { area: 'run', code: `crashed:${stop || 'unknown'}`, window };
  if (r.status === 'failed') return { area: 'run', code: `failed:${stop || 'unknown'}`, window };
  if (r.status === 'incomplete') {
    const m = /unproven steps?:\s*([^()]*?)(?:\s*\(not continued\)|$)/i.exec(stop);
    if (m && m[1] && !/none listed/i.test(m[1])) return { area: 'run', code: `incomplete:${stepSlug(m[1])}`, window };
    if (/stalled|usage_backoff|no_transcript/i.test(stop)) return { area: 'run', code: `incomplete:${stop}`, window };
    return { area: 'run', code: `incomplete:${stop || 'unknown'}`, window };
  }
  if ((r.status === 'ok' || r.status === 'incomplete') && r.summary) {
    const sig = SUMMARY_SIGNALS.find((s) => s.pattern.test(r.summary as string));
    if (sig) return { area: 'discover', code: sig.code, platform: window, window };
  }
  return null;
}

function scanRuns(db: Db, since: string): Sighting[] {
  const out: Sighting[] = [];
  const rows = db.prepare(
    `SELECT id, planned_at, ended_at, trigger, status, stop_reason, window, summary FROM scheduler_runs
      WHERE ended_at IS NOT NULL AND ended_at > ? AND (status IN ('failed', 'crashed', 'incomplete') OR (status = 'ok' AND summary IS NOT NULL AND length(summary) > 0))
      ORDER BY ended_at ASC LIMIT 500`,
  ).all(since) as RunRowLite[];
  for (const r of rows) {
    const f = failureOfRun(r);
    if (!f) continue;
    out.push({ failure: f, verdict: classify(f), evidence: { runs: [r.id], note: r.stop_reason ?? r.summary ?? '', ...(r.window ? { window: r.window } : {}) }, at: new Date(r.ended_at ?? r.planned_at) });
  }
  return out;
}

/** The reason code of an apply row: the first token of apply_note, with the status for the owner-only states. */
export function failureOfQueueRow(status: string, note: string | null, platform: string | null): Failure {
  const code0 = (note ?? '').split(' - ')[0]?.trim() ?? '';
  const code = status === 'needs_human' || status === 'needs_answer' ? `${status}:${code0}` : code0 || status;
  return { area: 'apply', code, ...(platform ? { platform } : {}) };
}

function scanQueue(db: Db, since: string): Sighting[] {
  const out: Sighting[] = [];
  try {
    const rows = db.prepare(
      `SELECT id, apply_platform, apply_status, apply_note, updated_at FROM outreach_queue
        WHERE apply_status IN ('needs_owner', 'manual_review', 'failed', 'needs_human', 'needs_answer') AND datetime(updated_at) > datetime(?)
        ORDER BY updated_at ASC LIMIT 500`,
    ).all(since) as Array<{ id: number; apply_platform: string | null; apply_status: string; apply_note: string | null; updated_at: string }>;
    for (const r of rows) {
      const f = failureOfQueueRow(r.apply_status, r.apply_note, r.apply_platform);
      out.push({ failure: f, verdict: classify(f), evidence: { queue: [r.id], note: r.apply_note ?? r.apply_status, ...(r.apply_platform ? { platform: r.apply_platform } : {}) }, at: sqlTime(r.updated_at) });
    }
  } catch { /* table or column missing */ }
  return out;
}

function scanDiag(root: string, sinceMs: number): { sightings: Sighting[]; maxMs: number } {
  const sightings: Sighting[] = [];
  let maxMs = sinceMs;
  const dir = path.join(root, '.jobber', 'diag');
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return { sightings, maxMs }; }
  for (const n of names) {
    try {
      const st = statSync(path.join(dir, n));
      if (st.mtimeMs <= sinceMs) continue;
      maxMs = Math.max(maxMs, st.mtimeMs);
      const j = JSON.parse(readFileSync(path.join(dir, n), 'utf8')) as { platform?: unknown; code?: unknown };
      const platform = typeof j.platform === 'string' ? j.platform : n.split('-')[0] ?? 'unknown';
      const code = typeof j.code === 'string' ? j.code : 'structure';
      const f: Failure = { area: 'diag', code, platform };
      sightings.push({ failure: f, verdict: classify(f), evidence: { diag: [n], note: code, platform }, at: new Date(st.mtimeMs) });
    } catch { /* unreadable file: skip */ }
  }
  return { sightings, maxMs };
}

function standingDue(db: Db, sig: string, now: Date): boolean {
  const l = getLedgerBySignature(db, sig);
  return !l || now.getTime() - Date.parse(l.last_seen) >= STANDING_EVERY_MS;
}

function scanJd(db: Db, now: Date): Sighting[] {
  const out: Sighting[] = [];
  try {
    const cut = new Date(now.getTime() - JD_STUCK_AGE_H * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'jd_pending' AND created_at < ?").get(cut) as { n: number }).n;
    const f: Failure = { area: 'jd', code: 'pending_stuck' };
    if (n >= JD_STUCK_MIN && standingDue(db, signatureOf(f), now)) out.push({ failure: f, verdict: classify(f), evidence: { note: `${n} jobs in jd_pending for over ${JD_STUCK_AGE_H} h` }, at: now });
  } catch { /* no jobs table */ }
  try {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM outreach_queue WHERE ats_note = 'jd_incomplete' AND status = 'queued'").get() as { n: number }).n;
    const f: Failure = { area: 'jd', code: 'incomplete' };
    if (n >= JD_INCOMPLETE_MIN && standingDue(db, signatureOf(f), now)) out.push({ failure: f, verdict: classify(f), evidence: { note: `${n} queued rows with an incomplete JD` }, at: now });
  } catch { /* column missing */ }
  return out;
}

function scanLanes(db: Db, since: string): Sighting[] {
  const out: Sighting[] = [];
  for (const lane of ['mail', 'linkedin']) {
    try {
      const raw = getState(db, `drip_last_refusal_${lane}`);
      if (!raw) continue;
      const j = JSON.parse(raw) as { at?: unknown; reason?: unknown };
      if (typeof j.at !== 'string' || typeof j.reason !== 'string' || j.at <= since) continue;
      const f: Failure = { area: 'lane', code: `${lane}:${j.reason}` };
      out.push({ failure: f, verdict: classify(f), evidence: { note: `${lane} drip refused: ${j.reason}` }, at: new Date(j.at) });
    } catch { /* bad json: skip */ }
  }
  return out;
}

/** Scans every source once, records each sighting in the ledger, advances the cursors. Returns the ledger rows that were touched. */
export function ingestFailures(db: Db, root: string, now: Date): LedgerRow[] {
  migrateHealTables(db);
  const touched = new Map<number, LedgerRow>();
  const keep = (list: Sighting[]): void => {
    for (const s of list) {
      try {
        const row = recordSighting(db, s.verdict, s.evidence, s.at);
        touched.set(row.id, row);
      } catch { /* one bad row never stops the scan */ }
    }
  };
  const nowIso = now.toISOString();
  const safe = <T,>(fn: () => T, dflt: T): T => { try { return fn(); } catch { return dflt; } };

  const runsSince = readCursor(db, 'runs', now);
  const runs = safe(() => scanRuns(db, runsSince), []);
  keep(runs);
  const runsMax = runs.reduce((m, s) => (s.at.toISOString() > m ? s.at.toISOString() : m), runsSince);

  const queueSince = readCursor(db, 'queue', now);
  const queue = safe(() => scanQueue(db, queueSince), []);
  keep(queue);
  const queueMax = queue.reduce((m, s) => (s.at.toISOString() > m ? s.at.toISOString() : m), queueSince);

  const diagSince = Number(getState(db, cursorKey('diag')));
  const diagFrom = Number.isFinite(diagSince) && diagSince > 0 ? diagSince : now.getTime() - FIRST_SCAN_HOURS * 3600_000;
  const diag = scanDiag(root, diagFrom);
  keep(diag.sightings);

  const laneSince = readCursor(db, 'lanes', now);
  const lanes = safe(() => scanLanes(db, laneSince), []);
  keep(lanes);
  keep(safe(() => scanJd(db, now), []));

  try {
    setState(db, cursorKey('runs'), runsMax, now);
    setState(db, cursorKey('queue'), queueMax, now);
    setState(db, cursorKey('diag'), String(diag.maxMs), now);
    setState(db, cursorKey('lanes'), lanes.reduce((m, s) => (s.at.toISOString() > m ? s.at.toISOString() : m), laneSince) || nowIso, now);
  } catch { /* cursors are advisory */ }
  return [...touched.values()];
}
