// src/heal/ledger.ts
// The heal ledger: one row per failure signature (deduped), one row per heal attempt, the cooldown, the daily cap and the single-flight lock.
// Evidence is stored as references only (run ids, queue row ids, diag file names) plus one short redacted line; never raw page or mail text.
import type BetterSqlite3 from 'better-sqlite3';
import path from 'node:path';
import { acquireLock, type LockHandle } from '../platform/lock.js';
import { redactPane } from '../platform/redact.js';
import { HEALING_STALE_MS, REOPEN_AFTER_DAYS } from './config.js';
import type { Verdict } from './signature.js';

type Db = BetterSqlite3.Database;

export type LedgerState = 'open' | 'healing' | 'ready' | 'landed' | 'rolled_back' | 'gave_up' | 'ignored';
export type AttemptOutcome =
  | 'running' | 'ready' | 'abandoned' | 'gate_failed' | 'verify_failed' | 'stale_base' | 'land_failed'
  | 'landed' | 'stable' | 'rolled_back' | 'error' | 'live_failed';
export type RestartState = 'none' | 'pending' | 'postponed' | 'done' | 'manual';

export interface Evidence {
  runs: string[];
  queue: number[];
  diag: string[];
  /** One short redacted line (a stop reason or a summary excerpt). */
  note: string;
  platform?: string;
  window?: string;
}

export interface LedgerRow {
  id: number;
  signature: string;
  first_seen: string;
  last_seen: string;
  count: number;
  state: LedgerState;
  last_heal_id: number | null;
  evidence: string;
  verdict: 'heal' | 'never';
  note: string | null;
  requeue_safe: number;
}

export interface AttemptRow {
  id: number;
  ledger_id: number;
  started_at: string;
  ended_at: string | null;
  mode: string;
  branch: string | null;
  worktree: string | null;
  base_head: string | null;
  head: string | null;
  report: string | null;
  outcome: AttemptOutcome;
  note: string | null;
  files: string | null;
  prev_head: string | null;
  landed_head: string | null;
  restart_state: RestartState;
  restart_targets: string | null;
  restart_at: string | null;
  watch_until: string | null;
  requeued: number;
  // The latest live-check verdict (JSON: verdict, at, first_skip_at, told), or null.
  live: string | null;
}

