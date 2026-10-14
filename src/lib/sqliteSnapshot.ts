import BetterSqlite3 from 'better-sqlite3';
import { chmodSync, existsSync, rmSync } from 'node:fs';

export async function snapshotDb(srcPath: string, destPath: string): Promise<void> {
  if (!existsSync(srcPath)) throw new Error(`source database not found: ${srcPath}`);
  if (existsSync(destPath)) throw new Error(`destination exists: ${destPath}`);
  let db: BetterSqlite3.Database;
  try {
    db = new BetterSqlite3(srcPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    // readonly WAL open can fail with SQLITE_CANTOPEN; retry once with a normal connection
    if ((e as { code?: string }).code !== 'SQLITE_CANTOPEN') throw e;
    db = new BetterSqlite3(srcPath, { fileMustExist: true });
  }
  try {
    try {
      await db.backup(destPath);
      chmodSync(destPath, 0o600);
    } catch (e) {
      // dest did not exist when we started, so any file there is our partial copy
      try { rmSync(destPath, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  } finally {
    db.close();
  }
}

export interface SnapshotCheck { ok: boolean; integrity: string; tables: Record<string, number> }

export function checkSnapshot(path: string): SnapshotCheck {
  let db: BetterSqlite3.Database | undefined;
  try {
    db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
    const row = db.prepare('PRAGMA integrity_check').get() as Record<string, string> | undefined;
    const integrity = row ? String(Object.values(row)[0]) : 'no result';
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const tables: Record<string, number> = {};
    for (const { name } of names) {
      if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
      const c = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
      tables[name] = c.n;
    }
    return { ok: integrity === 'ok', integrity, tables };
  } catch (e) {
    return { ok: false, integrity: (e as Error).message, tables: {} };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
