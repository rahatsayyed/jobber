// src/stack/up.ts
// `up`: preflight (kill switch, doctor), mode banner, ordered idempotent start of the whole stack.
// It never resumes a stop, never writes a mode flag, never touches halts or permission sets.
import { join } from 'node:path';
import type { CheckOutcome } from '../platform/doctor.js';
import { parseEnv } from '../platform/envFile.js';
import { ensureManagerWindow, loadManagerConfig, sessionName, startWindow } from '../platform/manager.js';
import { assertName, hasSession, listWindows, newWindow, type Run } from '../platform/tmux.js';
import { stopActive } from '../../scripts/killSwitch.js';
import { DEFAULT_LABEL, SERVICE_NAME } from '../scheduler/units.js';
import { currentMode, fileFlags, shellDivergence } from './mode.js';
import { cleanEnvArgv, DEFAULT_STACK_SESSION, SCHEDULER_CMD, WEB_CMD, type UpPlan } from './plan.js';

export { currentMode } from './mode.js';
export type { UpPlan } from './plan.js';

export interface StackFs {
  exists(path: string): boolean;
  read(path: string): string;
}

export interface StackDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  run: Run;
  fs: StackFs;
  now: () => Date;
  doctor(): Promise<CheckOutcome[]>;
  say(l: string): void;
  sleep(ms: number): Promise<void>;
  // Loopback GET; a 200 or 401 status counts as up.
  probe(url: string): Promise<boolean>;
}

const PROBE_SECONDS = 20;

function readFileEnv(deps: StackDeps): Record<string, string> {
  const f = join(deps.root, '.env');
  try {
    if (deps.fs.exists(f)) return parseEnv(deps.fs.read(f));
  } catch {
    // unreadable: treated as empty
  }
  return {};
}

export function mergedEnv(deps: StackDeps): NodeJS.ProcessEnv {
  return { ...readFileEnv(deps), ...deps.env };
}

export function stackSession(env: NodeJS.ProcessEnv): string {
  const s = (env.STACK_TMUX_SESSION ?? '').trim() || DEFAULT_STACK_SESSION;
  assertName(s);
  return s;
}

export async function unitLoaded(run: Run): Promise<string | null> {
  const l = await run('launchctl', ['list']);
  if (l.code === 0 && l.stdout.includes(DEFAULT_LABEL)) return `launchd unit ${DEFAULT_LABEL}`;
  const s = await run('systemctl', ['--user', 'is-active', SERVICE_NAME]);
  if (s.code === 0 && s.stdout.trim() === 'active') return `systemd unit ${SERVICE_NAME}`;
  return null;
}

export async function windowNames(run: Run, session: string): Promise<Set<string>> {
  return new Set((await listWindows(run, session)).map((w) => w.name));
}

function webUrl(env: NodeJS.ProcessEnv): string {
  const raw = (env.WEB_PORT ?? '').trim();
  const port = /^\d+$/.test(raw) && Number(raw) >= 1024 && Number(raw) <= 65535 ? Number(raw) : 8787;
  return `http://127.0.0.1:${port}`;
}

function lastVerify(deps: StackDeps): string {
  const f = join(deps.root, '.jobber', 'verify.json');
  try {
    if (!deps.fs.exists(f)) return 'dry-run: no result yet (npm run dry-run)';
    const v = JSON.parse(deps.fs.read(f)) as Record<string, unknown>;
    const n = (k: string): number => (typeof v[k] === 'number' ? (v[k] as number) : 0);
    return `dry-run: last ${String(v.at ?? 'unknown time')} passed ${n('passed')} failed ${n('failed')} skipped ${n('skipped')}`;
  } catch {
    return 'dry-run: result file unreadable';
  }
}

