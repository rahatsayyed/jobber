// scripts/setup.ts
// npm run setup: the guided, resumable setup wizard. Needs a TTY. Never logs argv, env or URLs.
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { ccgramChecks, restrictedChecks } from '../src/platform/checks.js';
import { setupChecks } from '../src/platform/checksSetup.js';
import type { DoctorContext } from '../src/platform/doctor.js';
import { defaultRun } from '../src/platform/tmux.js';
import { userDataDir } from '../src/lib/userData.js';
import { nodeEnvFs } from '../src/setup/envWriter.js';
import { NO_TTY_MESSAGE, USAGE, childEnv, ensureEnvFile, needTty, parseArgs, spawnSuspended } from '../src/setup/cli.js';
import { redactingIO, ttyIO } from '../src/setup/io.js';
import { runSetup, type SetupContext, type SetupFs } from '../src/setup/runner.js';
import { setupGuideChecks } from '../src/platform/checksGuide.js';
import { runChecks } from '../src/platform/doctor.js';
import { GUIDE_CHECK_IDS, configuredSteps, formatStatus, guideReadiness, runGuideOnly } from '../src/setup/guide.js';
import { allDoctorChecks } from '../src/platform/checkLists.js';
import { parseEnv } from '../src/platform/envFile.js';
import { resolveMode, startGuideForMode } from '../src/setup/mode.js';
import { loadState, saveState } from '../src/setup/state.js';
import { ALL_STEPS } from '../src/setup/steps/index.js';
import { initTerm } from '../src/ui/term.js';

interface SqliteDb {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}
type SqliteCtor = new (path: string, opts: { readonly: boolean; fileMustExist: boolean }) => SqliteDb;

const term = initTerm(); // strips --no-color before the parser sees it
const args = parseArgs(process.argv.slice(2));
if (args.error) {
  console.error(args.error);
  console.error(USAGE);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.list) {
  for (const s of ALL_STEPS) console.log(s.id);
  process.exit(0);
}
const root = resolve(import.meta.dirname, '..');
const env = process.env;

const fs: SetupFs = {
  ...nodeEnvFs,
  mkdirp: (p, mode) => {
    mkdirSync(p, { recursive: true, mode });
    chmodSync(p, mode);
  },
  copy: (from, to, mode) => {
    copyFileSync(from, to);
    chmodSync(to, mode);
  },
  list: (p) => (existsSync(p) ? readdirSync(p) : []),
};

function spawnInteractive(
  cmd: string,
  argv: string[],
  opts?: { env?: Record<string, string> },
): Promise<number> {
  return spawnSuspended(
    tty,
    () =>
      new Promise<number>((done) => {
        const child = spawn(cmd, argv, { cwd: root, env: childEnv(env, opts?.env), stdio: 'inherit' });
        child.on('error', () => done(127));
        child.on('close', (code) => done(code ?? 1));
      }),
  );
}

// The Telegram token is in the URL path: never log the URL, and replace any thrown error.
const realFetch: NonNullable<DoctorContext['fetch']> = async (url, init) => {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
  } catch {
    throw new Error('network request failed');
  }
};

