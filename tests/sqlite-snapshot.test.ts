import { describe, it, expect, afterEach, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, statSync, existsSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotDb, checkSnapshot } from '../src/lib/sqliteSnapshot.js';

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), 'snap-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('snapshotDb', () => {
  it('copies a live WAL database consistently and with mode 600', async () => {
    const dir = tmp();
    const src = join(dir, 'src.sqlite');
    const live = new BetterSqlite3(src);
    live.pragma('journal_mode = WAL');
    live.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE u (id INTEGER)');
    live.prepare('INSERT INTO t (v) VALUES (?)').run('synthetic-a');
    live.prepare('INSERT INTO t (v) VALUES (?)').run('synthetic-b');
    const dest = join(dir, 'copy.sqlite');
    await snapshotDb(src, dest);
    live.close();
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    const check = checkSnapshot(dest);
    expect(check.ok).toBe(true);
    expect(check.integrity).toBe('ok');
    expect(check.tables).toEqual({ t: 2, u: 0 });
  });
  it('refuses to overwrite an existing destination and a missing source', async () => {
    const dir = tmp();
    await expect(snapshotDb(join(dir, 'nope.sqlite'), join(dir, 'x'))).rejects.toThrow();
    const src = join(dir, 's.sqlite'); new BetterSqlite3(src).close();
    await snapshotDb(src, join(dir, 'd.sqlite'));
    await expect(snapshotDb(src, join(dir, 'd.sqlite'))).rejects.toThrow(/exists/);
    expect(existsSync(join(dir, 'nope.sqlite'))).toBe(false);
  });
  it('a failed backup leaves no destination so a retry works', async () => {
    const dir = tmp();
    const src = join(dir, 's.sqlite');
    const s = new BetterSqlite3(src);
    s.exec('CREATE TABLE t (id INTEGER)');
    s.close();
    const dest = join(dir, 'd.sqlite');
    const spy = vi.spyOn(BetterSqlite3.prototype, 'backup').mockImplementationOnce(async (d: string) => {
      writeFileSync(d, 'partial');
      throw new Error('backup failed midway');
    });
    await expect(snapshotDb(src, dest)).rejects.toThrow(/midway/);
    spy.mockRestore();
    expect(existsSync(dest)).toBe(false);
    await snapshotDb(src, dest);
    expect(checkSnapshot(dest).ok).toBe(true);
  });
  it('keeps a pre-existing destination when refusing to overwrite', async () => {
    const dir = tmp();
    const src = join(dir, 's.sqlite'); new BetterSqlite3(src).close();
    const dest = join(dir, 'keep.sqlite');
    writeFileSync(dest, 'precious');
    await expect(snapshotDb(src, dest)).rejects.toThrow(/exists/);
    expect(readFileSync(dest, 'utf8')).toBe('precious');
  });
  it('checkSnapshot reports not ok for a non-database file', () => {
    const dir = tmp();
    const bad = join(dir, 'bad');
    writeFileSync(bad, 'not a database'.repeat(100));
    expect(checkSnapshot(bad).ok).toBe(false);
  });
});