export async function planUp(deps: StackDeps): Promise<UpPlan> {
  const env = mergedEnv(deps);
  const session = stackSession(env);
  const names = await windowNames(deps.run, session);
  const running: Record<string, boolean> = { scheduler: names.has('scheduler'), web: names.has('web') };
  const notes: string[] = [];
  const wouldStart: string[] = [];
  const unit = await unitLoaded(deps.run);
  if (env.SCHEDULER_ENABLED === 'false') notes.push('scheduler disabled (SCHEDULER_ENABLED=false)');
  else if (unit) notes.push(`scheduler runs as a ${unit}`);
  else if (!running.scheduler) wouldStart.push('scheduler');
  if (!running.web) wouldStart.push('web');
  return { session, running, wouldStart, notes };
}

function table(rows: Array<[string, string, string]>): string[] {
  const w = [0, 0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => `  ${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2]}`);
}

async function startStackWindow(
  deps: StackDeps, session: string, name: string, argv: string[],
): Promise<void> {
  if (await hasSession(deps.run, session)) {
    await newWindow(deps.run, session, name, argv, deps.root);
    return;
  }
  const r = await deps.run('tmux', ['new-session', '-d', '-s', session, '-n', name, '-c', deps.root, '--', ...argv]);
  if (r.code !== 0) throw new Error(`failed to create tmux session ${session}`);
}

