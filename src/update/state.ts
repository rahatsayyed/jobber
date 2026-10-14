import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Outcome = 'updated' | 'skipped' | 'noop' | 'dry_run' | 'rolled_back' | 'rollback_failed' | 'error';
export interface UpdateResultRecord {
  at: string; outcome: Outcome; from: string; to: string | null; reason: string | null; step: string | null;
}
export interface UpdateState {
  version: 1;
  last_good_commit: string | null;
  next_run_at: string | null;
  in_progress: { from: string; to: string; started_at: string } | null;
  last_result: UpdateResultRecord | null;
  history: UpdateResultRecord[];
}

export const STATE_PATH = '.update/state.json';
const HISTORY_CAP = 20;

export interface StateFs {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, text: string, mode: number): void;
  mkdir(path: string, mode: number): void;
  rename(from: string, to: string): void;
}

export const nodeStateFs: StateFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, text, mode) => writeFileSync(p, text, { mode }),
  mkdir: (p, mode) => { mkdirSync(p, { recursive: true, mode }); },
  rename: (a, b) => renameSync(a, b),
};

export function emptyState(): UpdateState {
  return { version: 1, last_good_commit: null, next_run_at: null, in_progress: null, last_result: null, history: [] };
}

function isStr(v: unknown): v is string { return typeof v === 'string'; }
function strOrNull(v: unknown): string | null { return isStr(v) ? v : null; }

function cleanRecord(v: unknown): UpdateResultRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isStr(r.at) || !isStr(r.outcome) || !isStr(r.from)) return null;
  return {
    at: r.at, outcome: r.outcome as Outcome, from: r.from,
    to: strOrNull(r.to), reason: strOrNull(r.reason), step: strOrNull(r.step),
  };
}

export function readStateChecked(fs: StateFs, root: string): { state: UpdateState; corrupt: boolean } {
  const path = join(root, STATE_PATH);
  if (!fs.exists(path)) return { state: emptyState(), corrupt: false };
  try {
    const raw = JSON.parse(fs.read(path)) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null || raw.version !== 1) throw new Error('bad shape');
    const ip = raw.in_progress as Record<string, unknown> | null | undefined;
    const inProgress = ip && isStr(ip.from) && isStr(ip.to) && isStr(ip.started_at)
      ? { from: ip.from, to: ip.to, started_at: ip.started_at } : null;
    const history = Array.isArray(raw.history)
      ? raw.history.map(cleanRecord).filter((x): x is UpdateResultRecord => x !== null).slice(-HISTORY_CAP) : [];
    return {
      state: {
        version: 1, last_good_commit: strOrNull(raw.last_good_commit), next_run_at: strOrNull(raw.next_run_at),
        in_progress: inProgress, last_result: cleanRecord(raw.last_result), history,
      },
      corrupt: false,
    };
  } catch {
    return { state: emptyState(), corrupt: true };
  }
}

export function readState(fs: StateFs, root: string): UpdateState {
  return readStateChecked(fs, root).state;
}

export function writeState(fs: StateFs, root: string, s: UpdateState): void {
  const path = join(root, STATE_PATH);
  fs.mkdir(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  fs.write(tmp, JSON.stringify(s, null, 2) + '\n', 0o600);
  fs.rename(tmp, path);
}

export function recordResult(s: UpdateState, r: UpdateResultRecord, lastGood?: string): UpdateState {
  return {
    ...s,
    last_good_commit: r.outcome === 'updated' && lastGood !== undefined ? lastGood : s.last_good_commit,
    last_result: r,
    history: [...s.history, r].slice(-HISTORY_CAP),
  };
}
