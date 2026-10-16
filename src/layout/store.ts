// Layout memory file: validated on load and save, bounded, written atomically (tmp + rename, mode 600).
// A bad file never throws on load: it is quarantined as <file>.corrupt-<time> and replaced by an empty layout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { LayoutFile, Platform } from './types.js';
import { COUNT_KEYS, ID_RE, MAX_RUN_IDS, RUN_ID_RE, actionLabelsFor, kindsFor, landmarksFor } from './vocab.js';
import { PROJECT_ROOT } from './config.js';

const DEFAULT_MAX_BYTES = 65536;
const MAX_VARIANTS = 3;
const MAX_RECIPES = 24;
const MAX_LANDMARKS = 40;
const MAX_KINDS = 12;
const LOOSE_MAX = 256;           // schema bound on arrays that are truncated rather than rejected
const KEEP_CORRUPT = 3;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const iso = z.string().refine((s) => ISO_RE.test(s) && !Number.isNaN(Date.parse(s)), 'bad ISO date');
const count = z.number().int().min(0).max(1_000_000);

// Closed vocabulary per platform: anything else is rejected, so page text cannot reach the file.
function buildSchema(platform: Platform) {
  const landmarks = new Set<string>(landmarksFor(platform));
  const labels = new Set<string>([...Object.values(actionLabelsFor(platform)), 'action:other']);
  const counts = new Set<string>(COUNT_KEYS);
  const landmark = z.string().regex(ID_RE).refine((s) => landmarks.has(s), 'unknown landmark');
  const label = z.string().regex(ID_RE).refine((s) => labels.has(s), 'unknown action label');
  const countKey = z.string().regex(ID_RE).refine((s) => counts.has(s), 'unknown count key');
  const kindKey = z.string().regex(ID_RE);

  const recipe = z.object({
    action: z.enum(['click', 'type', 'scroll']),
    label,
    how: z.enum(['text', 'role_name', 'ordinal']),
    ordinal: z.number().int().min(0).max(9).optional(),
    region: landmark.optional(),
    v: count, ok: count, fail: count,
    last_ok: iso.nullable(),
  }).strict();

  const variant = z.object({
    id: z.string().regex(ID_RE),
    landmarks: z.array(landmark).max(MAX_LANDMARKS),
    counts: z.record(countKey, z.tuple([count, count])),
    recipes: z.array(recipe).max(LOOSE_MAX).transform((r) => r.slice(0, MAX_RECIPES)),
    first_seen: iso, last_verified: iso.nullable(),
    obs: count, runs: count,
    run_ids: z.array(z.string().regex(RUN_ID_RE)).max(LOOSE_MAX).transform((r) => r.slice(-MAX_RUN_IDS)),
    promoted: z.boolean(),
    ok: count, fail: count,
  }).strict();

  const kind = z.object({
    state: z.enum(['learning', 'stable', 'stale', 'drifted']),
    // oldest first_seen dropped first; surviving variants keep their input order
    variants: z.array(variant).max(LOOSE_MAX).transform((vs) => {
      if (vs.length <= MAX_VARIANTS) return vs;
      const order = vs.map((v, i) => ({ v, i }))
        .sort((a, b) => (a.v.first_seen < b.v.first_seen ? -1 : a.v.first_seen > b.v.first_seen ? 1 : a.i - b.i));
      const drop = new Set(order.slice(0, vs.length - MAX_VARIANTS).map((o) => o.i));
      return vs.filter((_, i) => !drop.has(i));
    }),
    counters: z.object({ match: count, partial: count, drift: count }).strict(),
    drift_streak: count,
    drift_window_start: iso.nullable(),
    last_drift_at: iso.nullable(),
    drift_run_ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)).max(5).default([]),
  }).strict();

  return z.object({
    schema: z.literal(1),
    platform: z.literal(platform),
    updated_at: iso,
    kinds: z.record(kindKey, kind),
  }).strict();
}

const schemas = new Map<Platform, ReturnType<typeof buildSchema>>();

function has(o: unknown): o is Record<string, unknown> {
  return typeof o === 'object' && o !== null && !Array.isArray(o);
}

// The one validator used by load and save. Fails closed on any unknown kind, landmark, label or count key.
function validate(raw: unknown, platform: Platform): { ok: true; data: LayoutFile } | { ok: false; why: string } {
  const kindsAllowed = kindsFor(platform) as readonly string[] | undefined;
  if (!kindsAllowed) return { ok: false, why: 'unknown platform' };
  // Own-key prepass: JSON.parse keeps a "__proto__" key as an own property, which record parsing may skip.
  if (has(raw) && has(raw.kinds)) {
    for (const [k, km] of Object.entries(raw.kinds)) {
      if (!kindsAllowed.includes(k)) return { ok: false, why: 'unknown kind' };
      if (has(km) && Array.isArray(km.variants)) {
        for (const v of km.variants) {
          if (has(v) && has(v.counts) && Object.keys(v.counts).some((c) => !(COUNT_KEYS as readonly string[]).includes(c))) {
            return { ok: false, why: 'unknown count key' };
          }
        }
      }
    }
  }
  let schema = schemas.get(platform);
  if (!schema) { schema = buildSchema(platform); schemas.set(platform, schema); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, why: 'schema invalid' };
  const data = parsed.data as LayoutFile;
  const keys = Object.keys(data.kinds);
  if (keys.length > MAX_KINDS) {
    const stamp = (k: string) => newestStamp(data.kinds[k]);
    keys.sort((a, b) => (stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : a < b ? -1 : 1));
    for (const k of keys.slice(0, keys.length - MAX_KINDS)) delete data.kinds[k];
  }
  return { ok: true, data };
}

