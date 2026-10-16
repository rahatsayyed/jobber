// Persisted host blocks, host cooldown and the bot_wall halt (plan 8G-2 task 20). A block is never solved
// or waited out. Two blocks on one host within 7 days start a cooldown of APPLY_HOST_COOLDOWN_DAYS days.
// A streak of three bot_wall blocks (the newest three block events overall) spread over at least two run
// ids sets the `apply` halt; only the owner clears it (jobber:control clear-halt apply).
import type BetterSqlite3 from 'better-sqlite3';
import { haltPlatform, haltReason } from '../outreach/limits.js';

type Db = BetterSqlite3.Database;

export const BLOCK_KINDS = ['captcha', 'mfa', 'phone_verification', 'bot_wall', 'login_required', 'consent_required', 'blocked'] as const;
export type HostBlockKind = (typeof BLOCK_KINDS)[number];
export const COOLDOWN_BLOCKS = 2;
export const COOLDOWN_WINDOW_DAYS = 7;
export const BOT_WALL_STREAK = 3;
export const BOT_WALL_RUNS = 2;
const DAY_MS = 86_400_000;
const DEDUPE_MS = 60_000;

export function cooldownDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPLY_HOST_COOLDOWN_DAYS;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return 7;
  return Math.min(90, Math.max(1, Number(raw.trim())));
}

export const asBlockKind = (k: string): HostBlockKind => ((BLOCK_KINDS as readonly string[]).includes(k) ? (k as HostBlockKind) : 'blocked');

export interface BlockRecord { cooldown: boolean; halted: boolean; recorded: boolean }

interface Row { kind: string; at: string; run_id: string | null }

/** Records one block. The same host, kind and run within a minute is one event (the tool and its escalation both report it). */
export function recordHostBlock(db: Db, host: string, kind: string, at: Date, runId: string | null, env: NodeJS.ProcessEnv = process.env): BlockRecord {
  const h = String(host ?? '').toLowerCase().slice(0, 253);
  if (!h) return { cooldown: false, halted: false, recorded: false };
  const k = asBlockKind(kind);
  const last = db.prepare('SELECT at FROM apply_host_blocks WHERE host = ? AND kind = ? AND run_id IS ? ORDER BY rowid DESC LIMIT 1')
    .get(h, k, runId) as { at: string } | undefined;
  let recorded = false;
  if (!last || at.getTime() - Date.parse(last.at) > DEDUPE_MS) {
    db.prepare('INSERT INTO apply_host_blocks (host, kind, at, run_id) VALUES (?,?,?,?)').run(h, k, at.toISOString(), runId);
    recorded = true;
  }
  const halted = recorded && k === 'bot_wall' ? maybeHaltBotWall(db, at) : false;
  return { cooldown: hostCooledDown(db, h, env, at), halted, recorded };
}

/** Active when two consecutive blocks lie within 7 days of each other and the newer one is under `cooldownDays` old. */
export function hostCooledDown(db: Db, host: string, env: NodeJS.ProcessEnv, now: Date): boolean {
  const rows = db.prepare('SELECT at FROM apply_host_blocks WHERE host = ? ORDER BY at DESC, rowid DESC LIMIT 50').all(String(host).toLowerCase()) as Array<{ at: string }>;
  const span = cooldownDays(env) * DAY_MS;
  for (let i = 0; i + COOLDOWN_BLOCKS - 1 < rows.length; i++) {
    const newer = Date.parse(rows[i].at);
    const older = Date.parse(rows[i + COOLDOWN_BLOCKS - 1].at);
    if (Number.isNaN(newer) || Number.isNaN(older)) continue;
    if (newer - older <= COOLDOWN_WINDOW_DAYS * DAY_MS && now.getTime() < newer + span) return true;
  }
  return false;
}

/** Hosts currently cooling down (for apply_limits). */
export function cooledHosts(db: Db, env: NodeJS.ProcessEnv, now: Date): string[] {
  const hs = db.prepare('SELECT DISTINCT host FROM apply_host_blocks').all() as Array<{ host: string }>;
  return hs.map((r) => r.host).filter((h) => hostCooledDown(db, h, env, now)).sort();
}

export const BOT_WALL_HALT_REASON = 'bot_wall streak: 3 blocks across 2 runs';

/** Newest three block events all bot_wall and at least two distinct run ids: halt `apply` (an existing halt is kept). */
export function maybeHaltBotWall(db: Db, at: Date): boolean {
  const rows = db.prepare('SELECT kind, at, run_id FROM apply_host_blocks ORDER BY rowid DESC LIMIT ?').all(BOT_WALL_STREAK) as Row[];
  if (rows.length < BOT_WALL_STREAK || rows.some((r) => r.kind !== 'bot_wall')) return false;
  if (new Set(rows.map((r) => r.run_id ?? 'norun')).size < BOT_WALL_RUNS) return false;
  if (haltReason(db, 'apply') !== null) return false;
  haltPlatform(db, 'apply', BOT_WALL_HALT_REASON, at);
  return true;
}
