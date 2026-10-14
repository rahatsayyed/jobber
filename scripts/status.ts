// scripts/status.ts
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dbPath } from '../src/dbPath.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { buildSnapshot } from '../src/status/snapshot.js';
import { renderHealth, renderLimits, renderWorking } from '../src/status/render.js';
import { defaultRun, listWindows } from '../src/platform/tmux.js';

const USAGE = 'usage: npm run status -- <limits|working|health|json>';
const cmd = process.argv[2];

async function main(): Promise<number> {
  if (!cmd || !['limits', 'working', 'health', 'json'].includes(cmd)) {
    console.error(USAGE);
    return 2;
  }
  const path = dbPath();
  if (path !== ':memory:' && !existsSync(path)) {
    console.log('no database yet');
    return 0;
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
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
    db.close();
  }
}

main().then((c) => process.exit(c));