export function migrateHealTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS heal_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT NOT NULL UNIQUE,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'open',
      last_heal_id INTEGER,
      evidence TEXT NOT NULL DEFAULT '{}',
      verdict TEXT NOT NULL DEFAULT 'heal',
      note TEXT,
      requeue_safe INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS heal_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      mode TEXT NOT NULL,
      branch TEXT,
      worktree TEXT,
      base_head TEXT,
      head TEXT,
      report TEXT,
      outcome TEXT NOT NULL DEFAULT 'running',
      note TEXT,
      files TEXT,
      prev_head TEXT,
      landed_head TEXT,
      restart_state TEXT NOT NULL DEFAULT 'none',
      restart_targets TEXT,
      restart_at TEXT,
      watch_until TEXT,
      requeued INTEGER NOT NULL DEFAULT 0,
      live TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_heal_attempts_ledger ON heal_attempts (ledger_id, started_at);
  `);
  const cols = new Set((db.prepare('PRAGMA table_info(heal_attempts)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('live')) db.exec('ALTER TABLE heal_attempts ADD COLUMN live TEXT');
}

const EVIDENCE_KEEP = 10;
const mergeList = <T>(a: T[], b: T[]): T[] => [...new Set([...a, ...b])].slice(-EVIDENCE_KEEP);

function parseEvidence(s: string): Evidence {
  try {
    const j = JSON.parse(s) as Partial<Evidence>;
    return {
      runs: Array.isArray(j.runs) ? j.runs.filter((x): x is string => typeof x === 'string') : [],
      queue: Array.isArray(j.queue) ? j.queue.filter((x): x is number => Number.isInteger(x)) : [],
      diag: Array.isArray(j.diag) ? j.diag.filter((x): x is string => typeof x === 'string') : [],
      note: typeof j.note === 'string' ? j.note : '',
      ...(typeof j.platform === 'string' ? { platform: j.platform } : {}),
      ...(typeof j.window === 'string' ? { window: j.window } : {}),
    };
  } catch {
    return { runs: [], queue: [], diag: [], note: '' };
  }
}
export const evidenceOf = (row: LedgerRow): Evidence => parseEvidence(row.evidence);

const clip = (s: string): string => redactPane(String(s ?? '')).replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * Records one sighting (deduped by signature). `at` is the timestamp of the failing row itself, so `last_seen` is real time of the
 * failure, not detection time. A never-heal signature is stored as `ignored` (visible, never healed).
 */
export function recordSighting(db: Db, v: Verdict, ev: Partial<Evidence>, at: Date): LedgerRow {
  const iso = at.toISOString();
  const cur = db.prepare('SELECT * FROM heal_ledger WHERE signature = ?').get(v.signature) as LedgerRow | undefined;
  const add: Evidence = { runs: ev.runs ?? [], queue: ev.queue ?? [], diag: ev.diag ?? [], note: clip(ev.note ?? ''), ...(ev.platform ? { platform: ev.platform } : {}), ...(ev.window ? { window: ev.window } : {}) };
  if (!cur) {
    const info = db.prepare(
      'INSERT INTO heal_ledger (signature, first_seen, last_seen, count, state, evidence, verdict, note, requeue_safe) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)',
    ).run(v.signature, iso, iso, v.heal ? 'open' : 'ignored', JSON.stringify(add), v.heal ? 'heal' : 'never', v.heal ? null : v.reason, v.requeueSafe ? 1 : 0);
    return db.prepare('SELECT * FROM heal_ledger WHERE id = ?').get(Number(info.lastInsertRowid)) as LedgerRow;
  }
  const old = parseEvidence(cur.evidence);
  const merged: Evidence = {
    runs: mergeList(old.runs, add.runs), queue: mergeList(old.queue, add.queue), diag: mergeList(old.diag, add.diag),
    note: add.note || old.note, platform: add.platform ?? old.platform, window: add.window ?? old.window,
  };
  const last = Date.parse(cur.last_seen);
  const lastSeen = Number.isFinite(last) && last > at.getTime() ? cur.last_seen : iso;
  let state = cur.state;
  // A landed fix that recurs after its watch window, or an old give-up, may be healed again (cooldown and cap still apply).
  if (cur.verdict === 'heal') {
    if (state === 'landed') {
      const att = cur.last_heal_id ? (db.prepare('SELECT watch_until FROM heal_attempts WHERE id = ?').get(cur.last_heal_id) as { watch_until: string | null } | undefined) : undefined;
      const until = Date.parse(att?.watch_until ?? '');
      if (!Number.isFinite(until) || at.getTime() > until) state = 'open';
    } else if (state === 'gave_up' || state === 'rolled_back') {
      if (at.getTime() - Date.parse(cur.last_seen) > REOPEN_AFTER_DAYS * 86_400_000) state = 'open';
    }
  }
  db.prepare('UPDATE heal_ledger SET last_seen = ?, count = count + 1, evidence = ?, state = ?, requeue_safe = ? WHERE id = ?')
    .run(lastSeen, JSON.stringify(merged), state, v.requeueSafe ? 1 : cur.requeue_safe, cur.id);
  return db.prepare('SELECT * FROM heal_ledger WHERE id = ?').get(cur.id) as LedgerRow;
}

export const getLedger = (db: Db, id: number): LedgerRow | undefined => db.prepare('SELECT * FROM heal_ledger WHERE id = ?').get(id) as LedgerRow | undefined;
export const getLedgerBySignature = (db: Db, sig: string): LedgerRow | undefined => db.prepare('SELECT * FROM heal_ledger WHERE signature = ?').get(sig) as LedgerRow | undefined;
export const listLedger = (db: Db): LedgerRow[] => db.prepare('SELECT * FROM heal_ledger ORDER BY last_seen DESC, id DESC').all() as LedgerRow[];
export const getAttempt = (db: Db, id: number): AttemptRow | undefined => db.prepare('SELECT * FROM heal_attempts WHERE id = ?').get(id) as AttemptRow | undefined;
export const listAttempts = (db: Db, ledgerId?: number): AttemptRow[] =>
  (ledgerId === undefined
    ? db.prepare('SELECT * FROM heal_attempts ORDER BY id DESC LIMIT 50').all()
    : db.prepare('SELECT * FROM heal_attempts WHERE ledger_id = ? ORDER BY id DESC').all(ledgerId)) as AttemptRow[];

export function setLedgerState(db: Db, id: number, state: LedgerState, note?: string): void {
  db.prepare('UPDATE heal_ledger SET state = ?, note = COALESCE(?, note) WHERE id = ?').run(state, note ?? null, id);
}

/** Owner `ignore`: a signature that does not exist yet is created ignored, so it never heals. */
export function ignoreSignature(db: Db, signature: string, at: Date): void {
  const cur = getLedgerBySignature(db, signature);
  if (cur) { setLedgerState(db, cur.id, 'ignored', 'ignored by owner'); return; }
  const iso = at.toISOString();
  db.prepare("INSERT INTO heal_ledger (signature, first_seen, last_seen, count, state, evidence, verdict, note) VALUES (?, ?, ?, 0, 'ignored', '{}', 'heal', 'ignored by owner')").run(signature, iso, iso);
}

export function startAttempt(db: Db, ledgerId: number, a: { mode: string; branch: string; worktree: string; baseHead: string; at: Date }): number {
  const info = db.prepare('INSERT INTO heal_attempts (ledger_id, started_at, mode, branch, worktree, base_head) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ledgerId, a.at.toISOString(), a.mode, a.branch, a.worktree, a.baseHead);
  const id = Number(info.lastInsertRowid);
  db.prepare("UPDATE heal_ledger SET state = 'healing', last_heal_id = ? WHERE id = ?").run(id, ledgerId);
  return id;
}

type Patch = Partial<Pick<AttemptRow, 'ended_at' | 'head' | 'report' | 'outcome' | 'note' | 'files' | 'prev_head' | 'landed_head' | 'restart_state' | 'restart_targets' | 'restart_at' | 'watch_until' | 'requeued' | 'live'>>;
const PATCH_COLS = new Set(['ended_at', 'head', 'report', 'outcome', 'note', 'files', 'prev_head', 'landed_head', 'restart_state', 'restart_targets', 'restart_at', 'watch_until', 'requeued', 'live']);
export function updateAttempt(db: Db, id: number, p: Patch): void {
  const keys = Object.keys(p).filter((k) => PATCH_COLS.has(k));
  if (keys.length === 0) return;
  const vals = keys.map((k) => { const v = (p as Record<string, unknown>)[k]; return typeof v === 'string' ? v.slice(0, 4000) : v; });
  db.prepare(`UPDATE heal_attempts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(vals as never[]), id);
}

