// src/settings/backups.ts
// Lists and loads settings backups (plan 8H, Tasks 4 and 5). Layout (D8):
//   <backupDir>/env/<YYYYMMDDTHHMMSSZ>-<etag8>.env          id = name without ".env"
//   <backupDir>/files/<fileId>/<stamp>-<etag8>.json          id = file name (Task 4 naming)
// A backup id from a client is only ever VALIDATED against a pattern and then looked up by listing the directory;
// it is never joined into a path. Names carry a stamp and an etag prefix, never content.
import { join } from 'node:path';
import { type AtomicFs, SettingsError } from './atomic.js';
import { resolveEntry } from './fileRegistry.js';

export const ENV_BACKUP_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const FILE_BACKUP_ID_RE = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(?:-\d{3})?Z-[0-9a-f]{8}(?:-\d+)?\.json$/;
const ENV_EXT = '.env';

export type BackupTarget = 'env' | { file: string };

export interface BackupInfo {
  id: string;
  target: string; // 'env' or the file id
  /** ISO time parsed from the name ('' when it cannot be read) */
  at: string;
  etag8: string;
  bytes: number;
}

export interface BackupDeps {
  fs: AtomicFs;
  /** the settings backup root (contains env/ and files/) */
  backupDir: string;
}

function dirOf(deps: BackupDeps, target: BackupTarget): { dir: string; label: string; valid: (id: string) => boolean } {
  if (target === 'env') return { dir: join(deps.backupDir, 'env'), label: 'env', valid: (id) => ENV_BACKUP_ID_RE.test(id) };
  const e = resolveEntry(target.file);
  if (!e) throw new SettingsError('unknown_file', 'unknown settings file');
  return { dir: join(deps.backupDir, 'files', e.id), label: e.id, valid: (id) => FILE_BACKUP_ID_RE.test(id) };
}

function atOf(id: string): string {
  let m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z-/.exec(id);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
  m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)(?:-(\d{3}))?Z-/.exec(id);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7] ?? '000'}Z`;
  return '';
}

function etag8Of(id: string): string {
  const m = /-([0-9a-f]{8})(?:-\d+)?(?:\.json)?$/.exec(id);
  return m ? m[1] : '';
}

/** Newest first. Entries whose names do not match the generated shape are ignored. */
export function listBackups(deps: BackupDeps, target: BackupTarget): BackupInfo[] {
  const { dir, label, valid } = dirOf(deps, target);
  const out: BackupInfo[] = [];
  for (const name of deps.fs.list(dir)) {
    const id = target === 'env' ? (name.endsWith(ENV_EXT) ? name.slice(0, -ENV_EXT.length) : '') : name;
    if (!id || !valid(id)) continue;
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(deps.fs.read(`${dir}/${name}`), 'utf8');
    } catch {
      continue;
    }
    out.push({ id, target: label, at: atOf(id), etag8: etag8Of(id), bytes });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Text of one backup. The id is validated, then matched against the directory listing; never joined from client text. */
export function readBackup(deps: BackupDeps, target: BackupTarget, id: string): string {
  const { dir, valid } = dirOf(deps, target);
  if (typeof id !== 'string' || !valid(id)) throw new SettingsError('bad_backup_id', 'not a valid backup id');
  const fileName = target === 'env' ? `${id}${ENV_EXT}` : id;
  const found = deps.fs.list(dir).find((n) => n === fileName);
  if (found === undefined) throw new SettingsError('backup_not_found', 'no such backup');
  try {
    return deps.fs.read(`${dir}/${found}`);
  } catch {
    throw new SettingsError('backup_unreadable', 'the backup could not be read');
  }
}
