// scripts/status.ts
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { dbPath } from '../src/dbPath.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { parseEnv } from '../src/platform/envFile.js';
import { loadLayoutConfig, loadLayoutEnv } from '../src/layout/config.js';
import { renderSummary, summarize } from '../src/layout/summary.js';
import { buildSnapshot } from '../src/status/snapshot.js';
import { renderHealth, renderLimits, renderWorking } from '../src/status/render.js';
import { buildSourceRows, DEFAULT_WINDOW_HOURS, renderSources } from '../src/status/sources.js';
import { listEscalations } from '../src/outreach/escalations.js';
import { renderEscalations } from '../src/status/escalations.js';
import { renderRunToolCounts, summarizeRunLog } from '../src/status/runs.js';
import { defaultRun, listWindows } from '../src/platform/tmux.js';

const USAGE = 'usage: npm run status -- <limits|working|health|json|layout|sources|runs|escalations>';
const cmd = process.argv[2];

// Read-only layout memory summary (plan 8B). Works without a database; halts are read when one exists.
function layoutStatus(): number {
  const cfg = loadLayoutConfig(loadLayoutEnv());
  const p = dbPath();
  let db: Database.Database | undefined;
  try {
    if (p !== ':memory:' && existsSync(p)) db = new Database(p, { readonly: true, fileMustExist: true });
    for (const platform of ['linkedin', 'naukri', 'wellfound'] as const) console.log(renderSummary(summarize(platform, cfg, new Date(), db)));
    return 0;
  } catch (e) {
    console.log(`status error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return 1;
  } finally {
    db?.close();
  }
}

async function main(): Promise<number> {
  if (!cmd || !['limits', 'working', 'health', 'json', 'layout', 'sources', 'runs', 'escalations'].includes(cmd)) {
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
    if (cmd === 'runs') {
      const row = db.prepare('SELECT id, log_path, status, stop_reason, parent_run_id FROM scheduler_runs ORDER BY planned_at DESC, rowid DESC LIMIT 1').get() as
        | { id: string; log_path: string | null; status: string; stop_reason: string | null; parent_run_id: string | null } | undefined;
      if (!row) console.log('no runs yet');
      else {
        // An `incomplete` run exited 0 with its wake unfinished; the reason names the unproven steps.
        console.log(`status: ${row.status}${row.stop_reason ? ` (${row.stop_reason.replace(/\s+/g, ' ').slice(0, 300)})` : ''}${row.parent_run_id ? `, continues ${row.parent_run_id}` : ''}`);
        if (!row.log_path || !existsSync(row.log_path)) console.log(`run ${row.id}: no log file recorded`);
        else console.log(renderRunToolCounts(row.id, summarizeRunLog(readFileSync(row.log_path, 'utf8'))));
      }
      return 0;
    }
    if (cmd === 'escalations') {
      const now = new Date();
      const r = listEscalations(db, { now });
      console.log(renderEscalations(r.items, r.counts, now));
      return 0;
    }
    if (cmd === 'sources') {
      const since = new Date(Date.now() - DEFAULT_WINDOW_HOURS * 3600_000).toISOString();
      console.log(renderSources(buildSourceRows(db, since), `ran in last ${DEFAULT_WINDOW_HOURS}h (since ${since})`));
      return 0;
    }
    // The limits shown are the ones a run uses: .env fills what the process env lacks (the launcher does the same).
    const dotenv = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
    const snap = buildSnapshot(db, loadOutreachConfig({ ...dotenv, ...process.env }), new Date());
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