// Ledger note that lets ONE more round start at once after a failed live check (no cooldown).
export const LIVE_RETRY_NOTE = 'retry after live check failed';

export interface Limits { maxPerDay: number; cooldownHours: number }

/** Attempts started in the last 24 hours (all signatures). */
export function attemptsLast24h(db: Db, now: Date): number {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  return (db.prepare('SELECT COUNT(*) AS n FROM heal_attempts WHERE started_at > ?').get(since) as { n: number }).n;
}

/** True when this ledger row's last attempt started inside the cooldown. */
export function inCooldown(db: Db, ledgerId: number, now: Date, hours: number): boolean {
  const r = db.prepare('SELECT started_at FROM heal_attempts WHERE ledger_id = ? ORDER BY id DESC LIMIT 1').get(ledgerId) as { started_at: string } | undefined;
  if (!r) return false;
  return now.getTime() - Date.parse(r.started_at) < hours * 3_600_000;
}

/** Releases rows stuck in `healing` (the daemon died mid-heal). Returns the ids released. */
export function releaseStaleHealing(db: Db, now: Date, staleMs: number = HEALING_STALE_MS): number[] {
  const out: number[] = [];
  for (const r of db.prepare("SELECT l.id, l.last_heal_id, a.started_at FROM heal_ledger l LEFT JOIN heal_attempts a ON a.id = l.last_heal_id WHERE l.state = 'healing'").all() as Array<{ id: number; last_heal_id: number | null; started_at: string | null }>) {
    const t = Date.parse(r.started_at ?? '');
    if (Number.isFinite(t) && now.getTime() - t < staleMs) continue;
    db.prepare("UPDATE heal_ledger SET state = 'gave_up', note = 'heal did not finish (daemon stopped or timed out)' WHERE id = ?").run(r.id);
    if (r.last_heal_id) updateAttempt(db, r.last_heal_id, { outcome: 'error', ended_at: now.toISOString(), note: 'stale: no result' });
    out.push(r.id);
  }
  return out;
}

/** The next signature to heal, or null: open + qualifying, outside its cooldown, under the daily cap, nothing else healing. */
export function nextEligible(db: Db, now: Date, lim: Limits): LedgerRow | null {
  releaseStaleHealing(db, now);
  const busy = db.prepare("SELECT 1 FROM heal_ledger WHERE state = 'healing' LIMIT 1").get();
  if (busy) return null;
  if (attemptsLast24h(db, now) >= lim.maxPerDay) return null;
  const rows = db.prepare("SELECT * FROM heal_ledger WHERE state = 'open' AND verdict = 'heal' ORDER BY count DESC, first_seen ASC").all() as LedgerRow[];
  for (const r of rows) if (r.note === LIVE_RETRY_NOTE || !inCooldown(db, r.id, now, lim.cooldownHours)) return r;
  return null;
}

/** The single-flight lock of every heal action (fixer run, landing, restart, rollback). null when another process holds it. */
export function takeHealLock(root: string, owner: string, ttlMs: number = 3 * 3600_000): LockHandle | null {
  return acquireLock(path.join(root, '.jobber'), 'heal', owner, undefined, { ttlMs });
}
