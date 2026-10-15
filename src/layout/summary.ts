// Read-only summary of layout memory for the owner CLI, doctor and status (plan 8B).
// Vocabulary ids, counts and dates only. It never quarantines, writes or deletes anything.
import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { LayoutConfig } from './config.js';
import { parseLayoutText } from './store.js';
import type { LayoutFile, Platform } from './types.js';
import { haltReason } from '../outreach/limits.js';

export interface LayoutSummary {
  platform: Platform; present: boolean; valid: boolean; updated_at: string | null;
  age_days: number | null;
  kinds: Array<{
    kind: string; state: string; variants: number; hit_rate: number | null;
    drift_streak: number; drift_total: number; verified_days_ago: number | null;
  }>;
  halted_for_layout: boolean; enforce: 'off' | 'warn' | 'enforce';
  // Extras beyond the brief's shape: why a present file is invalid, and its size.
  why?: string; bytes?: number;
}

const DAY_MS = 86_400_000;
export const LAYOUT_HALT_PREFIX = 'layout_drift:';

export function layoutFilePath(cfg: LayoutConfig, platform: Platform): string {
  return path.join(cfg.dir, `${platform}.json`);
}

function readNode(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// The parsed file, or null when absent/invalid (the summary carries the reason).
export function readLayoutFile(
  platform: Platform, cfg: LayoutConfig, readText: (p: string) => string | null = readNode,
): { present: boolean; data: LayoutFile | null; why?: string; bytes?: number } {
  const text = readText(layoutFilePath(cfg, platform));
  if (text === null) return { present: false, data: null };
  const bytes = Buffer.byteLength(text);
  const r = parseLayoutText(text, platform, cfg.maxBytes);
  return r.ok ? { present: true, data: r.data, bytes } : { present: true, data: null, why: r.why, bytes };
}

export function layoutHaltReason(db: BetterSqlite3.Database | undefined | null, platform: Platform): string | null {
  if (!db) return null;
  try { return haltReason(db, platform); } catch { return null; }
}

/** Active reason on the platform's own halt row only (no fallback to the global `all` halt). */
export function ownHaltReason(db: BetterSqlite3.Database | undefined | null, platform: Platform): string | null {
  if (!db) return null;
  try {
    const row = db.prepare('SELECT reason FROM halt_flags WHERE platform = ? AND cleared_at IS NULL')
      .get(platform) as { reason: string } | undefined;
    return row ? row.reason : null;
  } catch { return null; }
}

const daysBetween = (from: string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / DAY_MS));

export function summarize(
  platform: Platform, cfg: LayoutConfig, now: Date, db?: BetterSqlite3.Database,
  readText: (p: string) => string | null = readNode,
): LayoutSummary {
  const r = readLayoutFile(platform, cfg, readText);
  const reason = layoutHaltReason(db, platform);
  const base: LayoutSummary = {
    platform, present: r.present, valid: !r.present || r.data !== null, updated_at: null, age_days: null,
    kinds: [], halted_for_layout: reason !== null && reason.startsWith(LAYOUT_HALT_PREFIX), enforce: cfg.enforce,
  };
  if (r.why) base.why = r.why;
  if (r.bytes !== undefined) base.bytes = r.bytes;
  if (!r.data) return base;
  base.updated_at = r.data.updated_at;
  base.age_days = daysBetween(r.data.updated_at, now);
  for (const k of Object.keys(r.data.kinds).sort()) {
    const km = r.data.kinds[k];
    const seen = km.counters.match + km.counters.partial + km.counters.drift;
    let newest: string | null = null;
    for (const v of km.variants) if (v.last_verified && (newest === null || v.last_verified > newest)) newest = v.last_verified;
    base.kinds.push({
      kind: k, state: km.state, variants: km.variants.length,
      hit_rate: seen === 0 ? null : km.counters.match / seen,
      drift_streak: km.drift_streak, drift_total: km.counters.drift,
      verified_days_ago: newest === null ? null : daysBetween(newest, now),
    });
  }
  return base;
}

// Plain-text table, one line per kind. Ids and numbers only.
export function renderSummary(s: LayoutSummary): string {
  const head = `${s.platform}: enforce=${s.enforce}${s.halted_for_layout ? ' HALTED(layout_drift)' : ''}`;
  if (!s.present) return `${head}\n  no layout memory yet`;
  if (!s.valid) return `${head}\n  layout memory INVALID (${s.why ?? 'unknown'}), the runtime will quarantine it on next load`;
  const lines = [`${head} updated=${s.updated_at?.slice(0, 10) ?? 'never'} age=${s.age_days}d`];
  if (s.kinds.length === 0) lines.push('  no kinds learned yet');
  for (const k of s.kinds) {
    const hit = k.hit_rate === null ? 'n/a' : `${Math.round(k.hit_rate * 100)}%`;
    const ver = k.verified_days_ago === null ? 'never' : `${k.verified_days_ago}d ago`;
    lines.push(`  ${k.kind}: ${k.state} variants=${k.variants} hit=${hit} drift_streak=${k.drift_streak} drift_total=${k.drift_total} verified=${ver}`);
  }
  return lines.join('\n');
}
