// Script-first provider runner (plan 8G task 2). Code, not a model, decides when a source has failed: it threw, timed out,
// returned raw items that no longer match the provider's shape, or drifted (new shape and nothing kept after a run that kept jobs).
// A failed source is recorded with fallback_used and ONE source_tasks row per platform/company per day for an agent operator.
// Jobs a failed provider did return are kept. Called by the scheduler and by list_new_jobs; never by an agent.
import type BetterSqlite3 from 'better-sqlite3';
import type { Job } from '../db.js';
import { fetchBoards, type BoardSample, type FetchBoardsOptions } from './boards/index.js';
import { BOARD_PROVIDERS } from './boards/providers.js';
import type { Ats } from './boards/filters.js';
import type { Provider } from './provider.js';
import { loadRegistry } from './registry.js';
import { checkShape, type ShapeReport } from './shape.js';
import { redactError, statsToOutcomes, type SourceOutcome, type SourceStatusRow } from './status.js';

export type { Provider };
type Db = BetterSqlite3.Database;

export type FailureReason = 'shape' | 'error' | 'drift';
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
/** Consecutive failed runs after which a platform is marked flaky. */
export const FLAKY_STREAK = 3;

export interface RunOptions {
  role: string;
  location?: string;
  isKnown?: (id: string) => boolean;
  /** config/portals.json override (tests). */
  portalsPath?: string;
  /** config/platforms.json override (tests). */
  registryPath?: string;
  /** Provider override per registry id for the API/Naukri sources (tests, fakes). */
  providers?: Record<string, Provider>;
  /** Wall clock for the once-per-day task rule (tests). */
  now?: () => Date;
  /** Hard limit for one API/Naukri provider (default 120 s). Boards keep their own per-board timeout and total budget. */
  providerTimeoutMs?: number;
  /** Extra fetchBoards limits (concurrency, per-company cap, budgets). */
  boardOpts?: Omit<FetchBoardsOptions, 'isKnown' | 'configPath'>;
}

// API and search sources are loaded from a fixed map (registry strings select, they never become import paths).
const API_LOADERS: Record<string, () => Promise<{ provider: Provider }>> = {
  adzuna: () => import('./adzuna.js'),
  remotive: () => import('./remotive.js'),
  remoteok: () => import('./remoteok.js'),
  naukri: () => import('./naukri.js'),
};

interface Failure { platform: string; company: string | null; reason: FailureReason }
interface Prev { kept: number; streak_fail: number; shape_hash: string | null }

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); });
}

const shapeText = (r: ShapeReport): string => `shape: ${r.problems.slice(0, 3).join('; ')}`;

/** Hash change plus zero kept after a run that kept jobs. Needs a stored baseline; a missing one (first run) is never drift. */
function isDrift(prev: Prev | undefined, shape: ShapeReport, kept: number): boolean {
  return !!prev && !!prev.shape_hash && !!shape.hash && shape.hash !== prev.shape_hash && kept === 0 && prev.kept > 0;
}

function queueTask(db: Db, f: Failure, now: Date): boolean {
  const at = now.toISOString();
  const exists = db.prepare('SELECT 1 FROM source_tasks WHERE platform = @platform AND company IS @company AND substr(created_at, 1, 10) = @day').get({ platform: f.platform, company: f.company, day: at.slice(0, 10) });
  if (exists) return false;
  db.prepare('INSERT INTO source_tasks (platform, company, reason, state, created_at, updated_at) VALUES (@platform, @company, @reason, \'queued\', @at, @at)').run({ ...f, at });
  return true;
}

export interface RunResult { jobs: Job[]; rows: SourceStatusRow[]; outcomes: SourceOutcome[] }