export function emptyLayout(platform: Platform, now: Date): LayoutFile {
  return { schema: 1, platform, updated_at: now.toISOString(), kinds: {} };
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

// True when the file or any directory above it (up to the project root or the OS temp dir) is a symlink.
// Walking stops at those two anchors, so a system symlink such as /var on macOS does not trip it.
function symlinkInPath(file: string): boolean {
  const anchors = [path.resolve(PROJECT_ROOT), path.resolve(os.tmpdir())];
  const isLink = (p: string) => {
    try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
  };
  if (isLink(file)) return true;
  let dir = path.dirname(path.resolve(file));
  while (!anchors.includes(dir)) {
    if (isLink(dir)) return true;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

// Read-only validation of file text (owner CLI, doctor): never quarantines or writes anything.
export function parseLayoutText(
  text: string, platform: Platform, maxBytes: number = DEFAULT_MAX_BYTES,
): { ok: true; data: LayoutFile } | { ok: false; why: string } {
  if (Buffer.byteLength(text) > maxBytes) return { ok: false, why: 'oversize' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, why: 'invalid json' };
  }
  return validate(raw, platform);
}

export function loadLayout(
  file: string, platform: Platform, now: Date, maxBytes: number = DEFAULT_MAX_BYTES,
): { file: LayoutFile; note: string | null } {
  const empty = (note: string | null) => ({ file: emptyLayout(platform, now), note });
  if (symlinkInPath(file)) return empty('layout memory path is a symlink, refused');
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
  const v = validate(raw, platform);
  if (!v.ok) return bad(v.why);
  return { file: v.data, note: null };
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
  const settle = () => {
    for (const km of Object.values(f.kinds)) if (km.variants.length === 0) km.state = 'learning';
  };
  if (size() <= maxBytes) return f;
  for (const km of Object.values(f.kinds)) for (const v of km.variants) v.recipes = v.recipes.filter((r) => r.ok > 0);
  settle();
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
    settle();
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

// `platform` defaults to the file's own; pass it to refuse a layout meant for another platform.
export function saveLayout(file: string, data: LayoutFile, maxBytes: number, platform?: Platform): void {
  if (symlinkInPath(file)) throw new Error('layout memory path is a symlink, refused');
  const want = platform ?? data.platform;
  const v = validate(JSON.parse(JSON.stringify(data)), want);
  if (!v.ok) throw new Error(`layout memory invalid (${v.why}), not saved`);
  const out = trim(v.data, maxBytes);
  const text = JSON.stringify(out);
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`layout memory exceeds maxBytes (${maxBytes})`);
  const dir = path.dirname(file);
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
  onStaleJudged?: () => void;        // test hook: runs between judging a lock stale and moving it
}

const defaultLockDeps: LockDeps = {
  now: () => Date.now(),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
};

// Advisory, single-host mutex: an O_EXCL lock file holding "<token>\n<acquired ms>". A lock older than
// staleMs is moved aside by rename, re-read and compared with what was judged stale; a mismatch means
// another process re-acquired it meanwhile, so the mover backs off and restores it. Not a cross-host lock.
export function withLayoutLock<T>(file: string, fn: () => T, deps: LockDeps = defaultLockDeps): T {
  if (symlinkInPath(file)) throw new Error('layout memory path is a symlink, refused');
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
    let judged: string;
    let acquired: number;
    try {
      judged = fs.readFileSync(lock, 'utf8');
      acquired = Number(judged.split('\n')[1]);
      if (!Number.isFinite(acquired)) acquired = fs.statSync(lock).mtimeMs;
    } catch {
      continue;                                // vanished between the open and the read: retry now
    }
    if (deps.now() - acquired > staleMs) {
      deps.onStaleJudged?.();
      const aside = `${lock}.stale-${token}`;
      try {
        fs.renameSync(lock, aside);
      } catch {
        continue;                              // someone else moved or released it
      }
      let moved = '';
      try { moved = fs.readFileSync(aside, 'utf8'); } catch { /* treated as a mismatch */ }
      if (moved === judged) {
        try { fs.unlinkSync(aside); } catch { /* best effort */ }
      } else {
        // We moved a live lock. Put it back unless a newer one exists, then wait like everyone else.
        try {
          if (fs.existsSync(lock)) fs.unlinkSync(aside);
          else fs.renameSync(aside, lock);
        } catch { /* best effort */ }
      }
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
