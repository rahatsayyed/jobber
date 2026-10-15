// Doctor checks for layout memory (plan 8B). Registered in scripts/doctor.ts next to the other lists.
// Offline and read-only. No check prints an env value: only ids, counts and dates.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { skip } from './doctor.js';
import { parseEnv } from './envFile.js';
import { loadLayoutConfig, mergeLayoutEnv } from '../layout/config.js';
import { layoutFilePath, summarize, type LayoutSummary } from '../layout/summary.js';
import type { Platform } from '../layout/types.js';
import { CRITICAL } from '../layout/vocab.js';
import { dbPath } from '../dbPath.js';

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, fix?: string): CheckResult => ({ status: 'warn', detail, fix });
const fail = (detail: string, fix?: string): CheckResult => ({ status: 'fail', detail, fix });

const PLATFORMS: readonly Platform[] = ['linkedin', 'naukri'];
const CORRUPT_KEEP_DAYS = 7;
const DAY_MS = 86_400_000;

export interface LayoutCheckDeps {
  /** Read-only database handle for halt flags; null or a throw means "no database". */
  db?: () => BetterSqlite3.Database | null;
}

function defaultDb(): BetterSqlite3.Database | null {
  try {
    const p = dbPath();
    if (p === ':memory:' || !existsSync(p)) return null;
    // Loaded lazily: a native-module ABI mismatch must not stop the doctor.
    const Ctor = createRequire(import.meta.url)('better-sqlite3') as new (
      path: string, opts: { readonly: boolean; fileMustExist: boolean }) => BetterSqlite3.Database;
    return new Ctor(p, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function mergedEnv(ctx: DoctorContext): NodeJS.ProcessEnv {
  const file = join(ctx.root, '.env');
  let fromFile: Record<string, string> = {};
  try {
    if (ctx.fs.exists(file)) fromFile = parseEnv(ctx.fs.read(file));
  } catch {
    fromFile = {};
  }
  // process env over .env, like the daemon; LAYOUT_* merged by the shared helper
  const base: NodeJS.ProcessEnv = { ...ctx.env };
  if (base.SCHEDULER_ENABLED === undefined && fromFile.SCHEDULER_ENABLED !== undefined) {
    base.SCHEDULER_ENABLED = fromFile.SCHEDULER_ENABLED;
  }
  return mergeLayoutEnv(base, fromFile);
}

// `corrupt` files are named <file>.corrupt-<iso with - for : and .>[-n]; returns the age in days or null.
function corruptAgeDays(name: string, now: Date): number | null {
  const m = /\.corrupt-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? null : (now.getTime() - t) / DAY_MS;
}

interface Loaded { cfg: ReturnType<typeof loadLayoutConfig>; sums: LayoutSummary[]; now: Date; env: NodeJS.ProcessEnv }

export function layoutChecks(deps: LayoutCheckDeps = {}): Check[] {
  const openDb = deps.db ?? defaultDb;
  const load = (ctx: DoctorContext): Loaded => {
    const env = mergedEnv(ctx);
    const cfg = loadLayoutConfig(env, ctx.root);
    const now = ctx.now?.() ?? new Date();
    let db: BetterSqlite3.Database | null = null;
    try { db = openDb(); } catch { db = null; }
    const read = (p: string): string | null => {
      try { return ctx.fs.exists(p) ? ctx.fs.read(p) : null; } catch { return null; }
    };
    const sums = PLATFORMS.map((p) => summarize(p, cfg, now, db ?? undefined, read));
    return { cfg, sums, now, env };
  };

  return [
    {
      id: 'layout_store',
      title: 'layout: memory files valid and private',
      async run(ctx) {
        const { cfg, sums, now } = load(ctx);
        const bad = sums.filter((s) => s.present && !s.valid);
        if (bad.length > 0) {
          return fail(
            bad.map((s) => `${s.platform}: ${s.why ?? 'invalid'}`).join('; '),
            'npm run layout -- reset <platform> (the runtime also quarantines a corrupt file on next load)',
          );
        }
        const dirMode = ctx.fs.mode(cfg.dir);
        const names = ctx.fs.list ? ctx.fs.list(cfg.dir) : [];
        if (!sums.some((s) => s.present) && dirMode === null && names.length === 0) {
          return skip('no layout memory yet (created on first observation)');
        }
        const warns: string[] = [];
        if (dirMode !== null && (dirMode & 0o077) !== 0) warns.push(`layout dir mode ${dirMode.toString(8)} is open to group or others`);
        const old = names.filter((n) => (corruptAgeDays(n, now) ?? 0) > CORRUPT_KEEP_DAYS);
        if (old.length > 0) warns.push(`${old.length} .corrupt file(s) older than ${CORRUPT_KEEP_DAYS} days`);
        if (warns.length > 0) {
          return warn(warns.join('; '), `chmod 700 ${cfg.dir}; review or remove old ${layoutFilePath(cfg, 'linkedin').replace(/linkedin\.json$/, '')}*.corrupt-* files`);
        }
        return pass(`${sums.filter((s) => s.present).length} file(s) valid, under ${cfg.maxBytes} bytes`);
      },
    },
    {
      id: 'layout_age',
      title: 'layout: memory fresh and promoted',
      async run(ctx) {
        const { cfg, sums, env } = load(ctx);
        if (env.SCHEDULER_ENABLED === 'false') return skip('scheduler disabled (SCHEDULER_ENABLED=false)');
        const stale = sums.filter((s) => s.valid && s.present && s.age_days !== null && s.age_days > cfg.staleDays);
        const unpromoted = sums.filter((s) => !s.present || s.kinds.length === 0 || s.kinds.every((k) => k.state === 'learning'));
        const parts: string[] = [];
        for (const s of stale) parts.push(`${s.platform}: memory ${s.age_days} days old (stale after ${cfg.staleDays})`);
        for (const s of unpromoted) parts.push(`${s.platform}: no promoted layout yet`);
        for (const s of sums) if (s.present && !s.valid) parts.push(`${s.platform}: invalid memory`);
        return parts.length === 0
          ? pass('memory is current and promoted for both platforms')
          : warn(parts.join('; '), 'run a supervised wake so the operator re-observes; see npm run layout -- learn <platform>');
      },
    },
    {
      id: 'layout_drift',
      title: 'layout: no drift',
      async run(ctx) {
        const { sums } = load(ctx);
        const halted = sums.filter((s) => s.halted_for_layout);
        if (halted.length > 0) {
          return fail(
            `halted for layout drift: ${halted.map((s) => s.platform).join(', ')}`,
            'inspect with npm run layout -- status, fix or reset the kind, then npm run layout -- clear-halt <platform>',
          );
        }
        const drifting = sums.flatMap((s) => s.kinds.filter((k) => k.drift_streak > 0).map((k) => `${s.platform}/${k.kind} streak ${k.drift_streak}`));
        return drifting.length > 0
          ? warn(`drift streak: ${drifting.join('; ')}`, 'npm run layout -- show <platform>')
          : pass('no drift streaks');
      },
    },
    {
      id: 'layout_enforce',
      title: 'layout: enforcement mode',
      async run(ctx) {
        const { cfg, sums } = load(ctx);
        if (cfg.enforce !== 'warn') return pass(`LAYOUT_ENFORCE=${cfg.enforce}`);
        const unready: string[] = [];
        for (const s of sums) {
          for (const kindId of Object.keys(CRITICAL[s.platform])) {
            const k = s.kinds.find((x) => x.kind === kindId);
            if (!k || k.state !== 'stable' || k.drift_streak !== 0 || k.drift_total !== 0) unready.push(`${s.platform}/${kindId}`);
          }
        }
        if (unready.length > 0) return pass(`warn mode; not ready to enforce yet: ${unready.join(', ')}`);
        return warn(
          'every critical kind is stable with zero drift: warn mode can be tightened',
          'set LAYOUT_ENFORCE=enforce in .env and restart the sessions',
        );
      },
    },
  ];
}
