// scripts/scheduler.ts
// Thin CLI over src/scheduler: --daemon, --once, --status, --dry-run-plan. Never prints env values.
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { matchThresholdFromEnv } from '../src/matchRubric.js';
import { dbPath } from '../src/dbPath.js';
import { parseEnv } from '../src/platform/envFile.js';
import { defaultRun, JOBBER_TMUX_SESSION } from '../src/platform/tmux.js';
import { WindowDispatcher } from '../src/scheduler/windowDispatch.js';
import { redactPane } from '../src/platform/redact.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { ceilings } from '../src/outreach/limits.js';
import { inQuietHours, quietFromConfig } from '../src/outreach/quiet.js';
import { stopActive } from './killSwitch.js';
import { configReader, windowTick } from '../src/scheduler/windowTick.js';
import { daemonLoop, type DriverDeps } from '../src/scheduler/driver.js';
import { runCodePass } from '../src/scheduler/pipeline.js';
import { defaultDeps as controlDefaults, readControl } from '../src/scheduler/control.js';
import { countDue } from '../src/scheduler/due.js';
import { stallMsFromEnv } from '../src/scheduler/budget.js';
import { killLegacyWindows, makeEnsureReady } from '../src/scheduler/windowReady.js';
import { readWakeResult, requestWake } from '../src/scheduler/wakeRequest.js';
import { fileNotifier } from '../src/scheduler/notify.js';
import { loadPlanKnobs, planWake, type DiscoverSearches } from '../src/scheduler/plan.js';
import { loadDiscoveryConfig } from '../src/linkedin/discoveryConfig.js';
import { loadNaukriDiscoveryConfig } from '../src/naukri/discover.js';
import { loadWellfoundDiscoveryConfig } from '../src/wellfound/discover.js';
import { getState, listRuns } from '../src/scheduler/runLog.js';
import { makeAfterWakeHooks } from '../src/scheduler/hooks.js';
import { parseSchedulerArgs } from '../src/scheduler/args.js';
import { ingestManualRequests } from '../src/manual/ingest.js';
import { linkedinActiveNow } from '../src/linkedin/activeHours.js';
import { finalizeManualRequests } from '../src/manual/report.js';
import { telegramNotifier } from '../src/platform/notify.js';
import { linkedinDripEnabled, linkedinDripStatus, renderLinkedinDripLines } from '../src/scheduler/linkedinDrip.js';
import { escalationDigestTick } from '../src/scheduler/escalationDigest.js';

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
  console.log(`next linkedin drip not before: ${getState(db, 'linkedin_drip_next_at') ?? 'not set'}`);
  for (const l of renderLinkedinDripLines(linkedinDripStatus(db, env, { now: new Date(), tuning: loadTuning(env) }), new Date())) console.log(l);
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
    quiet: quietFromConfig(cfg),
    control: readControl(db, controlDefaults(env, stopFile)),
    ceilings: ceilings(db, cfg, now),
    due: countDue(db, now, tuning, env),
    knobs: loadPlanKnobs(env),
    discoverSearches: discoverNames(),
    codePassEnabled: true,
    linkedinDrip: linkedinDripEnabled(env),
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
    console.log('note: --once and --now only ask the running scheduler daemon for one wake (npm run up starts it); nothing runs headless.');
    console.log('note: environment and .env changes are read once at start; restart the daemon to apply them.');
    process.exitCode = args.help ? 0 : 2;
    return;
  }
  const db = openDb();
  const now = (): Date => new Date();
  const cfg = loadOutreachConfig(env);
  const tuning = loadTuning(env);
  const dispatchSession = env.SCHEDULER_TMUX_SESSION || JOBBER_TMUX_SESSION;
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
    projectRoot,
    notifier,
    // Code-sent notices to the wakes, alerts, mail and linkedin topics (zero LLM); a missing Telegram setup just returns not ok.
    // `silent` is optional: unset means the topic default (wakes, mail and linkedin silent, alerts loud); see src/telegram/silent.ts noticeUrgency.
    tg: async (topic, text, opts) => {
      const silent = (opts as { silent?: boolean } | undefined)?.silent;
      await telegramNotifier(env).send(text, { topic, ...(opts?.html ? { html: true } : {}), ...(typeof silent === 'boolean' ? { silent } : {}) });
    },
    newRunId: () => randomBytes(8).toString('hex'),
    session: env.SCHEDULER_TMUX_SESSION || undefined,
    discoverSearches: discoverNames(),
    codePass: () => runCodePass({ db, now, projectRoot }),
    // The slow email lane beside the wakes (src/scheduler/mailDrip.ts); only the daemon runs it, never --once or --now.
    mailDrip: args.mode === 'daemon',
    // The dispatcher of the long-lived worker windows: the ONLY way work reaches a model (mail drip, LinkedIn drip, reply check, wake steps).
    // A missing window is started through the manager path (ensureReady) before an item is typed; there is no headless fallback.
    windows: new WindowDispatcher({
      root: projectRoot, session: dispatchSession, run: defaultRun, db, killed: () => stopActive(projectRoot, env).stopped,
      stallMs: stallMsFromEnv(env),
      ensureReady: makeEnsureReady({ root: projectRoot, env, run: defaultRun }),
    }),
    // One-time cleanup at start of the leftover wake-* / drip-* windows of the retired headless design.
    cleanupLegacyWindows: async () => { await killLegacyWindows(defaultRun, dispatchSession); },
    // The slow LinkedIn lane (src/scheduler/linkedinDrip.ts); daemon only. LINKEDIN_DRIP=false turns it off and wakes plan LinkedIn again.
    linkedinDrip: args.mode === 'daemon',
    // New escalations go to the owner's Telegram as a batched digest (at most one per 15 minutes); the daemon only.
    escalationDigest: args.mode === 'daemon' ? escalationDigestTick(db, env, quietFromConfig(cfg), now) : undefined,
    // Handoff reminders and window recycle (src/scheduler/windowTick.ts); the daemon only. Zero LLM calls.
    windowTick: args.mode === 'daemon' ? windowTick({
      root: projectRoot, env, run: defaultRun, config: configReader(projectRoot),
      killed: () => stopActive(projectRoot, env).stopped,
      inQuiet: () => inQuietHours(now(), quietFromConfig(cfg)),
      alert: (text, o) => telegramNotifier(env).send(text, { topic: 'alerts', html: true, ...(o?.silent !== undefined ? { silent: o.silent } : {}) }),
    }) : undefined,
    manualIngest: (runId) => ingestManualRequests(db, { runId, now }),
    manualReport: async (runStatus) => {
      const tg = telegramNotifier(env);
      const r = await finalizeManualRequests(db, runStatus, {
        now,
        matchThreshold: matchThresholdFromEnv(env),
        send: async (text) => {
          const sent = await tg.send(text, { topic: 'inbox', html: true, silent: false }); // the owner should look: loud
          // The text is always kept in the request row; the notify file gets only a title so a missing Telegram setup is visible.
          if (!sent.ok) {
            await notifier.notify({ level: 'warn', title: 'manual request report not delivered to Telegram', detail: sent.detail });
            throw new Error('telegram send failed'); // the request stays running and the next wake retries
          }
        },
        platformActive: (p) => {
          const ctl = readControl(db, controlDefaults(env, stopFile));
          if (!ctl.allowed.includes(p as never)) return p === 'manual';
          if (p === 'linkedin') return linkedinActiveNow(env, now());
          if (p === 'wellfound') return existsSync(WELLFOUND_STATE_PATH);
          return true;
        },
      });
      if (r.reported.length) await notifier.notify({ level: 'info', title: `manual request report sent: ${r.reported.map((i) => `#${i}`).join(' ')}` });
    },
    afterWake: makeAfterWakeHooks({
      db, env, projectRoot, now, quiet: quietFromConfig(cfg), notifier,
    }),
  };
  const stop = { stopped: false };
  const halt = (): void => {
    stop.stopped = true;
  };
  process.on('SIGINT', halt);
  process.on('SIGTERM', halt);
  if (args.mode === 'once') {
    // No headless forced wake: this only asks the RUNNING scheduler daemon to run one wake through the windows (src/scheduler/wakeRequest.ts).
    const req = requestWake(db, root, now());
    if (!req.ok) {
      console.error(req.message);
      db.close();
      process.exitCode = 3;
      return;
    }
    console.log(`wake requested (${req.request.id}): the scheduler daemon runs it through the windows within about 30 seconds; every wake gate still applies (kill switch, halts, quiet hours, ceilings, nothing due).`);
    const prev = readWakeResult(db);
    console.log(`watch it: /working (Telegram) or npx tsx scripts/status.ts working; last request result: ${prev ? `${prev.status}${prev.reason ? ` (${safe(prev.reason)})` : ''}` : 'none yet'}`);
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
