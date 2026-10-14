import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRestore, drill, MAX_EXTRACTED_BYTES, nodeRestoreFs, planRestore, safeText, verifyArchive, type RestoreDeps, type RestoreFs,
} from '../src/backup/restore.js';
import { emptyBackupState, type BackupState } from '../src/backup/state.js';
import { checkSnapshot } from '../src/lib/sqliteSnapshot.js';
import type { LockPort } from '../src/update/lockAdapter.js';

const NOW = new Date('2026-10-15T03:15:00Z');
const NAME = 'jobber-backup-20261015T031500Z.tar.gz.age';
let work: string;
let root: string;
let staged: string;
let archive: string;
let identity: string;

const sha = (p: string): string => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function makeDb(p: string, tables: Record<string, number>): void {
  const db = new BetterSqlite3(p);
  for (const [t, n] of Object.entries(tables)) {
    db.exec(`CREATE TABLE ${t} (id INTEGER)`);
    for (let i = 0; i < n; i++) db.prepare(`INSERT INTO ${t} VALUES (?)`).run(i);
  }
  db.close();
}

/** Builds the staged archive content: manifest.json plus files. */
function stage(extra: Record<string, string> = {}, tables: Record<string, number> = { jobs: 2 }): void {
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(path.join(staged, 'user-data'), { recursive: true });
  fs.mkdirSync(path.join(staged, 'secrets'), { recursive: true });
  makeDb(path.join(staged, 'data.sqlite'), tables);
  fs.writeFileSync(path.join(staged, 'user-data', 'resume.json'), '{"name":"new"}');
  fs.writeFileSync(path.join(staged, '.env'), 'NEW=1');
  fs.writeFileSync(path.join(staged, 'secrets', 's.json'), 'new-secret');
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(staged, k), v);
  const paths = ['data.sqlite', 'user-data/resume.json', '.env', 'secrets/s.json'];
  const manifest = {
    version: 1,
    created_at: NOW.toISOString(),
    commit: 'a'.repeat(40),
    includes_secrets: true,
    files: paths.map((p) => ({ path: p, sha256: sha(path.join(staged, p)), bytes: fs.statSync(path.join(staged, p)).size })),
    db: { path: 'data.sqlite', tables },
  };
  fs.writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify(manifest));
}

function lockPort(held = false): LockPort & { acquire: ReturnType<typeof vi.fn>; released: number } {
  const o = { released: 0 } as { released: number };
  const acquire = vi.fn(async () => (held ? null : { release: async () => { o.released++; } }));
  return { acquire, get released() { return o.released; } } as never;
}

function deps(over: Partial<RestoreDeps> = {}, fsOver: Partial<RestoreFs> = {}) {
  let st: BackupState = emptyBackupState();
  const d: RestoreDeps & { saved: () => BackupState } = {
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    fs: { ...nodeRestoreFs, ...fsOver },
    checkSnapshot,
    unpack: vi.fn(async ({ outDir }) => { fs.cpSync(staged, outDir, { recursive: true, verbatimSymlinks: true }); }),
    lock: lockPort(),
    state: { load: () => st, save: (s) => { st = s; } },
    now: () => NOW,
    saved: () => st,
    ...over,
  };
  return d;
}

