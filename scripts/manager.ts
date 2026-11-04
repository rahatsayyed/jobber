// scripts/manager.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  listManaged,
  loadManagerConfig,
  readWindow,
  restartWindowWithMemory,
  sessionName,
  startWindowWithMemory,
  stopWindow,
  SUBCOMMANDS,
  USAGE,
} from '../src/platform/manager.js';
import { clearWindow, sendToWindow } from '../src/platform/managerTyping.js';
import { addHandoff, listHandoff, resolveHandoff } from '../src/platform/handoff.js';
import { stopActive } from './killSwitch.js';
import { redactPane } from '../src/platform/redact.js';
import { assertName, defaultRun, JOBBER_TMUX_SESSION, listWindows } from '../src/platform/tmux.js';

const ROOT = resolve(import.meta.dirname, '..');

// Same output as `npx tsx scripts/status.ts health`; heavy modules load only for this subcommand.
async function status(): Promise<string> {
  try {
    const [{ default: Database }, { existsSync }, { dbPath }, { loadOutreachConfig }, snapMod, renderMod] = await Promise.all([
      import('better-sqlite3'),
      import('node:fs'),
      import('../src/dbPath.js'),
      import('../src/outreach/config.js'),
      import('../src/status/snapshot.js'),
      import('../src/status/render.js'),
    ]);
    const path = dbPath();
    if (path === ':memory:' || !existsSync(path)) return 'no database yet';
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const snap = snapMod.buildSnapshot(db, loadOutreachConfig(), new Date());
      // WEB_TMUX_SESSION on purpose: the output must match scripts/status.ts health.
      const session = process.env.WEB_TMUX_SESSION?.trim() || JOBBER_TMUX_SESSION;
      return renderMod.renderHealth(snap, await listWindows(defaultRun, session));
    } finally {
      db.close();
    }
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return 'status: install plan 7C-lite';
    return `status error: ${redactPane(e instanceof Error ? e.message.split('\n')[0] : String(e))}`;
  }
}

// Wraps the handoff file (src/platform/handoff.ts): the manager adds and resolves entries only through here.
function handoff(args: string[]): number {
  const [cmd, ...rest] = args;
  if (cmd === 'list') {
    const all = listHandoff(ROOT).filter((e) => rest[0] === undefined || e.window === rest[0]);
    if (all.length === 0) console.log('no pending handoff items');
    for (const e of all) console.log(`[${e.id}] ${e.window} | ${e.what} | ${e.why} | ${e.since}`);
    return 0;
  }
  if (cmd === 'add') {
    if (rest.length < 3) { console.error('usage: manager handoff add <window> <what> <why>'); return 2; }
    const r = addHandoff(ROOT, { window: rest[0], what: rest[1], why: rest.slice(2).join(' ') });
    if (!r.ok) { console.error(`not added: ${r.reason}`); return 1; }
    console.log(`${r.existing ? 'already pending' : 'added'}: ${r.entry.id}`);
    return 0;
  }
  if (cmd === 'resolve') {
    if (rest.length !== 1) { console.error('usage: manager handoff resolve <id>'); return 2; }
    if (!resolveHandoff(ROOT, rest[0])) { console.error('no such id'); return 1; }
    console.log('resolved');
    return 0;
  }
  console.error(USAGE);
  return 2;
}

async function main(): Promise<number> {
  const [sub, arg, extra] = process.argv.slice(2);
  if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    console.error(USAGE);
    return 2;
  }
  try {
    if (sub === 'status') {
      console.log(await status());
      return 0;
    }
    if (sub === 'handoff') {
      try {
        return handoff(process.argv.slice(3));
      } catch (e) {
        console.error(`refused: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
        return 1;
      }
    }
    if (sub !== 'list') {
      if (!arg) {
        console.error(USAGE);
        return 2;
      }
      assertName(arg);
    }
    let cfg: ReturnType<typeof loadManagerConfig>;
    try {
      cfg = loadManagerConfig(readFileSync(resolve(ROOT, 'config/manager-windows.json'), 'utf8'));
    } catch (e) {
      console.error(`config error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      return 1;
    }
    if (sub === 'list') {
      const wins = await listManaged(defaultRun, cfg, process.env);
      if (wins.length === 0) console.log(`no windows in session ${sessionName(cfg, process.env)}`);
      for (const w of wins) {
        const tags = [w.active ? 'active' : '', w.managed ? 'managed' : '', w.protected ? 'protected' : ''].filter(Boolean);
        console.log(`${w.name}\t${w.command}\t${tags.join(',')}`);
      }
    } else if (sub === 'read') {
      const lines = extra === undefined ? 40 : Number(extra);
      console.log(await readWindow(defaultRun, cfg, process.env, arg as string, lines));
    } else if (sub === 'start') {
      const r = await startWindowWithMemory(defaultRun, cfg, process.env, arg as string, ROOT);
      console.log(`${arg}: ${r.state}${r.startup === 'skipped' ? '' : `, startup line ${r.startup}`}`);
    } else if (sub === 'stop') {
      console.log(`${arg}: ${await stopWindow(defaultRun, cfg, process.env, arg as string)}`);
    } else if (sub === 'send') {
      const text = process.argv.slice(4).join(' ');
      console.log(await sendToWindow(defaultRun, cfg, process.env, arg as string, text, { root: ROOT, killed: () => stopActive(ROOT, process.env).stopped }));
    } else if (sub === 'clear') {
      console.log(await clearWindow(defaultRun, cfg, process.env, arg as string, { root: ROOT, killed: () => stopActive(ROOT, process.env).stopped }));
    } else {
      const r = await restartWindowWithMemory(defaultRun, cfg, process.env, arg as string, ROOT);
      console.log(`${arg}: ${r.state}${r.startup === 'skipped' ? '' : `, startup line ${r.startup}`}`);
    }
    return 0;
  } catch (e) {
    console.error(`refused: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return 1;
  }
}

main().then((c) => process.exit(c));
