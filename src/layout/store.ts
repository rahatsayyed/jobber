// Layout memory file: validated on load, bounded, written atomically (tmp + rename, mode 600).
// A bad file never throws on load: it is quarantined as <file>.corrupt-<time> and replaced by an empty layout.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { LayoutFile, Platform } from './types.js';
import { ID_RE, KINDS } from './vocab.js';

const DEFAULT_MAX_BYTES = 65536;
const MAX_VARIANTS = 3;
const MAX_RUN_IDS = 5;
const MAX_RECIPES = 12;
const KEEP_CORRUPT = 3;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const id = z.string().regex(ID_RE);
const iso = z.string().refine((s) => ISO_RE.test(s) && !Number.isNaN(Date.parse(s)), 'bad ISO date');
const count = z.number().int().min(0).max(1_000_000);

const recipeSchema = z.object({
  action: z.enum(['click', 'type', 'scroll']),
  label: id,
  how: z.enum(['text', 'role_name', 'ordinal']),
  ordinal: z.number().int().min(0).max(9).optional(),
  region: id.optional(),
  v: count, ok: count, fail: count,
  last_ok: iso.nullable(),
}).strict();

const variantSchema = z.object({
  id,
  landmarks: z.array(id).max(64),
  counts: z.record(id, z.tuple([count, count])),
  recipes: z.array(recipeSchema).max(256),
  first_seen: iso, last_verified: iso.nullable(),
  obs: count, runs: count,
  run_ids: z.array(z.string().regex(RUN_ID_RE)).max(256),
  promoted: z.boolean(),
  ok: count, fail: count,
}).strict();

const kindSchema = z.object({
  state: z.enum(['learning', 'stable', 'stale', 'drifted']),
  variants: z.array(variantSchema).max(256),
  counters: z.object({ match: count, partial: count, drift: count }).strict(),
  drift_streak: count,
  drift_window_start: iso.nullable(),
  last_drift_at: iso.nullable(),
}).strict();

const fileSchema = z.object({
  schema: z.literal(1),
  platform: z.enum(['linkedin', 'naukri']),
  updated_at: iso,
  kinds: z.record(id, kindSchema),
}).strict();

export function emptyLayout(platform: Platform, now: Date): LayoutFile {
  return { schema: 1, platform, updated_at: now.toISOString(), kinds: {} };
}

// Deterministic caps: oldest variants dropped first, most recent run ids kept.
function applyCaps(f: LayoutFile): LayoutFile {
  for (const km of Object.values(f.kinds)) {
    if (km.variants.length > MAX_VARIANTS) {
      const order = km.variants
        .map((v, i) => ({ v, i }))
        .sort((a, b) => (a.v.first_seen < b.v.first_seen ? -1 : a.v.first_seen > b.v.first_seen ? 1 : a.i - b.i));
      const drop = new Set(order.slice(0, km.variants.length - MAX_VARIANTS).map((o) => o.i));
      km.variants = km.variants.filter((_, i) => !drop.has(i));
    }
    for (const v of km.variants) {
      v.run_ids = v.run_ids.slice(-MAX_RUN_IDS);
      v.recipes = v.recipes.slice(0, MAX_RECIPES);
    }
  }
  return f;
}

