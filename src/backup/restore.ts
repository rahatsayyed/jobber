import {
  chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  renameSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { Exec } from '../lib/exec.js';
import { pipeExec } from '../lib/exec.js';
import type { SnapshotCheck } from '../lib/sqliteSnapshot.js';
import type { LockPort } from '../update/lockAdapter.js';
import { parseManifest, verifyFiles, type Manifest } from './manifest.js';
import type { BackupState } from './state.js';

export type RestoreKind = 'file' | 'dir' | 'symlink' | 'other';
export interface WalkEntry { rel: string; kind: RestoreKind; nlink: number; size: number }

export const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;

export interface RestoreFs {
  mkdtemp(prefix: string): string;
  /** lstat based: a dangling symlink exists. */
  exists(p: string): boolean;
  kind(p: string): RestoreKind | null;
  list(dir: string): string[];
  /** Recursive lstat walk below `dir`; never follows symlinks. */
  walk(dir: string): WalkEntry[];
  hash(p: string): string;
  read(p: string): string;
  /** Exclusive copy: fails when `dest` exists. Creates parents with mode 700. */
  copy(src: string, dest: string): void;
  /** Rename; fails when `dest` exists. */
  move(src: string, dest: string): void;
  rmrf(p: string): void;
  mode(p: string, mode: number): void;
}

export interface RestoreDeps {
  exec: Exec;
  fs: RestoreFs;
  checkSnapshot: (p: string) => SnapshotCheck;
  unpack: (a: { archivePath: string; identityPath: string; outDir: string }) => Promise<void>;
  lock: LockPort;
  state: { load(): BackupState; save(s: BackupState): void };
  now: () => Date;
}

export interface VerifyReport {
  ok: boolean;
  manifest: Manifest | null;
  problems: string[];
  tables: Record<string, number>;
  integrity: string;
  ignored: string[];
}

const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, '?');
/** For printing archive-derived text: control characters replaced and length capped. */
export function safeText(s: unknown, max = 200): string {
  const t = clean(String(s));
  return t.length > max ? `${t.slice(0, max)}...` : t;
}
const isAppleDouble = (rel: string): boolean => basename(rel).startsWith('._');
const stripDot = (rel: string): string => rel.replace(/^(\.\/)+/, '');

async function verifyInto(
  deps: RestoreDeps,
  a: { archivePath: string; identityPath: string },
  outDir: string,
): Promise<VerifyReport> {
  const { fs } = deps;
  const report: VerifyReport = { ok: false, manifest: null, problems: [], tables: {}, integrity: 'not checked', ignored: [] };
  const problem = (p: string): void => { report.problems.push(p); };

  if (fs.kind(a.archivePath) !== 'file') problem('archive is not a regular file');
  if (fs.kind(a.identityPath) !== 'file') problem('identity is not a regular file');
  if (report.problems.length > 0) return report;

  try {
    await deps.unpack({ archivePath: a.archivePath, identityPath: a.identityPath, outDir });
  } catch {
    problem('could not decrypt or extract the archive');
    return report;
  }

  const files: string[] = [];
  let total = 0;
  for (const e of fs.walk(outDir)) {
    const rel = stripDot(e.rel);
    if (rel === '' || rel === '.') continue;
    if (isAppleDouble(rel)) {
      report.ignored.push(clean(rel));
      continue;
    }
    if (e.kind === 'symlink') problem(`archive contains a symlink: ${clean(rel)}`);
    else if (e.kind === 'other') problem(`archive contains a special file: ${clean(rel)}`);
    else if (e.kind === 'file') {
      if (e.nlink > 1) problem(`archive contains a hardlink: ${clean(rel)}`);
      files.push(rel);
      total += e.size;
    }
  }
  if (total > MAX_EXTRACTED_BYTES) problem('extracted size exceeds the allowed maximum');
  if (report.problems.length > 0) return report;

  const manifestPath = join(outDir, 'manifest.json');
  if (fs.kind(manifestPath) !== 'file') {
    problem('manifest.json is missing');
    return report;
  }
  let manifest: Manifest;
  try {
    manifest = parseManifest(fs.read(manifestPath));
  } catch (e) {
    problem(`manifest is invalid: ${clean((e as Error).message)}`);
    return report;
  }
  report.manifest = manifest;

  const v = verifyFiles(
    manifest,
    (p) => (fs.kind(join(outDir, p)) === 'file' ? fs.hash(join(outDir, p)) : null),
    files.filter((f) => f !== 'manifest.json'),
  );
  for (const p of v.missing) problem(`missing file: ${clean(p)}`);
  for (const p of v.mismatched) problem(`checksum mismatch: ${clean(p)}`);
  for (const p of v.extra) problem(`file not in manifest: ${clean(p)}`);

  const dbPath = join(outDir, 'data.sqlite');
  if (fs.kind(dbPath) !== 'file') {
    problem('data.sqlite is missing');
  } else {
    const snap = deps.checkSnapshot(dbPath);
    report.integrity = snap.integrity;
    report.tables = snap.tables;
    if (!snap.ok) problem(`database integrity check failed: ${clean(snap.integrity)}`);
    const want = manifest.db.tables;
    for (const [t, n] of Object.entries(want)) {
      if (snap.tables[t] !== n) problem(`table count differs from manifest: ${t}`);
    }
    for (const t of Object.keys(snap.tables)) {
      if (!(t in want)) problem(`table not in manifest: ${t}`);
    }
  }

  report.ok = report.problems.length === 0;
  return report;
}