export async function runScriptSources(db: Db | null, opts: RunOptions): Promise<RunResult> {
  const now = (opts.now ?? (() => new Date()))();
  const { platforms, errors: registryErrors } = loadRegistry(opts.registryPath);
  for (const e of registryErrors) console.error(`[sources] ${e}`);
  const defs = new Map(platforms.map((p) => [p.id, p]));
  const prevOf = (id: string): Prev | undefined => (db ? (db.prepare('SELECT kept, streak_fail, shape_hash FROM platform_status WHERE id = ?').get(id) as Prev | undefined) : undefined);
  const timeoutMs = opts.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;

  const jobs: Job[] = [];
  const outcomes: SourceOutcome[] = [];
  const failures: Failure[] = [];

  // 1. API and Naukri providers, in parallel; one failing never touches the others.
  const apiDefs = platforms.filter((p) => (p.kind === 'api' || p.kind === 'naukri') && p.tier === 'script' && p.enabled && p.provider);
  const apiResults = await Promise.all(apiDefs.map(async (def) => {
    try {
      const provider = opts.providers?.[def.id] ?? (await API_LOADERS[def.provider as string]?.())?.provider;
      if (!provider) throw new Error(`no provider module for ${def.id}`);
      const r = await withTimeout(provider.fetch({ params: { role: opts.role, location: opts.location }, isKnown: opts.isKnown }), timeoutMs);
      return { def, provider, r };
    } catch (e) {
      console.error(`[sources] ${def.id} failed:`, redactError(e));
      return { def, error: redactError(e) };
    }
  }));
  for (const x of apiResults) {
    const id = x.def.id;
    if ('error' in x) {
      outcomes.push({ id, fetched: 0, kept: 0, error: x.error, fallback_used: true });
      failures.push({ platform: id, company: null, reason: 'error' });
      continue;
    }
    jobs.push(...x.r.jobs);
    const shape = checkShape(x.provider.shapeSpec, x.r.sample);
    const o: SourceOutcome = { id, fetched: x.r.jobs.length, kept: x.r.jobs.length };
    if (!shape.ok) {
      o.error = redactError(shapeText(shape)); o.fallback_used = true;
      failures.push({ platform: id, company: null, reason: 'shape' });
    } else if (isDrift(prevOf(id), shape, o.kept)) {
      o.error = 'drift: the response shape changed and nothing was kept'; o.fallback_used = true;
      failures.push({ platform: id, company: null, reason: 'drift' });
    } else if (shape.hash) {
      o.shape_hash = shape.hash;
    }
    outcomes.push(o);
  }

  // 2. Company boards and aggregators: one fetchBoards call (filters, caps and the 120 s budget stay in there).
  try {
    const r = await fetchBoards({ ...opts.boardOpts, isKnown: opts.isKnown, configPath: opts.portalsPath });
    jobs.push(...r.jobs);
    const vendorOutcomes = statsToOutcomes(r.stats, r.errors);
    const samples: BoardSample[] = r.samples ?? [];
    for (const o of vendorOutcomes) {
      const bp = BOARD_PROVIDERS[o.id as Ats];
      if (!bp) { outcomes.push(o); continue; }
      const mine = samples.filter((s) => s.ats === o.id);
      let failed = false;
      const notes: string[] = [];
      for (const s of mine) {
        if (s.error) {
          if (/time budget exhausted/.test(s.error)) continue;
          failures.push({ platform: o.id, company: s.company, reason: 'error' });
          failed = true;
          continue;
        }
        const rep = checkShape(bp.shapeSpec, s.sample);
        if (!rep.ok) {
          failures.push({ platform: o.id, company: s.company, reason: 'shape' });
          notes.push(`${s.company}: ${shapeText(rep)}`);
          failed = true;
        }
      }
      const combined = checkShape(bp.shapeSpec, mine.flatMap((s) => (s.error ? [] : s.sample)));
      if (!failed && isDrift(prevOf(o.id), combined, o.kept)) {
        failures.push({ platform: o.id, company: null, reason: 'drift' });
        notes.push('drift: the response shape changed and nothing was kept');
        failed = true;
      }
      if (notes.length) o.error = redactError([o.error, ...notes].filter(Boolean).join('; '));
      if (failed) o.fallback_used = true;
      else if (combined.ok && combined.hash) o.shape_hash = combined.hash;
      outcomes.push(o);
    }
  } catch (e) {
    console.error('[sources] boards failed:', redactError(e));
    outcomes.push({ id: 'boards', fetched: 0, kept: 0, error: redactError(e) });
  }

  // 3. Queue the agent fallback (one row per platform/company per day) and mark platforms that keep failing.
  if (db) {
    for (const f of failures) {
      try { queueTask(db, f, now); } catch (e) { console.error('[sources] could not queue a source task:', redactError(e)); }
    }
  }
  for (const o of outcomes) {
    if (o.error && (prevOf(o.id)?.streak_fail ?? 0) + 1 >= FLAKY_STREAK) {
      o.flaky = true;
      o.note = o.note ? `${o.note}; flaky` : 'flaky';
    }
  }

  const rows = outcomes.map((o): SourceStatusRow => {
    const def = defs.get(o.id);
    const fresh = jobs.filter((j) => j.source === o.id && !(opts.isKnown?.(j.id))).length;
    return {
      source: o.id, kind: def?.tier ?? 'script', group: def?.kind ?? 'board',
      fetched: o.fetched, kept: o.kept, new: fresh,
      ...(o.error ? { error: o.error } : {}), fallback_used: o.fallback_used === true,
      ...(o.note ? { note: o.note } : {}), ...(o.flaky ? { flaky: true } : {}),
    };
  });
  return { jobs, rows, outcomes };
}
