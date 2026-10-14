// scripts/auto-update.ts
// Flags: --tick (scheduler hook), --now (owner triggered), --dry-run, --status, --now-internal (detached child).
// Environment values (including .env) are used for config and the notifier only and never printed.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultExec } from '../src/lib/exec.js';
import { snapshotDb } from '../src/lib/sqliteSnapshot.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { parseEnv } from '../src/platform/envFile.js';
import { consoleNotifier, telegramNotifier, type Notifier } from '../src/platform/notify.js';
import { applyUpdate, type ApplyDeps } from '../src/update/apply.js';
import { sanitizeLine } from '../src/update/notes.js';
import { loadUpdateConfig } from '../src/update/config.js';
import { gatherFacts } from '../src/update/git.js';
import { runLock } from '../src/update/lockAdapter.js';
import { runUpdate } from '../src/update/run.js';
import type { QuietWindow } from '../src/update/schedule.js';
import { nodeStateFs, readState, writeState, type UpdateState } from '../src/update/state.js';
import type { KnownFailures } from '../src/update/verify.js';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const IST_OFFSET_MIN = 330;

function mergedEnv(): NodeJS.ProcessEnv {
  let fromFile: Record<string, string> = {};
  try {
    const p = join(root, '.env');
    if (existsSync(p)) fromFile = parseEnv(readFileSync(p, 'utf8'));
  } catch {
    // unreadable .env: continue with the process environment
  }
  return { ...fromFile, ...process.env };
}

function quietWindow(env: NodeJS.ProcessEnv): QuietWindow {
  const c = loadOutreachConfig(env);
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 24;
  let startHour = ok(c.quietStartHour) ? c.quietStartHour : 1;
  let endHour = ok(c.quietEndHour) ? c.quietEndHour : 7;
  if (startHour === endHour) {
    console.warn('auto-update: QUIET_HOURS_START equals QUIET_HOURS_END; using defaults 1 and 7');
    startHour = 1;
    endHour = 7;
  }
  return { startHour, endHour, tzOffsetMinutes: IST_OFFSET_MIN };
}

function loadKnownFailures(): KnownFailures {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'config', 'update-known-failures.json'), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: KnownFailures = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function status(env: NodeJS.ProcessEnv): number {
  const cfg = loadUpdateConfig(env);
  const st = readState(nodeStateFs, root);
  console.log(`enabled: ${cfg.enabled}`);
  console.log(`last good commit: ${st.last_good_commit ?? 'none'}`);
  console.log(`next run: ${st.next_run_at ?? 'unscheduled'}`);
  const r = st.last_result;
  console.log(r ? `last result: ${r.outcome} at ${r.at}${r.reason ? ` (${r.reason})` : ''}` : 'last result: none');
  if (st.in_progress) console.log(`in progress: ${st.in_progress.from.slice(0, 12)}..${st.in_progress.to.slice(0, 12)} since ${st.in_progress.started_at}`);
  if (cfg.problems.length > 0) console.log(`config problems: ${cfg.problems.join('; ')}`);
  return 0;
}

async function main(): Promise<number> {
  const env = mergedEnv();
  if (args.has('--status')) return status(env);

  const cfg = loadUpdateConfig(env);
  const exec = defaultExec;
  const now = () => new Date();
  const state = {
    load: (): UpdateState => readState(nodeStateFs, root),
    save: (s: UpdateState): void => writeState(nodeStateFs, root, s),
  };
  const baseNotifier = telegramNotifier(env);
  const notify: Notifier = {
    async send(text) {
      const r = await baseNotifier.send(text);
      if (r.ok) return r;
      // Telegram unavailable: print the same text so the scheduler log has it.
      await consoleNotifier.send(text);
      return r;
    },
  };

  const fs: ApplyDeps['fs'] = {
    read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
    exists: (p) => existsSync(p),
    mkdtemp: (prefix) => mkdtempSync(join(tmpdir(), prefix), { mode: 0o700 }),
    rmrf: (p) => rmSync(p, { recursive: true, force: true }),
    mkdirp: (p) => { mkdirSync(p, { recursive: true, mode: 0o700 }); },
    copy: (from, to) => {
      mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 });
      copyFileSync(from, to);
    },
  };
  const dbPath = join(root, 'data.sqlite');
  const applyDeps: ApplyDeps = {
    exec, root, now, fs, state,
    snapshotDb: (dest) => snapshotDb(dbPath, dest),
    knownFailures: loadKnownFailures(),
    notify, dbPath,
  };

  const tick = args.has('--tick') || args.has('--now-internal');
  const dryRun = args.has('--dry-run');
  if (!tick && !args.has('--now') && !dryRun) {
    console.error('usage: auto-update (--tick | --now | --dry-run | --status)');
    return 2;
  }

  const detachable = args.has('--tick') && !args.has('--now-internal');
  const detach = detachable
    ? () =>
        new Promise<void>((res, rej) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', join(root, 'scripts', 'auto-update.ts'), '--now-internal'],
            { detached: true, stdio: 'ignore', cwd: root, env: process.env },
          );
          child.once('error', () => rej(new Error('could not start the detached update run')));
          child.once('spawn', () => {
            child.unref();
            res();
          });
        })
    : undefined;

  const result = await runUpdate(
    {
      cfg, exec, root, now, rng: Math.random,
      lock: runLock(join(root, '.jobber')),
      notify,
      apply: (plan, o) => applyUpdate(applyDeps, plan, o),
      gather: () => gatherFacts(exec, cfg, root),
      state, quiet: quietWindow(env), detach,
    },
    { mode: tick ? 'tick' : 'now', dryRun },
  );
  console.log(`auto-update: ${result.outcome}${result.detail ? ` (${result.detail})` : ''}`);
  return ['rolled_back', 'rollback_failed', 'error'].includes(result.outcome) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  async (e: unknown) => {
    console.error('auto-update: unexpected failure');
    try {
      const name = e instanceof Error ? sanitizeLine(e.name, 40) : 'error';
      await telegramNotifier(mergedEnv()).send(`Jobber update error\nreason: unexpected failure (${name})`);
    } catch {
      // nothing more to do
    }
    process.exit(1);
  },
);