async function inner(deps: StackDeps, env: NodeJS.ProcessEnv, status: boolean): Promise<number> {
  const say = deps.say;
  const session = stackSession(env);
  const daemonSession = (env.CCGRAM_DAEMON_SESSION ?? '').trim() || 'ccgram-daemon';
  const rows: Array<[string, string, string]> = [];
  const warnings: string[] = [];
  const started: string[] = [];
  const kill = stopActive(deps.root, env);
  let cfg;
  try {
    cfg = loadManagerConfig(deps.fs.read(join(deps.root, 'config', 'manager-windows.json')));
  } catch (e) {
    warnings.push(`manager config unreadable: ${(e as Error).message}`);
  }

  if (!status) {
    if (kill.stopped) {
      say('kill switch is on: `npm run jobber:control -- resume` when you are sure');
      return 4;
    }
    const outcomes = await deps.doctor();
    const fails = outcomes.filter((o) => o.result.status === 'fail');
    for (const o of outcomes.filter((x) => x.result.status === 'warn')) say(`warn ${o.id}: ${o.result.detail}`);
    if (fails.length > 0) {
      say('doctor has failures, nothing was started:');
      for (const o of fails) say(`  fail ${o.id}: ${o.result.detail}${o.result.fix ? ` (fix: ${o.result.fix})` : ''}`);
      return 1;
    }

    // Bridge.
    if ((env.TELEGRAM_BOT_TOKEN ?? '') === '') {
      say('bridge: skipped (TELEGRAM_BOT_TOKEN not set)');
    } else {
      const r = await deps.run('bash', ['scripts/ccgram/start.sh'], { cwd: deps.root });
      if (r.code !== 0) warnings.push('bridge: start.sh failed');
      else say(`bridge: ${r.stdout.trim().split('\n').pop() ?? 'ok'}`);
    }

    // Manager windows.
    if (cfg) {
      const csession = sessionName(cfg, env);
      if (!(await hasSession(deps.run, csession))) {
        const r = await deps.run('tmux', ['new-session', '-d', '-s', csession, '-c', deps.root]);
        if (r.code !== 0) warnings.push(`could not create tmux session ${csession}`);
      }
      for (const name of Object.keys(cfg.windows)) {
        try {
          const s = await startWindow(deps.run, cfg, env, name, deps.root);
          say(`window ${name}: ${s}`);
        } catch (e) {
          warnings.push(`window ${name}: ${(e as Error).message}`);
        }
      }
      try {
        say(`window manager: ${await ensureManagerWindow(deps.run, cfg, env, deps.root)}`);
      } catch (e) {
        warnings.push(`window manager: ${(e as Error).message}`);
      }
    }

    // Scheduler.
    const names = await windowNames(deps.run, session);
    const unit = await unitLoaded(deps.run);
    if (env.SCHEDULER_ENABLED === 'false') say('scheduler: skipped (SCHEDULER_ENABLED=false)');
    else if (unit) say(`scheduler: skipped (${unit} is loaded)`);
    else if (names.has('scheduler')) say('scheduler: already running');
    else {
      try {
        await startStackWindow(deps, session, 'scheduler', cleanEnvArgv(env, SCHEDULER_CMD));
        started.push('scheduler');
        say('scheduler: started');
      } catch (e) {
        warnings.push(`scheduler: ${(e as Error).message}`);
      }
    }

    // Dashboard.
    const url = webUrl(env);
    const names2 = await windowNames(deps.run, session);
    if (names2.has('web')) say('web: already running');
    else {
      try {
        await startStackWindow(deps, session, 'web', cleanEnvArgv(env, WEB_CMD));
        started.push('web');
        say('web: started');
        let up = false;
        for (let i = 0; i < PROBE_SECONDS && !up; i++) {
          up = await deps.probe(`${url}/api/auth/mode`);
          if (!up) await deps.sleep(1000);
        }
        if (!up) warnings.push(`web: no answer within ${PROBE_SECONDS}s; read it with: tmux attach -t ${session}`);
      } catch (e) {
        warnings.push(`web: ${(e as Error).message}`);
      }
    }
  } else if (kill.stopped) {
    say(`kill switch is ON (${kill.reason}); \`up\` would refuse`);
  }

  // Final table. Re-check the windows we just started: one that exited at once is not running.
  const stackNames = await windowNames(deps.run, session);
  if (!status) {
    for (const n of started) {
      if (!stackNames.has(n)) warnings.push(`window ${n} exited immediately`);
    }
  }
  const bridgeUp = await hasSession(deps.run, daemonSession);
  const unitNow = await unitLoaded(deps.run);
  const csess = cfg ? sessionName(cfg, env) : 'ccgram';
  const cNames = await windowNames(deps.run, csess);
  rows.push(['bridge', bridgeUp ? 'running' : 'not running', `tmux attach -t ${daemonSession}`]);
  for (const n of ['hunt', 'followups', 'manager']) {
    rows.push([n, cNames.has(n) ? 'running' : 'not running', `tmux attach -t ${csess}`]);
  }
  const sched = env.SCHEDULER_ENABLED === 'false' ? 'disabled' : unitNow ? 'unit loaded' : stackNames.has('scheduler') ? 'running' : 'not running';
  rows.push(['scheduler', sched, `tmux attach -t ${session}`]);
  let webState = stackNames.has('web') ? 'running' : 'not running';
  if (status && stackNames.has('web')) webState = (await deps.probe(`${webUrl(env)}/api/auth/mode`)) ? 'running' : 'window up, no answer';
  rows.push(['web', webState, `tmux attach -t ${session}`]);
  say('components:');
  for (const l of table(rows)) say(l);
  for (const w of warnings) say(`warning: ${w}`);
  say(`dashboard: ${webUrl(env)}`);
  say(`windows: tmux attach -t ${csess}   scheduler and web: tmux attach -t ${session}`);
  say(`ticks (run by the scheduler after a wake): auto-update ${env.AUTO_UPDATE === 'true' ? 'on' : 'off'}, backup ${env.BACKUP_ENABLED === 'true' ? 'on' : 'off'}`);
  say(lastVerify(deps));
  say('Stop: npm run down   Emergency: npm run jobber:control -- stop');
  return 0;
}

export async function runUp(deps: StackDeps, opts: { status: boolean }): Promise<number> {
  const env = mergedEnv(deps);
  const fileEnv = readFileEnv(deps);
  // The children run under `env -i` and read .env themselves: the banner shows what they will use.
  const modeView = currentMode(fileFlags(fileEnv));
  const warns = shellDivergence(fileEnv, deps.env);
  const killLine = `JOBBER_KILL=${env.JOBBER_KILL ?? '(unset)'}`;
  const banner = (): void => {
    for (const l of modeView.lines) deps.say(l);
    deps.say(`  ${killLine}`);
    for (const w of warns) deps.say(w);
  };
  banner();
  let code: number;
  try {
    code = await inner(deps, env, opts.status);
  } catch (e) {
    deps.say(`up failed: ${(e as Error).message}`);
    code = 1;
  }
  banner();
  return code;
}