function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rec = (d: string): void => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[path.relative(dir, p)] = `link:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { out[`${path.relative(dir, p)}/`] = 'dir'; rec(p); }
      else out[path.relative(dir, p)] = `${(st.mode & 0o777).toString(8)}:${fs.readFileSync(p).toString('base64')}`;
    }
  };
  rec(dir);
  return out;
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-restore-test-'));
  root = path.join(work, 'project');
  staged = path.join(work, 'staged');
  fs.mkdirSync(root);
  archive = path.join(work, NAME);
  identity = path.join(work, 'key.txt');
  fs.writeFileSync(archive, 'x');
  fs.writeFileSync(identity, 'AGE-SECRET-KEY-FAKE');
  stage();
  // live project
  makeDb(path.join(root, 'data.sqlite'), { jobs: 1 });
  fs.writeFileSync(path.join(root, 'data.sqlite-wal'), 'stale-wal');
  fs.writeFileSync(path.join(root, 'data.sqlite-shm'), 'stale-shm');
  fs.mkdirSync(path.join(root, 'user-data'));
  fs.writeFileSync(path.join(root, 'user-data', 'resume.json'), '{"name":"old"}');
  fs.writeFileSync(path.join(root, '.env'), 'OLD=1');
});
afterEach(() => { fs.rmSync(work, { recursive: true, force: true }); });

describe('verifyArchive', () => {
  it('accepts a good archive and removes its temp dir', async () => {
    const d = deps();
    const r = await verifyArchive(d, { archivePath: archive, identityPath: identity });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.integrity).toBe('ok');
    expect(r.tables).toEqual({ jobs: 2 });
    const outDir = (d.unpack as ReturnType<typeof vi.fn>).mock.calls[0][0].outDir as string;
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('reports a flipped byte', async () => {
    fs.writeFileSync(path.join(staged, 'user-data', 'resume.json'), '{"name":"NEW"}');
    const r = await verifyArchive(deps(), { archivePath: archive, identityPath: identity });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('checksum mismatch: user-data/resume.json');
  });

  it('reports a missing manifest', async () => {
    fs.rmSync(path.join(staged, 'manifest.json'));
    const r = await verifyArchive(deps(), { archivePath: archive, identityPath: identity });
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('manifest.json is missing');
  });

  it('reports extra files and a table count mismatch', async () => {
    fs.writeFileSync(path.join(staged, 'extra.txt'), 'x');
    const m = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8'));
    m.db.tables = { jobs: 5 };
    fs.writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify(m));
    const r = await verifyArchive(deps(), { archivePath: archive, identityPath: identity });
    expect(r.problems.join('\n')).toContain('file not in manifest: extra.txt');
    expect(r.problems.join('\n')).toContain('table count differs from manifest: jobs');
  });

  it('rejects a symlink member and a bad identity', async () => {
    fs.symlinkSync('/etc/hosts', path.join(staged, 'link'));
    const r = await verifyArchive(deps(), { archivePath: archive, identityPath: identity });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('symlink');
    const r2 = await verifyArchive(deps(), { archivePath: archive, identityPath: path.join(work, 'missing') });
    expect(r2.problems).toContain('identity is not a regular file');
  });

  it('ignores AppleDouble entries and tolerates a failing unpack', async () => {
    fs.writeFileSync(path.join(staged, '._data.sqlite'), 'meta');
    const r = await verifyArchive(deps(), { archivePath: archive, identityPath: identity });
    expect(r.ok).toBe(true);
    expect(r.ignored).toEqual(['._data.sqlite']);
    const bad = deps({ unpack: vi.fn(async () => { throw new Error('boom secret'); }) });
    const r2 = await verifyArchive(bad, { archivePath: archive, identityPath: identity });
    expect(r2.ok).toBe(false);
    expect(JSON.stringify(r2)).not.toContain('boom');
  });
});

describe('verifyArchive hardening', () => {
  it('rejects a hardlink member', async () => {
    const d = deps({
      unpack: vi.fn(async ({ outDir }) => {
        fs.cpSync(staged, outDir, { recursive: true });
        fs.linkSync(path.join(outDir, '.env'), path.join(outDir, 'linked'));
      }),
    });
    const r = await verifyArchive(d, { archivePath: archive, identityPath: identity });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('hardlink');
  });

  it('rejects a special file member', async () => {
    const d = deps({
      unpack: vi.fn(async ({ outDir }) => {
        fs.cpSync(staged, outDir, { recursive: true });
        execFileSync('mkfifo', [path.join(outDir, 'pipe')]);
      }),
    });
    const r = await verifyArchive(d, { archivePath: archive, identityPath: identity });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('special file');
  });

  it('tolerates a ./ prefix on member names', async () => {
    const d = deps({}, { walk: (dir) => nodeRestoreFs.walk(dir).map((e) => ({ ...e, rel: `./${e.rel}` })) });
    const r = await verifyArchive(d, { archivePath: archive, identityPath: identity });
    expect(r.problems).toEqual([]);
  });

  it('flags an archive over the extracted size cap', async () => {
    const d = deps({}, { walk: (dir) => nodeRestoreFs.walk(dir).map((e) => ({ ...e, size: MAX_EXTRACTED_BYTES })) });
    const r = await verifyArchive(d, { archivePath: archive, identityPath: identity });
    expect(r.problems).toContain('extracted size exceeds the allowed maximum');
  });

  it('rejects escape sequences in the manifest and cleans printed text', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8'));
    m.commit = 'abc\u001b[2J';
    fs.writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify(m));
    const r = await verifyArchive(deps(), { archivePath: archive, identityPath: identity });
    expect(r.ok).toBe(false);
    expect(r.manifest).toBeNull();
    expect(safeText('a\u001b[31mb\nc')).toBe('a?[31mb?c');
    expect(safeText('x'.repeat(500)).length).toBeLessThan(210);
  });
});

describe('planRestore', () => {
  it('marks replace, create and skip-secret', () => {
    const m = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8'));
    fs.rmSync(path.join(root, 'user-data', 'resume.json'));
    const plan = planRestore(m, root, (p) => fs.existsSync(p), { withSecrets: false, stamp: 'S1' });
    const by = Object.fromEntries(plan.map((p) => [p.archivePath, p]));
    expect(by['data.sqlite'].action).toBe('replace');
    expect(by['data.sqlite'].moveAsideTo).toBe(`${path.resolve(root, 'data.sqlite')}.pre-restore-S1`);
    expect(by['user-data/resume.json'].action).toBe('create');
    expect(by['user-data/resume.json'].moveAsideTo).toBeNull();
    expect(by['.env'].action).toBe('skip-secret');
    expect(by['secrets/s.json'].action).toBe('skip-secret');
    const withS = planRestore(m, root, (p) => fs.existsSync(p), { withSecrets: true, stamp: 'S1' });
    expect(withS.find((p) => p.archivePath === '.env')?.action).toBe('replace');
  });

  it('refuses a target outside the root', () => {
    const m = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8'));
    m.files[0].path = '../evil';
    expect(() => planRestore(m, root, () => false, { withSecrets: false, stamp: 'S' })).toThrow();
  });
});

describe('applyRestore', () => {
  const args = () => ({ archivePath: archive, identityPath: identity, root, withSecrets: false, confirm: `RESTORE ${NAME}` });

  it('throws on a wrong confirm string before any move or lock', async () => {
    const d = deps();
    const before = snapshotTree(root);
    await expect(applyRestore(d, { ...args(), confirm: 'RESTORE nope' })).rejects.toThrow(/confirmation/);
    expect(d.lock.acquire).not.toHaveBeenCalled();
    expect(snapshotTree(root)).toEqual(before);
  });

  it('throws when the lock is held', async () => {
    const d = deps({ lock: lockPort(true) });
    const before = snapshotTree(root);
    await expect(applyRestore(d, args())).rejects.toThrow(/lock/);
    expect(d.unpack).not.toHaveBeenCalled();
    expect(snapshotTree(root)).toEqual(before);
  });

  it('refuses an unverified archive without moving anything', async () => {
    fs.writeFileSync(path.join(staged, 'user-data', 'resume.json'), 'tampered');
    const lock = lockPort();
    const before = snapshotTree(root);
    await expect(applyRestore(deps({ lock }), args())).rejects.toThrow(/verification/);
    expect(snapshotTree(root)).toEqual(before);
    expect(lock.released).toBe(1);
  });

  it('moves aside, restores with mode 600, skips secrets and releases the lock', async () => {
    const lock = lockPort();
    const r = await applyRestore(deps({ lock }), args());
    const stamp = '20261015T031500Z';
    for (const n of ['data.sqlite', 'data.sqlite-wal', 'data.sqlite-shm']) {
      expect(fs.existsSync(path.join(root, `${n}.pre-restore-${stamp}`))).toBe(true);
    }
    expect(fs.readFileSync(path.join(root, 'data.sqlite-wal.pre-restore-' + stamp), 'utf8')).toBe('stale-wal');
    expect(fs.existsSync(path.join(root, 'data.sqlite-wal'))).toBe(false);
    expect(fs.statSync(path.join(root, 'data.sqlite')).mode & 0o777).toBe(0o600);
    expect(checkSnapshot(path.join(root, 'data.sqlite')).tables).toEqual({ jobs: 2 });
    expect(fs.readFileSync(path.join(root, 'user-data', 'resume.json'), 'utf8')).toBe('{"name":"new"}');
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('OLD=1');
    expect(fs.existsSync(path.join(root, 'secrets'))).toBe(false);
    expect(r.restored.map((p) => path.relative(root, p)).sort()).toEqual(['data.sqlite', 'user-data/resume.json']);
    expect(lock.released).toBe(1);
  });

  it('restores secrets only with withSecrets', async () => {
    await applyRestore(deps(), { ...args(), withSecrets: true });
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('NEW=1');
    expect(fs.readFileSync(path.join(root, 'secrets', 's.json'), 'utf8')).toBe('new-secret');
    expect(fs.statSync(path.join(root, 'secrets', 's.json')).mode & 0o777).toBe(0o600);
  });

  it('rolls back to the initial state when a copy fails midway', async () => {
    const before = snapshotTree(root);
    let n = 0;
    const d = deps({}, {
      copy: (s, t) => {
        if (++n === 4) {
          fs.mkdirSync(path.dirname(t), { recursive: true });
          throw new Error('copy failed');
        }
        nodeRestoreFs.copy(s, t);
      },
    });
    await expect(applyRestore(d, { ...args(), withSecrets: true })).rejects.toThrow(/copy failed/);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('releases the lock and removes a 0700 temp dir after a midway failure', async () => {
    const lock = lockPort();
    let tmp = '';
    let mode = 0;
    const d = deps({ lock }, {
      mkdtemp: (pre) => {
        tmp = nodeRestoreFs.mkdtemp(pre);
        mode = fs.statSync(tmp).mode & 0o777;
        return tmp;
      },
      copy: () => { throw new Error('copy failed'); },
    });
    await expect(applyRestore(d, args())).rejects.toThrow(/copy failed/);
    expect(mode).toBe(0o700);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(lock.released).toBe(1);
  });

  it('names every target and move-aside path when the rollback fails', async () => {
    let n = 0;
    const d = deps({}, {
      copy: (s, t) => {
        if (++n === 2) throw new Error('copy failed');
        nodeRestoreFs.copy(s, t);
      },
      move: (src, dest) => {
        if (src.includes('.pre-restore-') && dest.endsWith(`${path.sep}data.sqlite`)) throw new Error('perm');
        nodeRestoreFs.move(src, dest);
      },
    });
    const err = await applyRestore(d, args()).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/rollback is incomplete/);
    expect(err?.message).toContain('data.sqlite.pre-restore-20261015T031500Z back to data.sqlite');
    expect(err?.message).not.toContain(root);
  });

  it('refuses a symlinked parent directory and a move-aside name collision before any move', async () => {
    const elsewhere = path.join(work, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'resume.json'), 'outside');
    fs.rmSync(path.join(root, 'user-data'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(root, 'user-data'));
    const before = snapshotTree(root);
    await expect(applyRestore(deps(), args())).rejects.toThrow(/unsafe directory/);
    expect(snapshotTree(root)).toEqual(before);
    expect(fs.readFileSync(path.join(elsewhere, 'resume.json'), 'utf8')).toBe('outside');
    fs.rmSync(path.join(root, 'user-data'));
    fs.mkdirSync(path.join(root, 'user-data'));
    fs.writeFileSync(path.join(root, 'user-data', 'resume.json'), 'old');
    fs.writeFileSync(path.join(root, 'data.sqlite.pre-restore-20261015T031500Z'), 'taken');
    const before2 = snapshotTree(root);
    await expect(applyRestore(deps(), args())).rejects.toThrow(/already exists/);
    expect(snapshotTree(root)).toEqual(before2);
  });

  it('rejects a manifest path with .. before any copy', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8'));
    m.files[1].path = '../outside.txt';
    fs.writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify(m));
    const before = snapshotTree(root);
    await expect(applyRestore(deps(), args())).rejects.toThrow();
    expect(snapshotTree(root)).toEqual(before);
    expect(fs.existsSync(path.join(work, 'outside.txt'))).toBe(false);
  });
});

describe('drill', () => {
  it('reports live tables missing in the backup and records last_drill_at', async () => {
    const live = path.join(work, 'live.sqlite');
    makeDb(live, { jobs: 3, extra_table: 1 });
    const d = deps();
    const r = await drill(d, { archivePath: archive, identityPath: identity, liveDbPath: live });
    expect(r.ok).toBe(true);
    expect(r.liveTableMissingInBackup).toEqual(['extra_table']);
    expect(d.saved().last_drill_at).toBe(NOW.toISOString());
  });

  it('does not record a drill for a failing archive', async () => {
    fs.rmSync(path.join(staged, 'manifest.json'));
    const live = path.join(work, 'live.sqlite');
    makeDb(live, { jobs: 3 });
    const d = deps();
    const r = await drill(d, { archivePath: archive, identityPath: identity, liveDbPath: live });
    expect(r.ok).toBe(false);
    expect(d.saved().last_drill_at).toBeNull();
  });
});
