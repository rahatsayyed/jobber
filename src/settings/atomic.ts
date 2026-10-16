// src/settings/atomic.ts
// Generic, fs-injected "write with backup" shared by the JSON file store and the .env store (plan 8H, Tasks 4 and 5).
// Order: etag recheck, full-copy backup (dir 0700, file 0600), temp file + rename, chmod, retention prune.
// A failed backup aborts before any change; a failed rename leaves the original and removes the temp file.
// Error messages never contain file content.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { EnvFs } from '../setup/envWriter.js';

export type StatKind = 'file' | 'dir' | 'symlink' | 'other';
export interface StatLite {
  kind: StatKind;
  mode: number;
}

/** EnvFs (src/setup/envWriter.ts) plus what a backup store needs. */
export interface AtomicFs extends EnvFs {
  remove(p: string): void;
  /** Recursive and idempotent; created directories get this mode. */
  mkdir(p: string, mode: number): void;
  /** lstat semantics (does not follow a symlink); null when the path does not exist. */
  lstat(p: string): StatLite | null;
  /** Entry names (not paths) of a directory; [] when it does not exist. */
  list(dir: string): string[];
  /** Resolve symlinks of an existing path; throws when it does not exist. */
  realpath(p: string): string;
}

export const nodeAtomicFs: AtomicFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, data, mode) => {
    writeFileSync(p, data, { mode });
    chmodSync(p, mode);
  },
  rename: (from, to) => renameSync(from, to),
  chmod: (p, mode) => chmodSync(p, mode),
  remove: (p) => rmSync(p, { force: true }),
  mkdir: (p, mode) => {
    mkdirSync(p, { recursive: true, mode });
  },
  lstat: (p) => {
    try {
      const s = lstatSync(p);
      const kind: StatKind = s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other';
      return { kind, mode: s.mode & 0o777 };
    } catch {
      return null;
    }
  },
  realpath: (p) => realpathSync(p),
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

export class SettingsError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SettingsError';
  }
}

/** sha256 of the text, first 32 hex characters. */
export function etagOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

export interface WriteWithBackupOpts {
  fs: AtomicFs;
  path: string;
  text: string;
  /** etag of the text the caller based the change on ('' text for a file that does not exist yet). */
  expectEtag: string;
  /** Directory that receives this target's backups. */
  backupDir: string;
  /** Extension of backup file names, with the dot (".json", ".env"). */
  backupExt: string;
  keep: number;
  now: () => Date;
  /** Mode of the written file (default 0600). */
  mode?: number;
}

export interface WriteWithBackupResult {
  /** File name of the backup inside backupDir; '' when there was nothing to back up or nothing changed. */
  backupId: string;
  newEtag: string;
}

function stampOf(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export function writeWithBackup(o: WriteWithBackupOpts): WriteWithBackupResult {
  const { fs } = o;
  const mode = o.mode ?? 0o600;
  const existed = fs.exists(o.path);
  const current = existed ? fs.read(o.path) : null;
  const currentEtag = etagOf(current ?? '');
  if (currentEtag !== o.expectEtag) throw new SettingsError('stale_etag', 'the file changed since it was read');
  const newEtag = etagOf(o.text);
  if (current !== null && current === o.text) return { backupId: '', newEtag };

  let backupId = '';
  if (current !== null) {
    const base = `${stampOf(o.now())}-${currentEtag.slice(0, 8)}`;
    let name = `${base}${o.backupExt}`;
    try {
      fs.mkdir(o.backupDir, 0o700);
      fs.chmod(o.backupDir, 0o700);
      for (let n = 1; fs.exists(`${o.backupDir}/${name}`); n++) name = `${base}-${n}${o.backupExt}`;
      fs.write(`${o.backupDir}/${name}`, current, 0o600);
      fs.chmod(`${o.backupDir}/${name}`, 0o600);
    } catch {
      try {
        fs.remove(`${o.backupDir}/${name}`);
      } catch {
        /* best effort */
      }
      throw new SettingsError('backup_failed', 'could not write the backup; nothing was changed');
    }
    backupId = name;
  }

  const tmp = `${o.path}.tmp-${process.pid}`;
  try {
    fs.write(tmp, o.text, mode);
    fs.chmod(tmp, mode);
    fs.rename(tmp, o.path);
  } catch {
    try {
      fs.remove(tmp);
    } catch {
      /* best effort */
    }
    throw new SettingsError('write_failed', 'could not write the file; the original is unchanged');
  }
  try {
    fs.chmod(o.path, mode);
  } catch {
    /* the rename already succeeded */
  }
  pruneBackups(fs, o.backupDir, o.backupExt, o.keep);
  return { backupId, newEtag };
}

/** Keep the newest `keep` backups (names start with a UTC stamp, so a plain sort is chronological). */
export function pruneBackups(fs: AtomicFs, dir: string, ext: string, keep: number): void {
  const n = Number.isInteger(keep) && keep >= 1 ? keep : 10;
  const names = fs
    .list(dir)
    .filter((f) => f.endsWith(ext))
    .sort();
  for (const old of names.slice(0, Math.max(0, names.length - n))) {
    try {
      fs.remove(`${dir}/${old}`);
    } catch {
      /* best effort */
    }
  }
}
