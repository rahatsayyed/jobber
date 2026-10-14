import { join } from 'node:path';
import { nodeStateFs, type StateFs } from '../update/state.js';

export interface BackupState {
  version: 1;
  last_backup_at: string | null;
  last_backup_name: string | null;
  last_error: string | null;
  last_drill_at: string | null;
  next_run_at: string | null;
}

export const BACKUP_STATE_PATH = '.backups/state.json';

export function emptyBackupState(): BackupState {
  return { version: 1, last_backup_at: null, last_backup_name: null, last_error: null, last_drill_at: null, next_run_at: null };
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function readBackupState(fs: StateFs, root: string): BackupState {
  return readBackupStateChecked(fs, root).state;
}

export function readBackupStateChecked(fs: StateFs, root: string): { state: BackupState; corrupt: boolean } {
  const path = join(root, BACKUP_STATE_PATH);
  if (!fs.exists(path)) return { state: emptyBackupState(), corrupt: false };
  try {
    const raw = JSON.parse(fs.read(path)) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null || raw.version !== 1) throw new Error('bad shape');
    return { corrupt: false, state: {
      version: 1,
      last_backup_at: strOrNull(raw.last_backup_at),
      last_backup_name: strOrNull(raw.last_backup_name),
      last_error: strOrNull(raw.last_error),
      last_drill_at: strOrNull(raw.last_drill_at),
      next_run_at: strOrNull(raw.next_run_at),
    } };
  } catch {
    return { state: emptyBackupState(), corrupt: true };
  }
}

/** Atomic: temp file in the same mode-700 directory, then rename. */
export function writeBackupState(fs: StateFs, root: string, s: BackupState): void {
  const path = join(root, BACKUP_STATE_PATH);
  fs.mkdir(join(root, '.backups'), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  fs.write(tmp, JSON.stringify(s, null, 2) + '\n', 0o600);
  fs.rename(tmp, path);
}

export function recordBackupResult(
  s: BackupState,
  r: { ok: boolean; name: string | null; error: string | null; failed: { label: string; error: string }[] },
  at: Date,
): BackupState {
  if (!r.ok) return { ...s, last_error: r.error ?? 'backup failed' };
  const partial = r.failed.length > 0 ? `partial: ${r.failed.map((f) => f.label).join(', ')} failed` : null;
  return { ...s, last_backup_at: at.toISOString(), last_backup_name: r.name, last_error: partial };
}

export { nodeStateFs };