/** Verify only. Writes nothing outside a fresh temp dir, which is always removed. */
export async function verifyArchive(deps: RestoreDeps, a: { archivePath: string; identityPath: string }): Promise<VerifyReport> {
  const dir = deps.fs.mkdtemp(join(tmpdir(), 'jobber-restore-'));
  try {
    return await verifyInto(deps, a, dir);
  } finally {
    try { deps.fs.rmrf(dir); } catch { /* best effort */ }
  }
}

export interface RestorePlanItem {
  archivePath: string;
  target: string;
  action: 'replace' | 'create' | 'skip-secret';
  moveAsideTo: string | null;
}

const isSecretPath = (p: string): boolean => p === '.env' || p === 'secrets' || p.startsWith('secrets/');

export function planRestore(
  manifest: Manifest,
  root: string,
  exists: (p: string) => boolean,
  o: { withSecrets: boolean; stamp: string },
): RestorePlanItem[] {
  const base = resolve(root);
  return manifest.files.map((f) => {
    const target = resolve(base, f.path);
    if (!target.startsWith(base + sep)) throw new Error(`refusing a target outside the project root: ${clean(f.path)}`);
    if (isSecretPath(f.path) && !o.withSecrets) {
      return { archivePath: f.path, target, action: 'skip-secret' as const, moveAsideTo: null };
    }
    const there = exists(target);
    return {
      archivePath: f.path,
      target,
      action: there ? ('replace' as const) : ('create' as const),
      moveAsideTo: there ? `${target}.pre-restore-${o.stamp}` : null,
    };
  });
}

/** The stale WAL and shared-memory files next to a replaced database must be moved aside too. */
export function walSiblings(root: string, exists: (p: string) => boolean, stamp: string): { target: string; moveAsideTo: string }[] {
  return ['data.sqlite-wal', 'data.sqlite-shm']
    .map((n) => resolve(root, n))
    .filter((p) => exists(p))
    .map((p) => ({ target: p, moveAsideTo: `${p}.pre-restore-${stamp}` }));
}

export const restoreStamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export async function applyRestore(
  deps: RestoreDeps,
  a: { archivePath: string; identityPath: string; root: string; withSecrets: boolean; confirm: string },
): Promise<{ moved: string[]; restored: string[] }> {
  const { fs } = deps;
  if (a.confirm !== `RESTORE ${basename(a.archivePath)}`) {
    throw new Error('confirmation text does not match; nothing was changed');
  }
  const root = resolve(a.root);
  const lock = await deps.lock.acquire();
  if (lock === null) throw new Error('the run lock is held; stop the running session first; nothing was changed');

  let tmp: string | null = null;
  const moved: { from: string; to: string }[] = [];
  const touched: string[] = [];
  const createdDirs: string[] = [];
  try {
    tmp = fs.mkdtemp(join(tmpdir(), 'jobber-restore-'));
    const report = await verifyInto(deps, a, tmp);
    if (!report.ok || report.manifest === null) {
      throw new Error(`archive failed verification (${report.problems.length} problem(s)); nothing was changed`);
    }
    const manifest = report.manifest;
    const stamp = restoreStamp(deps.now());
    const exists = (p: string): boolean => fs.exists(p);
    const plan = planRestore(manifest, root, exists, { withSecrets: a.withSecrets, stamp });
    const siblings = plan.some((p) => p.archivePath === 'data.sqlite' && p.action !== 'skip-secret')
      ? walSiblings(root, exists, stamp)
      : [];

    // refuse anything that is not a plain file or a plain path below the root, before touching anything
    for (const item of plan) {
      if (item.action === 'skip-secret') continue;
      let cur = dirname(item.target);
      while (cur.startsWith(root + sep)) {
        const k = fs.kind(cur);
        if (k === 'symlink' || k === 'file' || k === 'other') throw new Error(`unsafe directory on the way to ${clean(item.archivePath)}`);
        cur = dirname(cur);
      }
      const k = fs.kind(item.target);
      if (k !== null && k !== 'file') throw new Error(`refusing to replace a non-file target: ${clean(item.archivePath)}`);
      if (item.moveAsideTo !== null && fs.exists(item.moveAsideTo)) throw new Error(`move-aside name already exists: ${clean(item.archivePath)}`);
    }
    for (const s of siblings) {
      if (fs.exists(s.moveAsideTo)) throw new Error('move-aside name already exists for a database sidecar file');
    }

    const moveAside = (from: string, to: string): void => {
      fs.move(from, to);
      moved.push({ from, to });
    };
    try {
      for (const s of siblings) moveAside(s.target, s.moveAsideTo);
      for (const item of plan) {
        if (item.action === 'skip-secret') continue;
        if (item.moveAsideTo !== null) moveAside(item.target, item.moveAsideTo);
        const missing: string[] = [];
        for (let d = dirname(item.target); d.startsWith(root + sep) && !fs.exists(d); d = dirname(d)) missing.unshift(d);
        for (const d of missing) if (!createdDirs.includes(d)) createdDirs.push(d);
        try {
          fs.copy(join(tmp, item.archivePath), item.target);
        } catch (e) {
          // the target was absent before this copy, so anything there is our partial file
          try { fs.rmrf(item.target); } catch { /* caught by the rollback report below if it matters */ }
          throw e;
        }
        touched.push(item.target);
        fs.mode(item.target, 0o600);
      }
    } catch (e) {
      const stuck: string[] = [];
      for (const t of [...touched].reverse()) {
        try { fs.rmrf(t); } catch { stuck.push(`could not remove restored file ${relative(root, t)}`); }
      }
      for (const m of [...moved].reverse()) {
        try { fs.move(m.to, m.from); } catch {
          stuck.push(`move ${relative(root, m.to)} back to ${relative(root, m.from)} manually`);
        }
      }
      for (const d of [...createdDirs].reverse()) {
        try {
          if (fs.exists(d) && fs.list(d).length === 0) fs.rmrf(d);
        } catch { /* a leftover empty directory is harmless */ }
      }
      if (stuck.length > 0) {
        throw new Error(`restore failed and the rollback is incomplete: ${stuck.join('; ')}`);
      }
      throw e;
    }
    return { moved: moved.map((m) => m.to), restored: touched };
  } finally {
    if (tmp !== null) { try { fs.rmrf(tmp); } catch { /* best effort */ } }
    try { await lock.release(); } catch { /* best effort */ }
  }
}

