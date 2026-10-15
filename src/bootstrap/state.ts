// src/bootstrap/state.ts
// .jobber/bootstrap.json: informational record of the last bootstrap run. Item ids, outcomes,
// versions and timestamps only; never env values or paths. A failure here must never fail a run.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Outcome } from './exec.js';

export interface BootstrapState {
  version: 1;
  last_run_at: string;
  platform: string;
  items: Record<string, { outcome: Outcome; version?: string; at: string }>;
  declined: string[];
}

export const stateDir = (root: string): string => join(root, '.jobber');
export const statePath = (root: string): string => join(stateDir(root), 'bootstrap.json');

export function writeState(root: string, state: BootstrapState): void {
  const dir = stateDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `bootstrap.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, statePath(root));
}

/** Null for a missing file, corrupt JSON or an unknown version; never throws. */
export function readState(root: string): BootstrapState | null {
  try {
    const v = JSON.parse(readFileSync(statePath(root), 'utf8')) as Partial<BootstrapState> | null;
    if (!v || v.version !== 1 || typeof v.items !== 'object' || v.items === null || !Array.isArray(v.declined)) return null;
    return v as BootstrapState;
  } catch {
    return null;
  }
}

export function buildState(
  platform: string,
  results: { id: string; outcome: Outcome; version?: string }[],
  now: Date,
): BootstrapState {
  const at = now.toISOString();
  const items: BootstrapState['items'] = {};
  for (const r of results) items[r.id] = { outcome: r.outcome, ...(r.version ? { version: r.version } : {}), at };
  return {
    version: 1,
    last_run_at: at,
    platform,
    items,
    declined: results.filter((r) => r.outcome === 'skipped').map((r) => r.id),
  };
}
