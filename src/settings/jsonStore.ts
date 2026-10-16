// src/settings/jsonStore.ts
// Reads, plans and applies edits of the allowlisted config and user-data JSON files (plan 8H, Task 4).
// Every path is built from a registry constant; the target is lstat-checked (no symlinks, regular files only) before a
// read and again before a write. Applying goes through writeWithBackup (src/settings/atomic.ts).
import { basename, join } from 'node:path';
import { userDataDir as resolveUserDataDir } from '../lib/userData.js';
import { type AtomicFs, SettingsError, etagOf, writeWithBackup } from './atomic.js';
import { type LineDiff, lineDiff } from './diff.js';
import { type FileEntry, type ValidateCtx, allEntries, parseJsonText, resolveEntry } from './fileRegistry.js';
import type { EditTier, RestartScope } from './types.js';

export interface JsonStoreDeps {
  fs: AtomicFs;
  /** project root (config/ lives under it) */
  root: string;
  /** realpath'ed user-data directory; defaults to userDataDir(env, root) */
  userDataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** backups go to <backupDir>/files/<id>/<stamp>-<etag8>.json */
  backupDir: string;
  keep: number;
  now: () => Date;
}

export interface FilePlan {
  id: string;
  etag: string;
  newEtag: string;
  /** sha256-based hash of the planned text; apply refuses a different text */
  textHash: string;
  errors: string[];
  warnings: string[];
  diff: LineDiff;
  tier: EditTier;
  restart: RestartScope;
  /** reason the change widens what the agent may do, or null */
  weakens: string | null;
  changedPaths: number;
  stale: boolean;
}

export interface FileSummary {
  id: string;
  rel: string;
  area: 'config' | 'user-data';
  edit: boolean;
  exists: boolean;
  etag: string;
  tier: EditTier;
  restart: RestartScope;
  viewReason?: string;
  /** set when the target is refused (symlink, not a regular file) */
  problem?: string;
}

export interface JsonStore {
  read(id: string): { text: string; etag: string; exists: boolean };
  plan(id: string, newText: string, expectEtag: string): FilePlan;
  apply(plan: FilePlan, newText: string): { backupId: string; newEtag: string };
  list(): FileSummary[];
  /** Resolved absolute path of an entry (for diagnostics and tests). */
  pathOf(id: string): string;
}

function must(id: string): FileEntry {
  const e = resolveEntry(id);
  if (!e) throw new SettingsError('unknown_file', 'unknown settings file');
  return e;
}

