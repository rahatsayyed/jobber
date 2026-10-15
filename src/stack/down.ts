// src/stack/down.ts
// `down`: stops what `up` started, in order: dashboard, scheduler (graceful), hunt and followups, bridge.
// It never touches `manager`, the kill switch, halts, .env, secrets or the database, and never stops a
// scheduler that belongs to a launchd or systemd unit.
import { join } from 'node:path';
import { loadManagerConfig, sessionName, stopWindow } from '../platform/manager.js';
import { assertName, hasSession } from '../platform/tmux.js';
import { DEFAULT_LABEL, SERVICE_NAME } from '../scheduler/units.js';
import { mergedEnv, stackSession, unitLoaded, windowNames, type StackDeps } from './up.js';

export interface DownDeps extends StackDeps {
  isTTY: boolean;
  ask(question: string): Promise<boolean>;
}

export interface DownOpts {
  keepBridge: boolean;
  force: boolean;
  yes: boolean;
}

export function waitSeconds(env: NodeJS.ProcessEnv): number {
  const raw = (env.STACK_DOWN_WAIT_SEC ?? '').trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) return 60;
  return Math.min(600, Math.max(5, Math.floor(n)));
}

export async function runDown(deps: DownDeps, opts: DownOpts): Promise<number> {
  const say = deps.say;
  const env = mergedEnv(deps);
  const session = stackSession(env);
  const daemon = (env.CCGRAM_DAEMON_SESSION ?? '').trim() || 'ccgram-daemon';
  assertName(daemon);
  let code = 0;

  // 1. Dashboard.
  let names = await windowNames(deps.run, session);
  if (names.has('web')) {
    const r = await deps.run('tmux', ['kill-window', '-t', `=${session}:=web`]);
    say(r.code === 0 ? 'web: stopped' : 'web: stop failed');
    if (r.code !== 0) code = 1;
  } else say('web: absent');

  // 2. Scheduler: Ctrl-C lets the daemon finish its wake; never killed without --force.
  const unit = await unitLoaded(deps.run);
  names = await windowNames(deps.run, session);
  if (unit) {
    say(`scheduler: belongs to a ${unit}; not stopped here`);
    say(
      unit.startsWith('launchd')
        ? `  unload it yourself: launchctl unload ~/Library/LaunchAgents/${DEFAULT_LABEL}.plist (npm run scheduler:units prints the install commands)`
        : `  stop it yourself: systemctl --user disable --now ${SERVICE_NAME} (npm run scheduler:units prints the install commands)`,
    );
  } else if (!names.has('scheduler')) {
    say('scheduler: absent');
  } else if (opts.force) {
    await deps.run('tmux', ['kill-window', '-t', `=${session}:=scheduler`]);
    say('scheduler: killed (--force)');
  } else {
    await deps.run('tmux', ['send-keys', '-t', `=${session}:=scheduler`, 'C-c']);
    const limit = waitSeconds(env);
    let present = true;
    for (let i = 0; i < limit && present; i++) {
      present = (await windowNames(deps.run, session)).has('scheduler');
      if (present) await deps.sleep(1000);
    }
    if (present) say('scheduler is finishing a wake; run npm run down again, or npm run down -- --force');
    else say('scheduler: stopped');
  }

  // 3. hunt and followups (may hold interactive work): confirmation required.
  let cfg;
  try {
    cfg = loadManagerConfig(deps.fs.read(join(deps.root, 'config', 'manager-windows.json')));
  } catch (e) {
    say(`warning: manager config unreadable: ${(e as Error).message}`);
  }
  if (cfg) {
    const present = await windowNames(deps.run, sessionName(cfg, env));
    for (const name of ['hunt', 'followups']) {
      if (!present.has(name)) {
        say(`${name}: absent`);
        continue;
      }
      let ok = opts.yes;
      if (!ok && deps.isTTY) ok = await deps.ask(`stop window ${name}? it may hold interactive work [y/N] `);
      if (!ok) {
        say(`${name}: left running (${deps.isTTY ? 'not confirmed' : 'not a terminal; pass --yes to stop it'})`);
        continue;
      }
      try {
        say(`${name}: ${await stopWindow(deps.run, cfg, env, name)}`);
      } catch (e) {
        say(`${name}: ${(e as Error).message}`);
        code = 1;
      }
    }
    if (present.has('manager')) say('manager: left running (protected)');
  }

  // 4. Bridge.
  if (opts.keepBridge) say('bridge: kept (--keep-bridge)');
  else if (!(await hasSession(deps.run, daemon))) say('bridge: absent');
  else {
    const r = await deps.run('bash', ['scripts/ccgram/stop.sh'], { cwd: deps.root });
    say(r.code === 0 ? 'bridge: stopped' : 'bridge: stop failed');
    if (r.code !== 0) code = 1;
  }
  return code;
}
