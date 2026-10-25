// scripts/scheduler.ts
// Thin CLI over src/scheduler: --daemon, --once, --status, --dry-run-plan. Never prints env values.
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { parseEnv } from '../src/platform/envFile.js';
import { defaultRun } from '../src/platform/tmux.js';
import { redactPane } from '../src/platform/redact.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { ceilings } from '../src/outreach/limits.js';
import { pacingFromConfig } from '../src/outreach/pacing.js';
import { daemonLoop, wakeOnce, type DriverDeps } from '../src/scheduler/driver.js';
import { runCodePass } from '../src/scheduler/pipeline.js';
import { defaultDeps as controlDefaults, readControl } from '../src/scheduler/control.js';
import { countDue } from '../src/scheduler/due.js';
import { tmuxLauncher } from '../src/scheduler/launch.js';
import { fileNotifier } from '../src/scheduler/notify.js';
import { loadPlanKnobs, planWake, type DiscoverSearches } from '../src/scheduler/plan.js';
import { loadDiscoveryConfig } from '../src/linkedin/discoveryConfig.js';
import { loadNaukriDiscoveryConfig } from '../src/naukri/discover.js';
import { loadWellfoundDiscoveryConfig } from '../src/wellfound/discover.js';
import { getState, listRuns } from '../src/scheduler/runLog.js';
import { makeAfterWakeHooks } from '../src/scheduler/hooks.js';
import { parseSchedulerArgs } from '../src/scheduler/args.js';
import { ingestManualRequests } from '../src/manual/ingest.js';
import { finalizeManualRequests } from '../src/manual/report.js';
import { telegramNotifier } from '../src/platform/notify.js';

const projectRoot = resolve(process.cwd());
const root = join(projectRoot, '.jobber');
const stopFile = join(root, 'STOP');
/** Existence only is checked (never read): the Wellfound operator is planned once the owner login has been captured. */
const WELLFOUND_STATE_PATH = join(projectRoot, 'secrets', 'wellfound-state.json');

const safe = (v: unknown): string => redactPane(String(v ?? '')).replace(/\s+/g, ' ').slice(0, 200);

function loadEnv():NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const f = join(projectRoot, '.env');
  if (existsSync(f)) {
    for (const [k, v] of Object.entries(parseEnv(readFileSync(f, 'utf8')))) {
      if (env[k] === undefined) env[k] = v;
    }
  }
  return env;
}

function openReadOnly(): BetterSqlite3.Database {
  return new BetterSqlite3(dbPath(), { readonly: true, fileMustExist: true });
}

function status(env: NodeJS.ProcessEnv): void {
  const db = openReadOnly();
  const ctl = readControl(db, controlDefaults(env, stopFile));
  console.log(`next wake: ${getState(db, 'next_wake_at') ?? 'not set'}`);
  console.log(`usage backoff until: ${getState(db, 'usage_backoff_until') ?? 'none'}`);
  console.log(`next mail drip not before: ${getState(db, 'mail_drip_next_at') ?? 'not set'}`);
  console.log(`kill: ${ctl.killed ? `ON (${safe(ctl.killReason)})` : 'off'}`);
  for (const [p, r] of Object.entries(ctl.halted)) if (r) console.log(`halted ${p}: ${safe(r)}`);
  let open = 0;
  try {
    open = (db.prepare('SELECT count(*) AS n FROM escalations WHERE resolved_at IS NULL').get() as { n: number }).n;
  } catch {
    // table missing: no escalations yet
  }
  console.log(`open escalations: ${open}`);
  console.log('last runs:');
  for (const r of listRuns(db, 10)) {
    console.log(`  ${r.planned_at} ${r.id} ${r.status}${r.stop_reason ? ` (${safe(r.stop_reason)})` : ''} dry=${r.dry_run}`);
  }
  db.close();
}

/** Search names only (never definitions) from config/linkedin-discovery.json and config/naukri-discovery.json, for the discover tasks. */
function discoverNames(): DiscoverSearches {
  const c = loadDiscoveryConfig();
  return {
    jobs: c.jobs.map((j) => j.name), posts: c.posts.map((p) => p.name),
    naukri: loadNaukriDiscoveryConfig().searches.map((s) => s.name),
    // Wellfound is planned only once its owner login exists (secrets/wellfound-state.json): no session, no dispatch.
    wellfound: existsSync(WELLFOUND_STATE_PATH) ? loadWellfoundDiscoveryConfig().searches.map((s) => s.name) : [],
  };
}

