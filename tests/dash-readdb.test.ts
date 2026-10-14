// tests/dash-readdb.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openReadOnlyDb, clampLimit, parseCursor, likePattern, tableExists, DEFAULT_LIMIT, MAX_LIMIT, MAX_Q,
} from '../src/dash/readDb.js';

const dirs: string[] = [];
function mkDb(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-ro-'));
  dirs.push(d);
  const f = path.join(d, 'x.sqlite');
  const db = new Database(f);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a');");
  db.close();
  return f;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('openReadOnlyDb', () => {
  it('reads but rejects writes and DDL', () => {
    const db = openReadOnlyDb(mkDb());
    expect(db.prepare('SELECT v FROM t').get()).toEqual({ v: 'a' });
    expect(() => db.exec("INSERT INTO t (v) VALUES ('b')")).toThrow();
    expect(() => db.exec('CREATE TABLE u (a)')).toThrow();
    db.close();
  });
  it('throws on a missing file', () => {
    expect(() => openReadOnlyDb(path.join(os.tmpdir(), 'does-not-exist-dash.sqlite'))).toThrow();
  });
  it('tableExists', () => {
    const db = openReadOnlyDb(mkDb());
    expect(tableExists(db, 't')).toBe(true);
    expect(tableExists(db, 'nope')).toBe(false);
    db.close();
  });
});

describe('pagination helpers', () => {
  it('clampLimit', () => {
    expect(clampLimit('abc')).toBe(DEFAULT_LIMIT);
    expect(clampLimit(-5)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(1000)).toBe(MAX_LIMIT);
    expect(clampLimit('30')).toBe(30);
  });
  it('parseCursor', () => {
    expect(parseCursor('12')).toBe(12);
    expect(parseCursor('0')).toBeNull();
    expect(parseCursor('-3')).toBeNull();
    expect(parseCursor('1.5')).toBeNull();
    expect(parseCursor('abc')).toBeNull();
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor('99999999999999999999')).toBeNull();
  });
  it('likePattern escapes %, _ and backslash and bounds length', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
    expect(likePattern('  hi  ')).toBe('%hi%');
    expect(likePattern('x'.repeat(200))).toBe('%' + 'x'.repeat(MAX_Q) + '%');
  });
});

// R2: dashboard read modules must contain no write SQL.
describe('read-only grep (R2)', () => {
  const root = path.resolve(__dirname, '..', 'src', 'dash');
  const files = ['readDb.ts', 'clean.ts', 'runlog.ts', 'sessionsPanel.ts', 'configView.ts'].map((f) => path.join(root, f));
  const walk = (d: string): string[] =>
    fs.existsSync(d)
      ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
      : [];
  const targets = [...walk(path.join(root, 'queries')), ...files.filter((f) => fs.existsSync(f))];
  it('has no INSERT/UPDATE/DELETE/DROP/ALTER', () => {
    const re = /INSERT|UPDATE |DELETE|DROP |ALTER/;
    const hits = targets.filter((f) => re.test(fs.readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
