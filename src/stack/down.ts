// src/stack/down.ts
// `down`: stops what `up` started, in order: dashboard, scheduler (graceful), the worker windows, bridge, then manager and chat, and ends
// the tmux session when nothing is left. No questions are asked:
// the owner typed it on purpose. A worker window that is mid-item gets a clean stop (Escape, then exit) and its unfinished item is
// written to .jobber/handoff.md, like a manager handoff. `--keep-windows` stops only the daemons.
// `--keep-protected` leaves manager and chat running (the old behaviour). It never touches the kill switch, halts, .env, secrets or the
// database, and never stops a scheduler that belongs to a launchd or systemd unit.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addHandoff } from '../platform/handoff.js';
import { loadManagerConfig, sessionName, stopWindow, type ManagerConfig } from '../platform/manager.js';
import { assertClaudePane, hasSession, listWindows, sendText } from '../platform/tmux.js';
import { peekLock } from '../platform/lock.js';
import { windowLockHeld, windowLockName, WINDOW_LOCK_TTL_MS } from '../platform/windowLock.js';
import { DEFAULT_LABEL, SERVICE_NAME } from '../scheduler/units.js';
import { mergedEnv, stackSession, unitLoaded, windowNames, type StackDeps } from './up.js';

export interface DownDeps extends StackDeps {
  isTTY?: boolean;
  /** Kept for old callers; `down` never asks any more. */
  ask?(question: string): Promise<boolean>;
}

export interface DownOpts {
  keepBridge: boolean;
  /** Stop only the daemons (web, scheduler, bridge); leave the worker windows running. */
  keepWindows?: boolean;
  /** Leave the protected `manager` and `chat` windows running (the default stops them too). */
  keepProtected?: boolean;
  force: boolean;
  /** Ignored: kept so `--yes` still parses. */
  yes?: boolean;
  /** Print every component line, not just problems and the one summary line. */
  verbose?: boolean;
}

/** The newest work file of a window, which names the item it was working on. */
function latestWorkItem(root: string, window: string): string | null {
  const prefix = `w-${window.slice(0, 12)}-`;
  const dir = join(root, '.jobber', 'work');
  try {
    const files = readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.md'));
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    return files.length > 0 ? files[0].replace(/\.md$/, '') : null;
  } catch {
    return null;
  }
}

/**
 * Stops one worker window. Idle: killed at once. Mid-item (dispatcher lock held): Escape, then `/exit`, wait a few seconds,
 * kill only if it is still there, and write the unfinished item to the handoff file. Returns a short result text.
 */
export async function stopWorkerClean(deps: DownDeps, cfg: ManagerConfig, env: NodeJS.ProcessEnv, name: string): Promise<string> {
  const session = sessionName(cfg, env);
  if (!windowLockHeld(deps.root, name)) return await stopWindow(deps.run, cfg, env, name);
  const owner = peekLock(join(deps.root, '.jobber'), windowLockName(name), undefined, { ttlMs: WINDOW_LOCK_TTL_MS })?.owner ?? 'dispatch';
  const item = latestWorkItem(deps.root, name);
  try {
    addHandoff(deps.root, {
      window: name,
      what: `unfinished item${item ? ` ${item}` : ''} (lock ${owner}) when npm run down stopped the window`,
      why: 'stopped by npm run down while it was mid-item; the plan is DB-driven so the work is due again at the next wake',
    }, deps.now());
  } catch { /* the handoff note is best effort: the stop must still happen */ }
  const target = `=${session}:=${name}`;
  try {
    await deps.run('tmux', ['send-keys', '-t', target, 'Escape']);
    await deps.sleep(1000);
    await assertClaudePane(deps.run, session, name);
    await sendText(deps.run, session, name, '/exit');
    for (let i = 0; i < 5; i++) {
      await deps.sleep(1000);
      if (!(await windowNames(deps.run, session)).has(name)) return 'stopped (clean, unfinished item noted in handoff)';
    }
  } catch { /* not a claude pane or tmux hiccup: fall through to the kill */ }
  return `${await stopWindow(deps.run, cfg, env, name)} (killed after a clean stop did not finish, unfinished item noted in handoff)`;
}

export function waitSeconds(env: NodeJS.ProcessEnv): number {
  const raw = (env.STACK_DOWN_WAIT_SEC ?? '').trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) return 60;
  return Math.min(600, Math.max(5, Math.floor(n)));
}