/** Number of leaf JSON paths that differ between two parsed values (arrays compare by index). */
export function countChangedPaths(a: unknown, b: unknown): number {
  const isC = (v: unknown): v is Record<string, unknown> | unknown[] => !!v && typeof v === 'object';
  if (!isC(a) || !isC(b) || Array.isArray(a) !== Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let n = 0;
  for (const k of keys) {
    const x = (a as Record<string, unknown>)[k];
    const y = (b as Record<string, unknown>)[k];
    n += x === undefined || y === undefined ? (x === y ? 0 : 1) : countChangedPaths(x, y);
  }
  return n;
}

export function createJsonStore(deps: JsonStoreDeps): JsonStore {
  const { fs } = deps;
  const udirRaw = deps.userDataDir ?? resolveUserDataDir(deps.env ?? process.env, deps.root);
  // Resolved once: a symlinked user-data directory (or JOBAPPLIER_USER_DATA through a symlink) is followed here, so
  // existing and missing files are checked against the same real directory. A missing directory stays as given
  // and is reported as parent_missing.
  const udir = (() => {
    try {
      return fs.realpath(udirRaw);
    } catch {
      return udirRaw;
    }
  })();

  function targetPath(e: FileEntry): string {
    if (e.area === 'user-data') return join(udir, basename(e.rel));
    if (e.altRel && fs.lstat(join(deps.root, e.altRel))) return join(deps.root, e.altRel);
    return join(deps.root, e.rel);
  }

  function parentOf(p: string): string {
    return p.slice(0, p.lastIndexOf('/')) || '/';
  }

  /** Refuses a symlink, a directory or anything not a regular file; a missing file needs its parent directory. */
  function checkTarget(p: string): 'file' | 'missing' {
    const st = fs.lstat(p);
    if (st === null) {
      const par = fs.lstat(parentOf(p));
      if (!par || par.kind !== 'dir') throw new SettingsError('parent_missing', 'the target directory does not exist');
      return 'missing';
    }
    if (st.kind === 'symlink') throw new SettingsError('symlink_refused', 'the target is a symbolic link');
    if (st.kind !== 'file') throw new SettingsError('not_regular_file', 'the target is not a regular file');
    return 'file';
  }

  function readEntry(e: FileEntry): { text: string; etag: string; exists: boolean } {
    const p = targetPath(e);
    if (checkTarget(p) === 'missing') return { text: '', etag: etagOf(''), exists: false };
    const text = fs.read(p);
    return { text, etag: etagOf(text), exists: true };
  }

  const ctx: ValidateCtx = {
    readText(id) {
      try {
        const e = resolveEntry(id);
        if (!e) return null;
        const r = readEntry(e);
        return r.exists ? r.text : null;
      } catch {
        return null;
      }
    },
  };

  function parsedOrNull(text: string): unknown {
    const p = parseJsonText(text);
    return p.ok ? p.value : null;
  }

  return {
    pathOf: (id) => targetPath(must(id)),

    read: (id) => readEntry(must(id)),

    plan(id, newText, expectEtag) {
      const e = must(id);
      const cur = readEntry(e);
      const v = e.edit ? e.validate(newText, ctx) : { ok: false, errors: ['this file is view only'], warnings: [] as string[] };
      const stale = cur.etag !== expectEtag;
      const errors = [...v.errors];
      if (stale) errors.unshift('stale_etag');
      const before = parsedOrNull(cur.text);
      const after = parsedOrNull(newText);
      let weak: string | null = null;
      if (e.edit && e.weakens && v.ok) {
        try {
          weak = e.weakens(before, after);
        } catch {
          weak = null;
        }
      }
      return {
        id,
        etag: cur.etag,
        newEtag: etagOf(newText),
        textHash: etagOf(newText),
        errors,
        warnings: v.warnings,
        diff: lineDiff(cur.text, newText),
        tier: weak ? (e.weakTier ?? e.tier) : e.tier,
        restart: e.restart,
        weakens: weak,
        changedPaths: before !== null && after !== null ? countChangedPaths(before, after) : 0,
        stale,
      };
    },

    apply(plan, newText) {
      const e = must(plan.id);
      if (!e.edit) throw new SettingsError('not_editable', 'this file is view only');
      if (plan.errors.length > 0) throw new SettingsError(plan.stale ? 'stale_etag' : 'invalid_plan', 'the plan has errors');
      if (etagOf(newText) !== plan.textHash) throw new SettingsError('plan_mismatch', 'the text does not match the plan');
      const p = targetPath(e);
      checkTarget(p);
      return writeWithBackup({
        fs,
        path: p,
        text: newText,
        expectEtag: plan.etag,
        backupDir: join(deps.backupDir, 'files', e.id),
        backupExt: '.json',
        keep: deps.keep,
        now: deps.now,
        mode: e.area === 'user-data' ? 0o600 : (fs.lstat(p)?.mode ?? 0o644),
      });
    },

    list() {
      return allEntries().map((e): FileSummary => {
        const base = { id: e.id, rel: e.rel, area: e.area, edit: e.edit, tier: e.tier, restart: e.restart, ...(e.viewReason ? { viewReason: e.viewReason } : {}) };
        try {
          const r = readEntry(e);
          return { ...base, exists: r.exists, etag: r.etag };
        } catch (err) {
          return { ...base, exists: false, etag: '', problem: err instanceof SettingsError ? err.code : 'unreadable' };
        }
      });
    },
  };
}
