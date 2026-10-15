// scripts/status.ts
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dbPath } from '../src/dbPath.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { renderSummary, summarize } from '../src/layout/summary.js';
import { buildSnapshot } from '../src/status/snapshot.js';
import { renderHealth, renderLimits, renderWorking } from '../src/status/render.js';
import { defaultRun, listWindows } from '../src/platform/tmux.js';

const USAGE = 'usage: npm run status -- <limits|working|health|json|layout>';
const cmd = process.argv[2];

// Read-only layout memory summary (plan 8B). Works without a database; halts are read when one exists.
function layoutStatus(): number {
  const cfg = loadLayoutConfig();
  const p = dbPath();
  let db: Database.Database | undefined;
  try {
    if (p !== ':memory:' && existsSync(p)) db = new Database(p, { readonly: true, fileMustExist: true });
    for (const platform of ['linkedin', 'naukri'] as const) console.log(renderSummary(summarize(platform, cfg, new Date(), db)));
    return 0;
  } catch (e) {
    console.log(`status error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return 1;
  } finally {
    db?.close();
  }
}

async function main(): Promise<number> {
  if (!cmd || !['limits', 'working', 'health', 'json', 'layout'].includes(cmd)) {
    console.error(USAGE);
    return 2;
  }
  if (cmd === 'layout') return layoutStatus();
  const path = dbPath();
  if (path === ':memory:' || !existsSync(path)) {
    console.log('no database yet');
    return 0;
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const snap = buildSnapshot(db, loadOutreachConfig(), new Date());
    if (cmd === 'limits') console.log(renderLimits(snap));
    else if (cmd === 'working') console.log(renderWorking(snap));
    else if (cmd === 'json') console.log(JSON.stringify(snap, null, 2));
    else {
      const session = process.env.WEB_TMUX_SESSION?.trim() || 'ccgram';
      const windows = await listWindows(defaultRun, session);
      console.log(renderHealth(snap, windows));
    }
    return 0;
  } catch (e) {
    console.log(`status error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return 1;
  } finally {
    db?.close();
  }
}

main().then((c) => process.exit(c));