export async function runDown(deps: DownDeps, opts: DownOpts): Promise<number> {
  const env = mergedEnv(deps);
  const session = stackSession(env);
  let code = 0;
  // Routine lines show only with --verbose; problems and the one summary line always show.
  const say = (l: string): void => { if (opts.verbose) deps.say(l); };
  const alert = (l: string): void => deps.say(l);
  const problems: string[] = [];

  let cfg;
  try {
    cfg = loadManagerConfig(deps.fs.read(join(deps.root, 'config', 'manager-windows.json')));
  } catch (e) {
    alert(`warning: manager config unreadable: ${(e as Error).message}`);
  }
  const csession = cfg ? sessionName(cfg, env) : session;
  const sessions = [...new Set([session, csession])];
  const snapshot = async (): Promise<Set<string>> => {
    const out = new Set<string>();
    for (const s of sessions) for (const n of await windowNames(deps.run, s)) out.add(n);
    return out;
  };
  // What is stopped is read from tmux (present before, gone after), so the summary names every component that really went away.
  const before = await snapshot();

  // 1. Dashboard.
  let names = await windowNames(deps.run, session);
  if (names.has('web')) {
    const r = await deps.run('tmux', ['kill-window', '-t', `=${session}:=web`]);
    say(r.code === 0 ? 'web: stopped' : 'web: stop failed');
    if (r.code !== 0) { code = 1; problems.push('web: stop failed'); }
  } else say('web: absent');

  // 2. Scheduler: Ctrl-C lets the daemon finish its wake; never killed without --force.
  const unit = await unitLoaded(deps.run);
  names = await windowNames(deps.run, session);
  if (unit) {
    alert(`scheduler: belongs to a ${unit}; not stopped here`);
    alert(
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
    if (present) alert('scheduler is finishing a wake; run npm run down again, or npm run down -- --force');
    else say('scheduler: stopped');
  }

  // 3. worker windows from the config: no questions. A window mid-item gets a clean stop and a handoff note.
  if (cfg && opts.keepWindows) {
    say('windows: kept (--keep-windows)');
  } else if (cfg) {
    const present = await windowNames(deps.run, sessionName(cfg, env));
    // Reverse of the order `up` starts them in.
    for (const name of Object.keys(cfg.windows).reverse()) {
      if (!present.has(name)) {
        say(`${name}: absent`);
        continue;
      }
      try {
        const r = await stopWorkerClean(deps, cfg, env, name);
        say(`${name}: ${r}`);
        if (/handoff/.test(r)) alert(`${name}: was mid-item, stopped cleanly; the unfinished item is in .jobber/handoff.md`);
      } catch (e) {
        alert(`${name}: ${(e as Error).message}`);
        problems.push(`${name}: stop failed`);
        code = 1;
      }
    }
  }

  // 4. Bridge.
  const bridgeNames = await windowNames(deps.run, session);
  if (opts.keepBridge) say('bridge: kept (--keep-bridge)');
  else if (!bridgeNames.has('bridge')) say('bridge: absent');
  else {
    const r = await deps.run('tmux', ['kill-window', '-t', `=${session}:=bridge`]);
    say(r.code === 0 ? 'bridge: stopped' : 'bridge: stop failed');
    if (r.code !== 0) { code = 1; problems.push('bridge: stop failed'); }
  }
  // 5. manager and chat (protected: stopWindow refuses them, so they are killed directly). Kept with --keep-protected or --keep-windows.
  for (const name of ['chat', 'manager']) {
    if (!(await windowNames(deps.run, csession)).has(name)) continue;
    if (opts.keepProtected || opts.keepWindows) {
      say(`${name}: kept (${opts.keepProtected ? '--keep-protected' : '--keep-windows'})`);
      continue;
    }
    const r = await deps.run('tmux', ['kill-window', '-t', `=${csession}:=${name}`]);
    say(r.code === 0 ? `${name}: stopped` : `${name}: stop failed`);
    if (r.code !== 0) { code = 1; problems.push(`${name}: stop failed`); }
  }

  // 6. End the tmux session(s) when nothing is left (tmux itself drops a session with its last window; this covers a leftover shell).
  for (const s of sessions) {
    try {
      if ((await hasSession(deps.run, s)) && (await listWindows(deps.run, s)).length === 0) await deps.run('tmux', ['kill-session', '-t', `=${s}`]);
    } catch { /* the session is gone already */ }
  }

  for (const p of problems) alert(p);
  const after = await snapshot();
  // Listed in the order they are stopped in (daemons, workers, bridge, chat, manager); unknown windows last.
  const order = ['web', 'scheduler', ...Object.keys(cfg?.windows ?? {}).reverse(), 'bridge', 'chat', 'manager'];
  const rank = (n: string): number => (order.includes(n) ? order.indexOf(n) : order.length);
  const byRank = (a: string, b: string): number => rank(a) - rank(b);
  const stopped = [...before].filter((n) => !after.has(n)).sort(byRank);
  const left = [...before].filter((n) => after.has(n)).sort(byRank);
  const leftText = left.length > 0 ? ` Left running: ${left.join(', ')}.` : '';
  alert(stopped.length > 0 ? `Jobber stopped: ${stopped.join(', ')}.${leftText}` : `Jobber: nothing was stopped.${leftText || ' Nothing was running.'}`);
  return code;
}