export async function drill(
  deps: RestoreDeps,
  a: { archivePath: string; identityPath: string; liveDbPath: string },
): Promise<VerifyReport & { liveTableMissingInBackup: string[] }> {
  const report = await verifyArchive(deps, a);
  const live = deps.checkSnapshot(a.liveDbPath);
  const have = new Set(Object.keys(report.tables));
  const liveTableMissingInBackup = Object.keys(live.tables).filter((t) => !have.has(t));
  if (report.ok) {
    try {
      deps.state.save({ ...deps.state.load(), last_drill_at: deps.now().toISOString() });
    } catch { /* a state write failure never fails the drill */ }
  }
  return { ...report, liveTableMissingInBackup };
}

function kindOf(p: string): RestoreKind | null {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isFile()) return 'file';
    if (st.isDirectory()) return 'dir';
    return 'other';
  } catch {
    return null;
  }
}

export const nodeRestoreFs: RestoreFs = {
  mkdtemp: (prefix) => {
    const d = mkdtempSync(prefix);
    chmodSync(d, 0o700);
    return d;
  },
  exists: (p) => {
    try { lstatSync(p); return true; } catch { return false; }
  },
  kind: kindOf,
  list: (d) => readdirSync(d),
  walk: (dir) => {
    const out: WalkEntry[] = [];
    const rec = (abs: string, rel: string): void => {
      for (const name of readdirSync(abs)) {
        const childAbs = join(abs, name);
        const childRel = rel === '' ? name : `${rel}/${name}`;
        const st = lstatSync(childAbs);
        const kind: RestoreKind = st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
        out.push({ rel: childRel, kind, nlink: st.nlink, size: st.size });
        if (kind === 'dir') rec(childAbs, childRel);
      }
    };
    rec(dir, '');
    return out;
  },
  hash: (p) => createHash('sha256').update(readFileSync(p)).digest('hex'),
  read: (p) => readFileSync(p, 'utf8'),
  copy: (src, dest) => {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    copyFileSync(src, dest, constants.COPYFILE_EXCL);
  },
  move: (src, dest) => {
    if (existsSync(dest) || kindOf(dest) !== null) throw new Error('destination exists');
    renameSync(src, dest);
  },
  rmrf: (p) => rmSync(p, { recursive: true, force: true }),
  mode: (p, mode) => { chmodSync(p, mode); },
};

/** age -d piped into tar -x: no absolute names (no -P), no ownership, extraction only below outDir. */
export function unpackWithAge(): RestoreDeps['unpack'] {
  return async ({ archivePath, identityPath, outDir }) => {
    process.env.COPYFILE_DISABLE = '1';
    const r = await pipeExec(
      { cmd: 'age', args: ['-d', '-i', identityPath, archivePath] },
      { cmd: 'tar', args: ['-xzf', '-', '-C', outDir, '--no-same-owner'] },
    );
    if (r.producerCode !== 0 || r.consumerCode !== 0) throw new Error('unpack failed');
  };
}
