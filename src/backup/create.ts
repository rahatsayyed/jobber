import {
  chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Exec } from '../lib/exec.js';
import { pipeExec } from '../lib/exec.js';
import type { SnapshotCheck } from '../lib/sqliteSnapshot.js';
import type { BackupConfig } from './config.js';
import type { BackupDestination } from './destination.js';
import { isExcludedName, planEntries, type Excluded } from './entries.js';
import { buildManifest, isSafeArchivePath } from './manifest.js';
import { backupName, planRetention } from './retention.js';

export type PathKind = 'file' | 'dir' | 'symlink' | 'other';

export interface CreateFs {
  exists(p: string): boolean;
  list(d: string): string[];
  mkdtemp(prefix: string): string;
  rmrf(p: string): void;
  hash(p: string): string;
  size(p: string): number;
  copyIn(src: string, dest: string): void;
  mkdirp(p: string, mode: number): void;
  lstat(p: string): PathKind | null;
  mtimeMs(p: string): number | null;
  write(p: string, text: string, mode: number): void;
  chmod(p: string, mode: number): void;
}

export interface CreateDeps {
  root: string;
  now: () => Date;
  exec: Exec;
  fs: CreateFs;
  snapshotDb: (dest: string) => Promise<void>;
  checkSnapshot: (p: string) => SnapshotCheck;
  pack: (args: { stagingDir: string; recipient: string; outPath: string }) => Promise<void>;
  destinations: BackupDestination[];
  commit: () => Promise<string | null>;
}

export interface CreatePlan {
  entries: { path: string; kind: string; why: string }[];
  files: string[];
  excluded: Excluded[];
}

export interface CreateResult {
  ok: boolean;
  name: string | null;
  bytes: number;
  uploaded: string[];
  failed: { label: string; error: string }[];
  removed: string[];
  error: string | null;
  code: string | null;
  plan?: CreatePlan;
}

const STAGING_PREFIX = '.staging-';
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, '?');

function fail(code: string, error: string, extra: Partial<CreateResult> = {}): CreateResult {
  return { ok: false, name: null, bytes: 0, uploaded: [], failed: [], removed: [], error, code, ...extra };
}

interface Staged { archivePath: string; source: string | null }

/** Lists what would be archived: dirs expanded with lstat, symlinks and excluded names skipped, nothing followed. */
function expand(
  deps: CreateDeps,
  entries: ReturnType<typeof planEntries>['entries'],
  excluded: Excluded[],
): Staged[] {
  const { root, fs } = deps;
  const out: Staged[] = [];
  const seen = new Set<string>();
  const add = (archivePath: string, source: string | null): void => {
    if (seen.has(archivePath)) return;
    seen.add(archivePath);
    out.push({ archivePath, source });
  };
  const walk = (relSrc: string, arc: string): void => {
    const abs = join(root, relSrc);
    const kind = fs.lstat(abs);
    if (kind === 'symlink') excluded.push({ path: clean(relSrc), why: 'symlink, not followed' });
    else if (kind === 'file') add(arc, abs);
    else if (kind === 'dir') {
      for (const name of fs.list(abs).sort()) {
        const childRel = `${relSrc}/${name}`;
        const childArc = `${arc}/${name}`;
        if (isExcludedName(childRel)) excluded.push({ path: clean(childRel), why: 'excluded name pattern (backup copy, pdf, wal or generated output)' });
        else if (!isSafeArchivePath(childArc)) excluded.push({ path: clean(childRel), why: 'unsafe archive path' });
        else walk(childRel, childArc);
      }
    } else if (kind === null) excluded.push({ path: clean(relSrc), why: 'missing' });
    else excluded.push({ path: clean(relSrc), why: 'not a regular file or directory' });
  };
  for (const e of entries) {
    if (e.kind === 'db') add(e.archivePath, null);
    else if (isExcludedName(e.source)) excluded.push({ path: clean(e.source), why: 'excluded name pattern' });
    else walk(e.source, e.archivePath);
  }
  return out;
}