const doctor: DoctorContext = {
  root,
  env,
  run: defaultRun,
  fs: {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
    list: (p) => (existsSync(p) ? readdirSync(p) : []),
    mode: (p) => (existsSync(p) ? statSync(p).mode & 0o777 : null),
  },
  fetch: realFetch,
  sqliteTables: (path) => {
    try {
      // Loaded lazily: a native-module ABI mismatch must not stop the wizard or the doctor.
      const Database = createRequire(import.meta.url)('better-sqlite3') as SqliteCtor;
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[];
        return rows.map((r) => r.name);
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  },
  now: () => new Date(),
};

if (args.status) {
  // Read-only: the state file is never written. A step that setup never recorded but whose doctor checks
  // pass (or whose skippable feature is configured) is shown as configured, not pending.
  const sp = join(userDataDir(env, root), '.setup-state.json');
  const probe = { exists: (p: string) => existsSync(p), read: (p: string) => readFileSync(p, 'utf8') };
  const state = loadState(sp, probe);
  // The classifier smoke loads a 750 MB model: left out of a status read (classifier_model still has to pass).
  const light = ALL_STEPS.map((s) => ({ id: s.id, checkIds: s.checkIds.filter((c) => c !== 'classifier_smoke') }));
  const wanted = new Set(light.flatMap((s) => s.checkIds));
  const all = [...ccgramChecks, ...restrictedChecks(), ...setupChecks, ...allDoctorChecks()];
  const seen = new Set<string>();
  const checks = all.filter((c) => wanted.has(c.id) && !seen.has(c.id) && seen.add(c.id));
  let results: Awaited<ReturnType<typeof runChecks>> = [];
  try {
    results = await runChecks(checks, doctor);
  } catch {
    results = [];
  }
  let fileEnv: Record<string, string> = {};
  try {
    const ep = join(root, '.env');
    if (existsSync(ep)) fileEnv = parseEnv(readFileSync(ep, 'utf8'));
  } catch {
    fileEnv = {};
  }
  const configured = configuredSteps({
    steps: light,
    results,
    env: { ...fileEnv, ...env },
    fs: { exists: probe.exists },
    root,
  });
  console.log(formatStatus(ALL_STEPS.map((s) => s.id), state, configured));
  process.exit(0);
}
if (needTty(process.stdin.isTTY, process.stdout.isTTY)) {
  console.error(NO_TTY_MESSAGE);
  process.exit(2);
}

if (args.guideOnly) {
  const c = await runGuideOnly(
    (cmd, argv) =>
      new Promise<number>((done) => {
        const child = spawn(cmd, argv, { cwd: root, env: childEnv(env), stdio: 'inherit' });
        child.on('error', () => done(127));
        child.on('close', (code) => done(code ?? 1));
      }),
  );
  process.exit(c);
}

const now = (): Date => new Date();
const dataDir = userDataDir(env, root);
fs.mkdirp(dataDir, 0o700);

const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');
ensureEnvFile(fs, envPath, examplePath, now);

const tty = ttyIO(process.stdin, process.stdout, { term });
const statePath = join(dataDir, '.setup-state.json');
const ctx: SetupContext = {
  io: redactingIO(tty),
  root,
  env,
  fs,
  run: defaultRun,
  spawnInteractive,
  fetch: realFetch,
  now,
  doctor,
  state: loadState(statePath, fs),
  statePath,
  envPath,
};

let code = 1;
try {
  if (args.redo) delete ctx.state.guide_offered;
  const guideChecks = [...setupChecks, ...setupGuideChecks()].filter((c) => GUIDE_CHECK_IDS.includes(c.id));
  const save = (): void => {
    try {
      saveState(statePath, ctx.state, fs, now);
    } catch {
      ctx.io.say('warning: could not save setup state');
    }
  };
  let readyP: ReturnType<typeof guideReadiness> | undefined;
  const readiness = (): ReturnType<typeof guideReadiness> =>
    (readyP ??= guideReadiness({ run: defaultRun, checks: () => runChecks(guideChecks, doctor) }));
  const interactive = args.step === undefined;
  const mode = await resolveMode({
    io: ctx.io,
    state: ctx.state,
    now,
    save,
    flagMode: args.mode,
    noGuide: args.noGuide === true,
    interactive,
    guideReady: readiness,
  });
  const started = await startGuideForMode({
    io: ctx.io,
    root,
    run: defaultRun,
    state: ctx.state,
    mode,
    noGuide: args.noGuide === true,
    interactive,
    readiness,
    save,
  });
  ctx.mode = started.mode;
  code = await runSetup(ALL_STEPS, ctx, {
    only: args.step,
    redo: args.redo,
    checks: [...ccgramChecks, ...restrictedChecks(), ...setupChecks],
  });
} catch (e) {
  ctx.io.say(`setup stopped: ${(e as Error).message}`);
} finally {
  tty.close();
}
process.exit(code);
