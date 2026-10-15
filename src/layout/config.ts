// Layout memory settings from the environment. Invalid values fall back to the default, never throw.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from '../platform/envFile.js';

export interface LayoutConfig {
  enforce: 'off' | 'warn' | 'enforce';        // LAYOUT_ENFORCE, default warn
  promoteN: number;                           // LAYOUT_PROMOTE_N, default 3
  promoteRuns: number;                        // LAYOUT_PROMOTE_RUNS, default 2
  matchMin: number;                           // LAYOUT_MATCH_MIN, default 0.9
  partialMin: number;                         // LAYOUT_PARTIAL_MIN, default 0.6
  staleDays: number;                          // LAYOUT_STALE_DAYS, default 30
  driftEscalateN: number;                     // LAYOUT_DRIFT_ESCALATE_N, default 3
  driftHaltN: number;                         // LAYOUT_DRIFT_HALT_N, default 5
  driftWindowHours: number;                   // LAYOUT_DRIFT_WINDOW_HOURS, default 24
  maxBytes: number;                           // LAYOUT_MAX_BYTES, default 65536
  renderMaxChars: number;                     // LAYOUT_RENDER_MAX_CHARS, default 1200
  unloadedMaxChars: number;                   // LAYOUT_UNLOADED_MAX_CHARS, default 80
  exploreBudget: number;                      // LAYOUT_EXPLORE_BUDGET, default 6; parsed only, the operators' prompts state 6 (not enforced)
  dir: string;                                // LAYOUT_DIR, default <root>/.jobber/layout; must resolve inside the project
}

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The one LAYOUT_* merge: `base` (the process environment) wins; LAYOUT_* keys from parsed .env
 * variables fill the gaps. Every other .env key is ignored, so nothing else is ever read or copied.
 */
export function mergeLayoutEnv(base: NodeJS.ProcessEnv, fileVars: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [k, v] of Object.entries(fileVars)) {
    if (k.startsWith('LAYOUT_') && out[k] === undefined) out[k] = v;
  }
  return out;
}

/** Process env plus LAYOUT_* from `<root>/.env` when present. A missing or unreadable file is ignored. */
export function loadLayoutEnv(root: string = PROJECT_ROOT, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  try {
    const file = path.join(root, '.env');
    if (!fs.existsSync(file)) return { ...base };
    return mergeLayoutEnv(base, parseEnv(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...base };
  }
}

function int(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || !/^\d{1,9}$/.test(raw.trim())) return def;
  const n = Number(raw.trim());
  return n >= min && n <= max ? n : def;
}

function frac(raw: string | undefined, def: number): number {
  if (raw === undefined || !/^(0(\.\d+)?|1(\.0+)?)$/.test(raw.trim())) return def;
  return Number(raw.trim());
}

export function loadLayoutConfig(env: NodeJS.ProcessEnv = process.env, root: string = PROJECT_ROOT): LayoutConfig {
  const defDir = path.join(root, '.jobber', 'layout');
  let dir = defDir;
  const rawDir = env.LAYOUT_DIR?.trim();
  if (rawDir && !rawDir.includes('\0')) {
    const abs = path.resolve(root, rawDir);
    const rel = path.relative(root, abs);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) dir = abs;
  }
  const enforce = env.LAYOUT_ENFORCE?.trim();
  let matchMin = frac(env.LAYOUT_MATCH_MIN, 0.9);
  let partialMin = frac(env.LAYOUT_PARTIAL_MIN, 0.6);
  if (partialMin > matchMin) { matchMin = 0.9; partialMin = 0.6; }
  let driftEscalateN = int(env.LAYOUT_DRIFT_ESCALATE_N, 3, 1, 1000);
  let driftHaltN = int(env.LAYOUT_DRIFT_HALT_N, 5, 1, 1000);
  if (driftHaltN < driftEscalateN) { driftEscalateN = 3; driftHaltN = 5; }
  return {
    enforce: enforce === 'off' || enforce === 'warn' || enforce === 'enforce' ? enforce : 'warn',
    promoteN: int(env.LAYOUT_PROMOTE_N, 3, 1, 1000),
    promoteRuns: int(env.LAYOUT_PROMOTE_RUNS, 2, 1, 1000),
    matchMin,
    partialMin,
    staleDays: int(env.LAYOUT_STALE_DAYS, 30, 1, 3650),
    driftEscalateN,
    driftHaltN,
    driftWindowHours: int(env.LAYOUT_DRIFT_WINDOW_HOURS, 24, 1, 8760),
    maxBytes: int(env.LAYOUT_MAX_BYTES, 65536, 4096, 1048576),
    renderMaxChars: int(env.LAYOUT_RENDER_MAX_CHARS, 1200, 100, 20000),
    unloadedMaxChars: int(env.LAYOUT_UNLOADED_MAX_CHARS, 80, 1, 2000),
    exploreBudget: int(env.LAYOUT_EXPLORE_BUDGET, 6, 0, 100),
    dir,
  };
}