function dryRunPlan(env: NodeJS.ProcessEnv): void {
  const db = openReadOnly();
  const now = new Date();
  const cfg = loadOutreachConfig(env);
  const tuning = loadTuning(env);
  const decision = planWake({
    now,
    rng: Math.random,
    pacing: pacingFromConfig(cfg, tuning),
    control: readControl(db, controlDefaults(env, stopFile)),
    ceilings: ceilings(db, cfg, now),
    due: countDue(db, now, tuning, env),
    knobs: loadPlanKnobs(env),
    discoverSearches: discoverNames(),
    codePassEnabled: true,
  });
  console.log(JSON.stringify(decision, null, 2));
  db.close();
}

async function main(): Promise<void> {
  const args = parseSchedulerArgs(process.argv.slice(2));
  const env = loadEnv();
  if (args.mode === 'status') return status(env);
  if (args.mode === 'dry-run-plan') return dryRunPlan(env);
  if (args.mode === 'usage') {
    console.log('usage: scheduler --daemon | --once | --now | --status | --dry-run-plan | --help');
    console.log('note: environment and .env changes are read once at start; restart the daemon to apply them.');
    process.exitCode = args.help ? 0 : 2;
    return;
  }
  const db = openDb();
  const now = (): Date => new Date();
  const cfg = loadOutreachConfig(env);
  const tuning = loadTuning(env);
  const notifier = fileNotifier(join(root, 'notify.jsonl'), now, defaultRun, env.JOBBER_NOTIFY_CMD);
  const deps: DriverDeps = {
    db,
    now,
    rng: Math.random,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    cfg,
    tuning,
    env,
    lockRoot: root,
    stopFile,
    runDir: join(root, 'runs'),
    projectRoot,
    launcher: tmuxLauncher(defaultRun),
    notifier,
    newRunId: () => randomBytes(8).toString('hex'),
    session: env.SCHEDULER_TMUX_SESSION || undefined,
    discoverSearches: discoverNames(),
    codePass: () => runCodePass({ db, now, projectRoot }),
    // The slow email lane beside the wakes (src/scheduler/mailDrip.ts); only the daemon runs it, never --once or --now.
    mailDrip: args.mode === 'daemon',
    manualIngest: (runId) => ingestManualRequests(db, { runId, now }),
    manualReport: async (runStatus) => {
      const tg = telegramNotifier(env);
      const r = await finalizeManualRequests(db, runStatus, {
        now,
        matchThreshold: Number.isInteger(Number(env.MATCH_THRESHOLD)) && env.MATCH_THRESHOLD ? Number(env.MATCH_THRESHOLD) : 60,
        send: async (text) => {
          const sent = await tg.send(text);
          // The text is always kept in the request row; the notify file gets only a title so a missing Telegram setup is visible.
          if (!sent.ok) await notifier.notify({ level: 'warn', title: 'manual request report not delivered to Telegram', detail: sent.detail });
        },
      });
      if (r.reported.length) await notifier.notify({ level: 'info', title: `manual request report sent: ${r.reported.map((i) => `#${i}`).join(' ')}` });
    },
    afterWake: makeAfterWakeHooks({
      db, env, projectRoot, now, pacing: pacingFromConfig(cfg, tuning), notifier,
    }),
  };
  const stop = { stopped: false };
  const halt = (): void => {
    stop.stopped = true;
  };
  process.on('SIGINT', halt);
  process.on('SIGTERM', halt);
  if (args.mode === 'once') {
    const r = await wakeOnce(deps, { force: true, abort: () => stop.stopped });
    console.log(`run ${r.runId}: ${r.status}${r.reason ? ` (${safe(r.reason)})` : ''}; next wake ${r.nextWakeAt}`);
    db.close();
    return;
  }
  await daemonLoop(deps, stop);
  db.close();
}

main().catch((e) => {
  console.error(`scheduler error: ${safe(e instanceof Error ? e.message : 'unknown')}`);
  process.exitCode = 1;
});
