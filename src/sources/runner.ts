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
import { IMPORTED_LOADERS } from './providers/index.js';
import { loadRegistry } from './registry.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPortals, titlePasses } from './boards/filters.js';
import { createGeneratedProvider, type TextFetcher } from './generated/engine.js';
import type { ProviderSpec } from './generated/spec.js';
import { loadRunnable, recordProviderRun } from './generated/store.js';
import { createBrowserTextFetcher } from './generated/browser.js';
import { createWebRuntime, type WebRuntime } from '../webcore/runtime.js';
import { genPromoteN } from './generated/validate.js';
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
  /** Root of the git-ignored generated directory (generated provider specs); tests pass a temp dir. */
  generatedRoot?: string;
  /** Page fetcher per generated spec (tests, fakes); the default is the hardened board transport limited to the spec hosts. */
  generatedFetch?: (spec: ProviderSpec) => TextFetcher | undefined;
  /** Run id for the promotion count (default JOBBER_RUN_ID, SCHEDULER_RUN_ID, else one per process). */
  runId?: string;
  /** Web runtime for html_list generated providers (tests inject a fake-browser runtime; default: a new locked session closed after the pass). */
  webRuntime?: WebRuntime;
  env?: NodeJS.ProcessEnv;
}

const GENERATED_ROOT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), 'generated');
const PROCESS_RUN_ID = `proc-${process.pid}-${Date.now()}`;

// API and search sources are loaded from a fixed map (registry strings select, they never become import paths).
const API_LOADERS: Record<string, () => Promise<{ provider: Provider }>> = {
  remotive: () => import('./remotive.js'),
  remoteok: () => import('./remoteok.js'),
  naukri: () => import('./naukri.js'),
  ...IMPORTED_LOADERS,
};

interface Failure { platform: string; company: string | null; reason: FailureReason }
interface Prev { kept: number; streak_fail: number; shape_hash: string | null }

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); });
}

const shapeText = (r: ShapeReport): string => `shape: ${r.problems.slice(0, 3).join('; ')}`;

