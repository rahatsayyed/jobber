// src/verify/cli.ts
// `npm run dry-run`: argument parsing, fixture loading, the hermetic dashboard seam and the run itself.
// scripts/dry-run.ts is the thin wiring; everything here takes its dependencies as parameters.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildCtx, exitCodeFor, renderTable, runStages, UsageError, type CtxParts, type Fixtures, type StageResult } from './engine.js';
import { allStages } from './stages.js';

export const BANNER = 'DRY RUN VERIFY: nothing is sent, applied or connected; temp database; your .env is not changed';
export const STAGE_TIMEOUT_MS = 120_000;
export const LLM_TIMEOUT_MS = 10 * 60_000;

export interface CliArgs { llm: boolean; skip: string[]; json: boolean; list: boolean; help: boolean }

/** Throws UsageError on an unknown flag or a missing --skip value. */
export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { llm: false, skip: [], json: false, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--llm') a.llm = true;
    else if (t === '--json') a.json = true;
    else if (t === '--list') a.list = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--skip' || t.startsWith('--skip=')) {
      const v = t === '--skip' ? argv[++i] : t.slice('--skip='.length);
      if (!v || v.startsWith('--')) throw new UsageError('--skip needs a stage id');
      a.skip.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
    } else throw new UsageError(`unknown argument: ${t}`);
  }
  return a;
}

export const USAGE = [
  'usage: npm run dry-run -- [--llm] [--skip <id>[,<id>]] [--json] [--list] [--help]',
  '  --llm    also run the LLM hunt stage in dry mode (off by default)',
  '  --skip   skip the named skippable stages',
  '  --json   print the result as JSON',
  '  --list   list stage ids and whether each can be skipped',
].join('\n');

/** Loads the committed synthetic fixtures; deal-breaker keywords come from config/deal-breakers.json. */
export function loadFixtures(root: string): Fixtures {
  const dir = join(root, 'src', 'verify', 'fixtures');
  const jobs = JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf8')) as Fixtures['jobs'];
  const match = JSON.parse(readFileSync(join(dir, 'match.json'), 'utf8')) as Fixtures['match'];
  const cfg = JSON.parse(readFileSync(join(root, 'config', 'deal-breakers.json'), 'utf8')) as { keywords?: unknown };
  const dealBreakers = Array.isArray(cfg.keywords) ? cfg.keywords.filter((k): k is string => typeof k === 'string') : [];
  return { jobs, match, cleanJobId: 'fixture-clean', dealBreakerJobId: 'fixture-dealbreaker', dealBreakers };
}

/**
 * Starts the production web server module in-process on loopback, port 0, with a temp auth store, a temp
 * read-only data db, in token mode with a temp access token set through the 8C helper (never the real auth
 * store, no network, no real credentials). The token is returned so the dashboard-login stage can log in.
 */
export async function realStartWeb(opts: { port: 0; host: string; tmp: string }): Promise<{ url: string; close(): Promise<void>; token: string }> {
  const [{ startWebServer }, { openAuthStore }, { generateToken, setToken }, { openReadOnlyDb }, { openDb }, { loadOutreachConfig }] = await Promise.all([
    import('../web/server.js'), import('../dash/authStore.js'), import('../dash/accessToken.js'),
    import('../dash/readDb.js'), import('../db.js'), import('../outreach/config.js'),
  ]);
  const dataPath = join(opts.tmp, 'web-data.sqlite');
  openDb(dataPath).close();
  const auth = openAuthStore(join(opts.tmp, 'web-auth.sqlite'));
  // A throwaway token for the throwaway store; it is never printed, stored outside tmp or reused.
  const token = generateToken();
  setToken(auth, token, new Date());
  const data = openReadOnlyDb(dataPath);
  const server = await startWebServer({
    port: opts.port, bind: opts.host, allowRemoteBind: false, allowedHosts: [], trustProxy: false,
    auth, authMode: 'token', data,
    cfg: loadOutreachConfig({}), run: async () => ({ stdout: '', code: 1 }), sessionsToShow: [],
    chat: { enabled: false, session: '', window: '', send: async () => {} },
  });
  const url = `http://${opts.host}:${(server.address() as AddressInfo).port}`;
  return {
    url,
    token,
    close: () => new Promise<void>((res) => {
      server.close(() => {
        try { data.close(); } catch { /* already closed */ }
        try { (auth as unknown as { close?: () => void }).close?.(); } catch { /* already closed */ }
        res();
      });
      server.closeAllConnections?.();
    }),
  };
}

export interface CliDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  parts: Omit<CtxParts, 'root' | 'env' | 'llm' | 'fixtures'> & { fixtures?: () => Fixtures };
  out: (s: string) => void;
  err: (s: string) => void;
  /** Where verify.json goes; default <root>/.jobber (tests pass a temp dir). */
  stateDir?: string;
}

/** The ONE file the CLI writes under root: .jobber/verify.json, mode 600, no details. */
export function writeVerifyFile(dir: string, results: StageResult[], at: Date): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'verify.json');
  const body = {
    at: at.toISOString(),
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skip').length,
    stages: results.map((r) => ({ id: r.id, status: r.status })),
  };
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Runs the CLI and returns the exit code. The env is only copied (JOBBER_KILL removed from the copy). */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    deps.err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.help) { deps.out(USAGE); return 0; }
  const stages = allStages();
  if (args.list) {
    deps.out(stages.map((s) => `${s.id.padEnd(18)} ${s.skippable ? 'skippable' : 'required'}`).join('\n'));
    return 0;
  }
  for (const id of args.skip) {
    const s = stages.find((x) => x.id === id);
    if (!s) { deps.err(`unknown stage: ${id}\n${USAGE}`); return 2; }
    if (!s.skippable) { deps.err(`stage ${id} cannot be skipped`); return 2; }
  }
  if (!args.json) deps.out(BANNER);
  try {
    const ctx = buildCtx({
      ...deps.parts, root: deps.root, env: deps.env, llm: args.llm,
      fixtures: deps.parts.fixtures ?? (() => loadFixtures(deps.root)),
    });
    let results: StageResult[];
    try {
      results = await runStages(stages, ctx, { skip: args.skip, timeoutMs: args.llm ? LLM_TIMEOUT_MS : STAGE_TIMEOUT_MS });
    } finally {
      try { ctx.fs.rm(ctx.tmp); } catch { /* best effort */ }
    }
    writeVerifyFile(deps.stateDir ?? join(deps.root, '.jobber'), results, deps.parts.now());
    deps.out(args.json
      ? JSON.stringify({
        passed: results.filter((r) => r.status === 'pass').length,
        failed: results.filter((r) => r.status === 'fail').length,
        stages: results.map((r) => ({ id: r.id, status: r.status, detail: r.detail })),
      })
      : renderTable(results));
    return exitCodeFor(results);
  } catch (e) {
    if (e instanceof UsageError) { deps.err(e.message); return 2; }
    deps.err(`dry-run internal error: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
    return 1;
  }
}
