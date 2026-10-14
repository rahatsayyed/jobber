// scripts/manager.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  listManaged,
  loadManagerConfig,
  readWindow,
  restartWindow,
  sessionName,
  startWindow,
  stopWindow,
  SUBCOMMANDS,
  USAGE,
} from '../src/platform/manager.js';
import { redactPane } from '../src/platform/redact.js';
import { assertName, defaultRun, listWindows } from '../src/platform/tmux.js';

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
      const session = process.env.WEB_TMUX_SESSION?.trim() || 'ccgram';
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
      console.log(`${arg}: ${await startWindow(defaultRun, cfg, process.env, arg as string, ROOT)}`);
    } else if (sub === 'stop') {
      console.log(`${arg}: ${await stopWindow(defaultRun, cfg, process.env, arg as string)}`);
    } else {
      console.log(`${arg}: ${await restartWindow(defaultRun, cfg, process.env, arg as string, ROOT)}`);
    }
    return 0;
  } catch (e) {
    console.error(`refused: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return 1;
  }
}

main().then((c) => process.exit(c));