export async function createBackup(deps: CreateDeps, cfg: BackupConfig, opts: { planOnly: boolean }): Promise<CreateResult> {
  const { root, fs } = deps;
  const backupsDir = join(root, '.backups');

  if (opts.planOnly) {
    const ex = { exists: (p: string) => fs.exists(join(root, p)), list: (d: string) => fs.list(join(root, d)) };
    const planned = planEntries(root, ex, cfg, join(backupsDir, '.plan-only', 'data.sqlite'));
    const excluded = [...planned.excluded];
    const staged = expand(deps, planned.entries, excluded);
    const plan: CreatePlan = {
      entries: planned.entries.map((e) => ({ path: e.archivePath, kind: e.kind, why: e.why })),
      files: staged.map((s) => s.archivePath),
      excluded,
    };
    return { ok: true, name: null, bytes: 0, uploaded: [], failed: [], removed: [], error: null, code: null, plan };
  }

  if (!cfg.configured || cfg.problems.length > 0 || cfg.recipient === null || cfg.dir === null || deps.destinations.length === 0) {
    return fail('not_configured', 'backup is not configured (see npm run doctor)');
  }
  const ageProbe = await deps.exec('age', ['--version']);
  if (ageProbe.code === 127) return fail('age_missing', 'age is not installed (brew install age)');
  if (ageProbe.code !== 0) return fail('age_broken', 'age did not run cleanly');

  const now = deps.now();
  const name = backupName(now);
  let staging: string | null = null;
  let outDir: string | null = null;
  let stage = 'prepare';
  try {
    fs.mkdirp(backupsDir, 0o700);
    // crash leftovers: only directories named .staging-*, older than 24 hours
    for (const n of fs.list(backupsDir)) {
      if (!n.startsWith(STAGING_PREFIX)) continue;
      const m = fs.mtimeMs(join(backupsDir, n));
      if (m !== null && now.getTime() - m > STAGING_MAX_AGE_MS) fs.rmrf(join(backupsDir, n));
    }
    staging = fs.mkdtemp(join(backupsDir, STAGING_PREFIX));
    outDir = fs.mkdtemp(join(backupsDir, `${STAGING_PREFIX}out-`));

    stage = 'snapshot';
    const dbStaged = join(staging, 'data.sqlite');
    await deps.snapshotDb(dbStaged);
    const check = deps.checkSnapshot(dbStaged);
    if (!check.ok) return fail('integrity', 'database snapshot failed the integrity check; nothing was uploaded');

    stage = 'stage';
    const ex = { exists: (p: string) => fs.exists(join(root, p)), list: (d: string) => fs.list(join(root, d)) };
    const planned = planEntries(root, ex, cfg, dbStaged);
    const excluded = [...planned.excluded];
    const staged = expand(deps, planned.entries, excluded);
    for (const s of staged) {
      if (s.source !== null) fs.copyIn(s.source, join(staging, s.archivePath));
    }

    const files = staged.map((s) => {
      const p = join(staging as string, s.archivePath);
      return { path: s.archivePath, sha256: fs.hash(p), bytes: fs.size(p) };
    });
    const manifest = buildManifest({
      created_at: now.toISOString(),
      commit: await deps.commit(),
      includes_secrets: cfg.includeSecrets,
      files,
      db: { path: 'data.sqlite', tables: check.tables },
    });
    fs.write(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 0o600);

    stage = 'encrypt';
    const outPath = join(outDir, name);
    try {
      await deps.pack({ stagingDir: staging, recipient: cfg.recipient, outPath });
    } catch {
      try { fs.rmrf(outPath); } catch { /* ignore */ }
      return fail('encrypt', 'encryption failed; no archive was written');
    }
    const digest = fs.hash(outPath);
    const bytes = fs.size(outPath);
    const sidecar = join(outDir, `${name}.sha256`);
    fs.write(sidecar, `${digest}  ${name}\n`, 0o600);

    stage = 'upload';
    const uploaded: string[] = [];
    const failed: { label: string; error: string }[] = [];
    for (let i = 0; i < deps.destinations.length; i++) {
      const d = deps.destinations[i];
      try {
        await d.put(outPath, name);
        await d.put(sidecar, `${name}.sha256`);
        uploaded.push(d.label);
      } catch {
        if (i === 0) return fail('upload', 'upload to the primary destination failed', { name, bytes });
        failed.push({ label: d.label, error: 'upload failed' });
      }
    }

    // retention never fails the run
    const removed: string[] = [];
    try {
      const primary = deps.destinations[0];
      const plan = planRetention(await primary.list(), cfg.retain, now);
      for (const old of plan.remove) {
        // the plan already lists each stale archive followed by its sidecar
        if (old === name || old === `${name}.sha256`) continue;
        try {
          await primary.remove(old);
          if (!old.endsWith('.sha256')) removed.push(old);
        } catch { /* keep going */ }
      }
    } catch { /* ignore */ }

    return { ok: true, name, bytes, uploaded, failed, removed, error: null, code: failed.length > 0 ? 'secondary_failed' : null };
  } catch {
    return fail(stage, `backup failed during ${stage}`);
  } finally {
    for (const d of [staging, outDir]) {
      if (d === null) continue;
      try { fs.rmrf(d); } catch { /* best effort */ }
    }
  }
}

export const nodeCreateFs: CreateFs = {
  exists: (p) => existsSync(p),
  list: (d) => readdirSync(d),
  mkdtemp: (prefix) => {
    const d = mkdtempSync(prefix);
    chmodSync(d, 0o700);
    return d;
  },
  rmrf: (p) => rmSync(p, { recursive: true, force: true }),
  hash: (p) => {
    // synchronous read keeps the port simple; the data set is small
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  },
  size: (p) => statSync(p).size,
  copyIn: (src, dest) => {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    copyFileSync(src, dest, constants.COPYFILE_EXCL);
    chmodSync(dest, 0o600);
  },
  mkdirp: (p, mode) => { mkdirSync(p, { recursive: true, mode }); },
  lstat: (p) => {
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return 'symlink';
      if (st.isFile()) return 'file';
      if (st.isDirectory()) return 'dir';
      return 'other';
    } catch {
      return null;
    }
  },
  mtimeMs: (p) => {
    try { return lstatSync(p).mtimeMs; } catch { return null; }
  },
  write: (p, text, mode) => { writeFileSync(p, text, { mode }); },
  chmod: (p, mode) => { chmodSync(p, mode); },
};

/** tar (no shell, symlinks stored not followed, relative names) piped into age with the public recipient. */
export function packWithAge(): CreateDeps['pack'] {
  return async ({ stagingDir, recipient, outPath }) => {
    try {
      const r = await pipeExec(
        { cmd: 'tar', args: ['-C', stagingDir, '-czf', '-', '.'] },
        { cmd: 'age', args: ['-r', recipient, '-o', outPath] },
      );
      if (r.producerCode !== 0 || r.consumerCode !== 0) throw new Error('pack failed');
      chmodSync(outPath, 0o600);
    } catch (e) {
      try { rmSync(outPath, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  };
}