// Drift needs ALL of: a stored baseline (a first run is never drift), a changed required-key hash, raw items actually fetched,
// nothing kept now, and jobs kept in the previous run. Zero kept with an unchanged hash is just a strict filter.
function isDrift(prev: Prev | undefined, shape: ShapeReport, rawFetched: number, kept: number): boolean {
  return !!prev && !!prev.shape_hash && !!shape.hash && shape.hash !== prev.shape_hash && rawFetched > 0 && kept === 0 && prev.kept > 0;
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
    } else if (isDrift(prevOf(id), shape, x.r.sample.length, o.kept)) {
      o.error = 'drift: the response shape changed and nothing was kept'; o.fallback_used = true;
      failures.push({ platform: id, company: null, reason: 'drift' });
    } else if (shape.hash) {
      o.shape_hash = shape.hash;
    }
    outcomes.push(o);
  }

  // 1b. Generated providers (declarative specs run by the fixed engine): validated or trusted ones run like any provider, source gen:<id>.
  // Their jobs pass the owner's title filter; a clean run (shape ok, kept > 0, no error) counts toward promotion to trusted.
  const genSpecs = db ? loadRunnable(db, opts.generatedRoot ?? GENERATED_ROOT) : [];
  if (db && genSpecs.length) {
    const env = opts.env ?? process.env;
    const runId = opts.runId ?? env.JOBBER_RUN_ID ?? env.SCHEDULER_RUN_ID ?? PROCESS_RUN_ID;
    const portals = loadPortals(opts.portalsPath).config;
    // html_list pages load in the shared locked web session (O-browser), one provider at a time; json_api uses the board transport.
    let runtime: WebRuntime | null = opts.webRuntime ?? null;
    const genResults: Array<{ spec: ProviderSpec; id: string; provider: Provider; r: { jobs: Job[]; sample: unknown[] } } | { spec: ProviderSpec; id: string; error: string }> = [];
    for (const spec of genSpecs) {
      const id = `gen:${spec.id}`;
      try {
        let fetcher = opts.generatedFetch?.(spec);
        if (!fetcher && spec.kind === 'html_list') fetcher = createBrowserTextFetcher((runtime ??= createWebRuntime({ db, env })), spec);
        const provider = createGeneratedProvider(spec, fetcher);
        const r = await withTimeout(provider.fetch({ params: { role: opts.role, location: opts.location }, isKnown: opts.isKnown }), timeoutMs);
        genResults.push({ spec, id, provider, r });
      } catch (e) {
        console.error(`[sources] ${id} failed:`, redactError(e));
        genResults.push({ spec, id, error: redactError(e) });
      }
    }
    if (runtime && !opts.webRuntime) await (runtime as WebRuntime).close().catch(() => undefined);
    for (const x of genResults) {
      const platform = x.spec.id;
      let clean = false;
      if ('error' in x) {
        outcomes.push({ id: x.id, fetched: 0, kept: 0, error: x.error, fallback_used: true, note: 'generated' });
        failures.push({ platform, company: null, reason: 'error' });
      } else {
        const kept = portals ? x.r.jobs.filter((j) => titlePasses(j.title, portals.title_filter)) : x.r.jobs;
        jobs.push(...kept);
        const shape = checkShape(x.provider.shapeSpec, x.r.sample);
        const o: SourceOutcome = { id: x.id, fetched: x.r.jobs.length, kept: kept.length, note: 'generated' };
        if (!shape.ok) {
          o.error = redactError(shapeText(shape)); o.fallback_used = true;
          failures.push({ platform, company: null, reason: 'shape' });
        } else if (isDrift(prevOf(x.id), shape, x.r.sample.length, o.kept)) {
          o.error = 'drift: the page shape changed and nothing was kept'; o.fallback_used = true;
          failures.push({ platform, company: null, reason: 'drift' });
        } else {
          if (shape.hash) o.shape_hash = shape.hash;
          clean = o.kept > 0;
        }
        outcomes.push(o);
      }
      try { recordProviderRun(db, x.spec.id, { runId, clean, promoteN: genPromoteN(env), now }); } catch (e) { console.error('[sources] could not record a generated run:', redactError(e)); }
    }
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
      if (!failed && isDrift(prevOf(o.id), combined, mine.reduce((n, s) => n + s.sample.length, 0), o.kept)) {
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
    // A fetchBoards throw is a failed provider like any other: fallback_used plus one task for the day.
    outcomes.push({ id: 'boards', fetched: 0, kept: 0, error: redactError(e), fallback_used: true });
    failures.push({ platform: 'boards', company: null, reason: 'error' });
  }

  // 3. Queue the agent fallback (one row per platform/company per day) and mark platforms that keep failing.
  // An API or Naukri source has no board or target URL, so a source task for it could only fail every wake
  // (scout resolveTaskTarget returns null): it gets a note in source_status and no task.
  const noTarget = new Set(apiDefs.map((d) => d.id));
  for (const f of failures) {
    if (f.company === null && noTarget.has(f.platform)) {
      const o = outcomes.find((x) => x.id === f.platform);
      if (o) {
        o.fallback_used = false;
        o.note = o.note ? `${o.note}; no board url: agent fallback not queued` : 'no board url: agent fallback not queued';
      }
      continue;
    }
    if (!db) continue;
    try { queueTask(db, f, now); } catch (e) { console.error('[sources] could not queue a source task:', redactError(e)); }
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
      source: o.id, kind: def?.tier ?? 'script', group: def?.kind ?? (o.id.startsWith('gen:') ? 'generated' : 'board'),
      fetched: o.fetched, kept: o.kept, new: fresh,
      ...(o.error ? { error: o.error } : {}), fallback_used: o.fallback_used === true,
      ...(o.note ? { note: o.note } : {}), ...(o.flaky ? { flaky: true } : {}),
    };
  });
  return { jobs, rows, outcomes };
}
