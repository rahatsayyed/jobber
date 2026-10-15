// src/verify/engine.ts
// Dry-run stage engine: forced dry env, temp dir and temp stop file, per-stage timeout, table output.
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { Run } from '../platform/tmux.js';
import type { CheckOutcome } from '../platform/doctor.js';

export type StageStatus = 'pass' | 'fail' | 'skip';
export interface StageResult { id: string; title: string; status: StageStatus; detail: string; fix?: string; ms: number }
export interface StageOutcome { status: StageStatus; detail: string; fix?: string }
export interface Stage {
  id: string;
  title: string;
  skippable: boolean;
  run(ctx: VerifyCtx): Promise<StageOutcome>;
}

export interface FixtureJob {
  id: string; source: string; title: string; company: string; url: string; apply_url: string; description: string;
}
export interface FixtureMatch {
  job_id: string; score: number; reasons: string; missing_keywords: string[];
  location_verdict?: 'PASS' | 'FAIL' | 'FLAG'; language_gate?: 'PASS' | 'FAIL' | 'FLAG';
}
/** Parsed src/verify/fixtures/*.json (created in Task 11); stages never read the files themselves. */
export interface Fixtures {
  jobs: FixtureJob[];
  match: FixtureMatch[];
  cleanJobId: string;
  dealBreakerJobId: string;
  /** Deal-breaker keywords used instead of config/deal-breakers.json, so the stage is hermetic. */
  dealBreakers: string[];
}

export interface VerifyFs {
  mkdtemp(prefix: string): string;
  mkdir(path: string): void;
  write(path: string, data: string): void;
  exists(path: string): boolean;
  /** Optional: read a text file (used by the llm-hunt dry check). */
  read?(path: string): string;
  rm(path: string): void;
}

export interface VerifyCtx {
  root: string;
  env: NodeJS.ProcessEnv; // already forced dry
  tmp: string;
  tempDbPath: string;
  tempStopFile: string;
  run: Run;
  fs: VerifyFs;
  now: () => Date;
  doctor(): Promise<CheckOutcome[]>;
  openDb(path: string): BetterSqlite3.Database;
  startWeb(opts: { port: 0; host: string; tmp: string }): Promise<{ url: string; close(): Promise<void> }>;
  fixtures(): Fixtures;
  /** HTTP seam for the dashboard stage (default global fetch against loopback). */
  fetch?: (url: string) => Promise<{ status: number; text(): Promise<string> }>;
  /** Enables the llm-hunt stage. */
  llm?: boolean;
}

export function forceDryEnv(env: NodeJS.ProcessEnv, dbPath: string): NodeJS.ProcessEnv {
  if (!dbPath) throw new Error('forceDryEnv: dbPath is required');
  const out: NodeJS.ProcessEnv = { ...env };
  out.JOBBER_DRY_RUN = '1';
  out.SCHEDULER_DRY_RUN = 'true';
  out.LINKEDIN_DRY_RUN = 'true';
  out.JOBAPPLIER_DB = dbPath;
  delete out.JOBBER_KILL;
  return out;
}

export class UsageError extends Error {}

export type CtxParts = Omit<VerifyCtx, 'tmp' | 'tempDbPath' | 'tempStopFile'>;

/** Builds the ctx: creates the temp dir, forces the dry env, memoizes doctor. */
export function buildCtx(parts: CtxParts): VerifyCtx {
  const tmp = parts.fs.mkdtemp('jobber-verify-');
  const tempDbPath = join(tmp, 'verify.sqlite');
  const tempStopFile = join(tmp, '.jobber', 'STOP');
  let memo: Promise<CheckOutcome[]> | undefined;
  const doctor = (): Promise<CheckOutcome[]> => (memo ??= parts.doctor());
  return { ...parts, doctor, env: forceDryEnv(parts.env, tempDbPath), tmp, tempDbPath, tempStopFile };
}

export async function runStages(
  stages: Stage[], ctx: VerifyCtx, opts: { skip: string[]; timeoutMs: number },
): Promise<StageResult[]> {
  for (const id of opts.skip) {
    const s = stages.find((x) => x.id === id);
    if (s && !s.skippable) throw new UsageError(`stage ${id} cannot be skipped`);
  }
  // A timed-out stage is reported as fail but not cancelled; its promise keeps running.
  const out: StageResult[] = [];
  for (const s of stages) {
    if (opts.skip.includes(s.id)) {
      out.push({ id: s.id, title: s.title, status: 'skip', detail: 'skipped by request', ms: 0 });
      continue;
    }
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let r: StageOutcome;
    try {
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs);
      });
      r = await Promise.race([s.run(ctx), timeout]);
    } catch (e) {
      r = { status: 'fail', detail: `stage error: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
    out.push({ id: s.id, title: s.title, ...r, ms: Date.now() - t0 });
  }
  return out;
}

export function exitCodeFor(r: StageResult[]): 0 | 1 {
  return r.some((x) => x.status === 'fail') ? 1 : 0;
}

export function renderTable(r: StageResult[]): string {
  const lines: string[] = [];
  for (const x of r) {
    lines.push(`${x.status.toUpperCase().padEnd(4)}  ${x.title}  ${x.detail}`.trimEnd());
    if (x.status === 'fail' && x.fix) lines.push(`      fix: ${x.fix}`);
  }
  return lines.join('\n');
}