function quarantine(file: string, now: Date): void {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let dest = `${file}.corrupt-${stamp}`;
  for (let n = 1; fs.existsSync(dest); n++) dest = `${file}.corrupt-${stamp}-${n}`;
  try {
    fs.renameSync(file, dest);
  } catch {
    return;
  }
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.corrupt-`;
  const old = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - KEEP_CORRUPT))) {
    try { fs.unlinkSync(path.join(dir, n)); } catch { /* best effort */ }
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function loadLayout(
  file: string, platform: Platform, now: Date, maxBytes: number = DEFAULT_MAX_BYTES,
): { file: LayoutFile; note: string | null } {
  const empty = (note: string | null) => ({ file: emptyLayout(platform, now), note });
  if (isSymlink(file) || isSymlink(path.dirname(file))) return empty('layout memory path is a symlink, refused');
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return empty(null);
  }
  const bad = (why: string) => {
    quarantine(file, now);
    return empty(`layout memory corrupt (${why}), reset`);
  };
  if (!st.isFile()) return empty('layout memory path is not a regular file, refused');
  if (st.size > maxBytes) return bad('oversize');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return bad('invalid json');
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return bad('schema invalid');
  const data = parsed.data as LayoutFile;
  if (data.platform !== platform) return bad('platform mismatch');
  const known = new Set<string>(KINDS[platform]);
  if (Object.keys(data.kinds).some((k) => !known.has(k))) return bad('unknown kind');
  return { file: applyCaps(data), note: null };
}

function newestStamp(km: LayoutFile['kinds'][string]): string {
  let s = '';
  for (const v of km.variants) {
    const t = v.last_verified ?? v.first_seen;
    if (t > s) s = t;
  }
  return s;
}

// Trim order: recipes with ok=0, then non-promoted variants (oldest first), then oldest kinds.
function trim(f: LayoutFile, maxBytes: number): LayoutFile {
  const size = () => Buffer.byteLength(JSON.stringify(f));
  if (size() <= maxBytes) return f;
  for (const km of Object.values(f.kinds)) for (const v of km.variants) v.recipes = v.recipes.filter((r) => r.ok > 0);
  while (size() > maxBytes) {
    let pick: { km: LayoutFile['kinds'][string]; i: number } | null = null;
    for (const km of Object.values(f.kinds)) {
      km.variants.forEach((v, i) => {
        if (v.promoted) return;
        if (!pick || v.first_seen < pick.km.variants[pick.i].first_seen) pick = { km, i };
      });
    }
    if (!pick) break;
    const p = pick as { km: LayoutFile['kinds'][string]; i: number };
    p.km.variants.splice(p.i, 1);
  }
  while (size() > maxBytes) {
    const keys = Object.keys(f.kinds).sort((a, b) => {
      const sa = newestStamp(f.kinds[a]);
      const sb = newestStamp(f.kinds[b]);
      return sa < sb ? -1 : sa > sb ? 1 : a < b ? -1 : 1;
    });
    if (keys.length === 0) break;
    delete f.kinds[keys[0]];
  }
  return f;
}

export function saveLayout(file: string, data: LayoutFile, maxBytes: number): void {
  const dir = path.dirname(file);
  if (isSymlink(file) || isSymlink(dir)) throw new Error('layout memory path is a symlink, refused');
  const copy = JSON.parse(JSON.stringify(data)) as LayoutFile;
  const checked = fileSchema.safeParse(copy);
  if (!checked.success) throw new Error('layout memory invalid, not saved');
  const out = trim(applyCaps(copy), maxBytes);
  const text = JSON.stringify(out);
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`layout memory exceeds maxBytes (${maxBytes})`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to chmod */ }
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

export interface LockDeps {
  now: () => number;                 // ms
  sleep: (ms: number) => void;
  staleMs?: number;                  // default 10000
  timeoutMs?: number;                // default 15000
}

const defaultLockDeps: LockDeps = {
  now: () => Date.now(),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
};

// Cross-process mutex: O_EXCL lock file holding "<token>\n<acquired ms>"; a lock older than staleMs is broken.
export function withLayoutLock<T>(file: string, fn: () => T, deps: LockDeps = defaultLockDeps): T {
  const lock = `${file}.lock`;
  const staleMs = deps.staleMs ?? 10_000;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const token = randomBytes(8).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const start = deps.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeSync(fd, `${token}\n${deps.now()}`); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let acquired = NaN;
    try {
      acquired = Number(fs.readFileSync(lock, 'utf8').split('\n')[1]);
      if (!Number.isFinite(acquired)) acquired = fs.statSync(lock).mtimeMs;
    } catch {
      continue;                                // vanished between the open and the read: retry now
    }
    if (deps.now() - acquired > staleMs) {
      try { fs.unlinkSync(lock); } catch { /* someone else broke it */ }
      continue;
    }
    if (deps.now() - start >= timeoutMs) throw new Error('layout lock timeout');
    deps.sleep(25);
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lock, 'utf8').split('\n')[0] === token) fs.unlinkSync(lock);
    } catch { /* lock already gone or broken as stale */ }
  }
}
